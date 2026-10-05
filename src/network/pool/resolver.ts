/**
 * `PoolAgentResolver` — builds, caches, and reaps the per-pool egress agents
 * on demand — and `ValidatedNetworkBindingFactory`, which resolves upstream
 * names once through the SSRF policy and hands dispatch a validated fetch
 * (direct or pool-bound).
 */
import type { CartethyiaDatabase } from "../../persistence/postgres";
import {
  isAddressAllowed,
  resolveAllAddresses,
  resolveAndValidateOnce,
  type ValidatedDestination,
} from "../ssrf";
import { createValidatedFetch, type ValidatedFetch } from "../outbound-fetch";
import { GatewayError } from "../../transport/gateway-error";
import type { SsrfPolicy } from "../../config";
import { log } from "../../observability/logger";
import type { TransportKind, PoolAgent } from "./agent";
import { isIP } from "node:net";
import * as tls from "node:tls";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { isProxyAgentPair, createHttpProxyAgent, createSocks5Agent, createBridgeAgent, normalizeBridgeEndpoint, PoolBindingError } from "./agent";
import { Agent as HttpsAgent } from "node:https";
import { parseAgentConfig, ProxyConfigError, type AgentConfig } from "../types";
import type { ProviderWebSocketSession, ValidatedOutboundWebSocket } from "../../providers/provider-registry";

/** Idle time after which an unused pool agent is destroyed. */
const POOL_AGENT_IDLE_MS = 10 * 60_000;
/** Maximum number of concurrent pool agents to prevent unbounded growth. */
const MAX_POOL_AGENTS = 1000;

export interface PoolAgentResolverDeps {
  readonly ssrfPolicy?: SsrfPolicy;
  readonly resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  /** Database used to load pool rows. */
  readonly db?: CartethyiaDatabase;
}

function destroyAgent(agent: unknown): void {
  if (isProxyAgentPair(agent)) {
    destroyAgent(agent.http);
    destroyAgent(agent.https);
    return;
  }
  const maybeDestroy = (agent as { destroy?: unknown }).destroy;
  if (typeof maybeDestroy === "function") {
    try {
      (maybeDestroy as () => void).call(agent);
      return;
    } catch (error) {
      // Destroy failure means sockets may outlive the agent — surface it
      // instead of silently leaking the pool's connections.
      log.warn("[pool-agent] destroy failed", error);
    }
  }
  const maybeClose = (agent as { close?: unknown }).close;
  if (typeof maybeClose === "function") {
    try {
      (maybeClose as () => void).call(agent);
    } catch (error) {
      log.warn("[pool-agent] close failed", error);
    }
  }
}

async function validateDialHost(
  hostname: string,
  policy: SsrfPolicy,
  resolveFn: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>,
): Promise<void> {
  if (isIP(hostname) !== 0) {
    if (!isAddressAllowed(hostname, policy))
      throw new PoolBindingError(`pool endpoint resolves to disallowed address: ${hostname}`);
    return;
  }
  const addresses = await resolveFn(hostname, AbortSignal.timeout(5000));
  for (const address of addresses) {
    if (!isAddressAllowed(address, policy))
      throw new PoolBindingError(`pool endpoint resolves to disallowed address: ${address}`);
  }
}

function endpointHostname(kind: TransportKind, endpoint: string): string | undefined {
  try {
    if (kind === "http" || kind === "https") {
      const url = new URL(endpoint);
      return url.hostname || undefined;
    }
    if (kind === "socks5") {
      const authority = endpoint.includes("://") ? endpoint : `socks5://${endpoint}`;
      const url = new URL(authority);
      return url.hostname || undefined;
    }
    if (kind === "bridge") {
      // A bridge endpoint may be written bare (`relay.example.com`) or with the
      // explicit `bridge://` marker; `normalizeBridgeEndpoint` folds both to the
      // http(s) URL the pool dials, so this reads the same host the agent will.
      const url = new URL(normalizeBridgeEndpoint(endpoint));
      return url.hostname || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}


export interface NetworkPoolRow {
  readonly id: string;
  readonly kind: TransportKind;
  readonly endpoint: string;
  readonly tenantId: string;
  readonly credential?: string;
  readonly config?: Record<string, unknown>;
}

export interface NetworkPoolLoader {
  load(poolId: string): Promise<NetworkPoolRow | undefined>;
}

/**
 * Per-pool egress agent cache.
 *
 * Lifecycle: `resolveAgent` single-flights agent construction per
 * `tenantId:poolId` by caching the build *promise* — concurrent requests over
 * the same pool share one build, and a failed build evicts itself so the next
 * caller retries. Each agent holds persistent sockets (`keepAlive: true`) and
 * carries the SSRF policy so every connect re-validates the proxy host.
 *
 * Reaping: entries idle beyond `POOL_AGENT_IDLE_MS` (10 min) are destroyed on
 * the next resolve — bounded memory for pools deleted or disabled outside the
 * mutation path, while hot entries are never destroyed mid-request. Also enforces
 * a hard cardinality ceiling (MAX_POOL_AGENTS) by evicting the least-recently-used
 * entries when the cache exceeds the cap.
 * `releasePool` tears down eagerly when a pool is mutated; `closeAll` drains
 * the cache at shutdown.
 *
 * Concurrency is deliberately *not* managed here: slot limits are owned by
 * `NetworkPoolSelector` (local counters + Redis `proxy:inflight:*`), so
 * agents stay pure connection factories.
 */
export class PoolAgentResolver {
  private readonly agents = new Map<string, Promise<PoolAgent>>();
  private readonly lastUsed = new Map<string, number>();
  private readonly ssrfPolicy: SsrfPolicy;
  private readonly resolveFn: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;

  constructor(
    private readonly loader: NetworkPoolLoader,
    deps?: PoolAgentResolverDeps,
  ) {
    this.ssrfPolicy = deps?.ssrfPolicy ?? {};
    const injectedResolve = deps?.resolveFn;
    this.resolveFn =
      injectedResolve ?? ((hostname, signal) => resolveAllAddresses(hostname, signal));
  }

  async resolveAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    const cacheKey = `${tenantId}:${poolId}`;
    this.lastUsed.set(cacheKey, Date.now());
    this.evictIdleAgents();
    const existing = this.agents.get(cacheKey);
    if (existing) return existing;
    const built = this.buildAgent(poolId, tenantId).catch((err: unknown) => {
      this.agents.delete(cacheKey);
      this.lastUsed.delete(cacheKey);
      throw err;
    });
    this.agents.set(cacheKey, built);
    return built;
  }

  /**
   * Bounds the agent cache: entries idle beyond POOL_AGENT_IDLE_MS are
   * destroyed, so pools deleted or disabled outside the mutation path cannot
   * retain agents and sockets for the process lifetime. Hot entries are never
   * evicted — destroying an agent an active request is dialing through would
   * break that request.
   *
   * Also enforces a hard cardinality ceiling (MAX_POOL_AGENTS) by evicting
   * the least-recently-used entries when the cache exceeds the cap.
   */
  private evictIdleAgents(): void {
    const cutoff = Date.now() - POOL_AGENT_IDLE_MS;
    for (const [key, usedAt] of this.lastUsed) {
      if (usedAt >= cutoff) continue;
      this.lastUsed.delete(key);
      const pending = this.agents.get(key);
      this.agents.delete(key);
      if (pending) {
        void pending
          .then((agent) => destroyAgent(agent))
          .catch(() => undefined);
      }
    }
    // Evict oldest entries if over the cardinality ceiling
    if (this.agents.size > MAX_POOL_AGENTS) {
      const entries = Array.from(this.lastUsed.entries()).sort((a, b) => a[1] - b[1]);
      const toEvict = entries.slice(0, this.agents.size - MAX_POOL_AGENTS);
      for (const [key] of toEvict) {
        this.lastUsed.delete(key);
        const pending = this.agents.get(key);
        this.agents.delete(key);
        if (pending) {
          void pending
            .then((agent) => destroyAgent(agent))
            .catch(() => undefined);
        }
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const pending of this.agents.values()) {
      try {
        const agent = await pending;
        destroyAgent(agent);
      } catch {
        // Rejected builds already removed
      }
    }
    this.agents.clear();
    this.lastUsed.clear();

  }

  /** Observable cache size for the runtime metrics sampler. */
  agentCount(): number {
    return this.agents.size;
  }

  async releasePool(poolId: string, tenantId: string): Promise<void> {
    const cacheKey = `${tenantId}:${poolId}`;
    const pending = this.agents.get(cacheKey);
    this.agents.delete(cacheKey);
    this.lastUsed.delete(cacheKey);
    if (pending) {
      try {
        destroyAgent(await pending);
      } catch {
        // Build failed — nothing to destroy.
      }
    }
  }
  async resolveWebSocketAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    return this.resolveAgent(poolId, tenantId);
  }

  private async buildAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    const row = await this.loader.load(poolId);
    if (!row) throw new PoolBindingError(`network pool ${poolId} not found`);
    if (row.tenantId !== tenantId)
      throw new PoolBindingError(`network pool ${poolId} is not available to this tenant`);

    const agentConfig = this.resolveAgentConfig(row);
    switch (row.kind) {
      case "http":
      case "https":
      case "socks5":
      case "bridge": {
        const hostname = endpointHostname(row.kind, row.endpoint);
        if (hostname) await validateDialHost(hostname, this.ssrfPolicy, this.resolveFn);
        // The policy is handed to the agent too: both flavors re-resolve and
        // re-validate the proxy host on every connect, so the create-time
        // check cannot be bypassed by a DNS rebind of the proxy record.
        // The pool id rides along so the tunnel's bytes are attributed to the
        // pool that carried them.
        if (row.kind === "socks5")
          return createSocks5Agent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig, poolId);
        if (row.kind === "bridge")
          return createBridgeAgent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig, poolId);
        return createHttpProxyAgent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig, poolId);
      }
      default:
        // Compile-time exhaustiveness: new TransportKind variants must add a case.
        row.kind satisfies never;
        throw new PoolBindingError(`unsupported network pool kind: ${String(row.kind)}`);
    }
  }

  private resolveAgentConfig(row: NetworkPoolRow): AgentConfig {
    try {
      return parseAgentConfig(row.config ?? {});
    } catch (error) {
      if (error instanceof ProxyConfigError)
        throw new PoolBindingError(`invalid pool agent config: ${error.message}`);
      throw error;
    }
  }


}
/** Resolves upstream names and supplies the enforced outbound fetch capability. */
function connectValidatedWebSocket(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  destination: ValidatedDestination,
  agent?: PoolAgent,
): Promise<ProviderWebSocketSession> {
  const targetUrl = new URL(url.toString());
  targetUrl.protocol = "wss:";
  targetUrl.port = "";
  targetUrl.hash = "";
  const connectionOptions: ClientOptions = {
    handshakeTimeout: 15_000,
    perMessageDeflate: false,
    followRedirects: false,
    headers: { ...headers },
    ...(agent === undefined ? {} : { agent: agentForWebSocket(agent) }),
    ...(agent === undefined
      ? {
          createConnection: () => {
            const socket = tls.connect({
              host: destination.resolvedAddress,
              port: 443,
              servername: destination.hostname,
              rejectUnauthorized: true,
              ALPNProtocols: ["http/1.1"],
            });
            const onAbort = (): void => {
              socket.destroy(new Error("connection aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            socket.once("secureConnect", () => signal.removeEventListener("abort", onAbort));
            return socket;
          },
        }
      : {}),
  };
  return new Promise<ProviderWebSocketSession>((resolve, reject) => {
    const socket = new WebSocket(targetUrl, connectionOptions);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new GatewayError("transport_unavailable", 502, "WebSocket handshake timed out"));
    }, 15_000);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      reject(new GatewayError("transport_closed", 499, "WebSocket connection was cancelled"));
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new GatewayError("transport_unavailable", 502, "WebSocket connection failed"));
    };
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(new WsSession(socket, signal));
    });
    socket.once("error", onError);
    socket.once("unexpected-response", onError);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}


function agentForWebSocket(agent: PoolAgent): import("http").Agent | import("https").Agent {
  if (isProxyAgentPair(agent)) return agent.https;
  if (agent instanceof HttpsAgent) return agent;
  throw new GatewayError("proxy_pool_unhealthy", 503, "configured WebSocket proxy pool does not support WSS");
}

class WsSession implements ProviderWebSocketSession {
  readonly #socket: WebSocket;
  readonly #signal: AbortSignal;
  readonly #messages: string[] = [];
  readonly #waiters: Array<{
    resolve(value: string): void;
    reject(reason: Error): void;
    cleanup(): void;
  }> = [];
  #closed: Error | undefined;

  constructor(socket: WebSocket, signal: AbortSignal) {
    this.#socket = socket;
    this.#signal = signal;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.#fail(new GatewayError("transport_unavailable", 502, "unexpected binary WebSocket frame"));
        return;
      }
      const message = data.toString();
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter.cleanup();
        waiter.resolve(message);
      } else {
        this.#messages.push(message);
      }
    });
    socket.on("close", () => this.#fail(new GatewayError("transport_closed", 502, "WebSocket connection closed")));
    socket.on("error", () => this.#fail(new GatewayError("transport_unavailable", 502, "WebSocket connection failed")));
  }

  send(message: string): void {
    if (this.#closed) throw this.#closed;
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new GatewayError("transport_closed", 499, "WebSocket connection is not open");
    }
    this.#socket.send(message, { binary: false });
  }

  receive(signal: AbortSignal): Promise<string> {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.reject(this.#closed);
    const combined = AbortSignal.any([this.#signal, signal]);
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new GatewayError("transport_unavailable", 504, "WebSocket receive timed out"));
      }, 45_000);
      const onAbort = (): void => {
        cleanup();
        reject(new GatewayError("transport_closed", 499, "WebSocket receive was cancelled"));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        combined.removeEventListener("abort", onAbort);
      };
      combined.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push({ resolve, reject, cleanup });
      if (combined.aborted) onAbort();
    });
  }

  close(code?: number, reason?: string): void {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    this.#socket.close(code, reason);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }
}
export class ValidatedNetworkBindingFactory {
  private readonly directFetch: ValidatedFetch;

  constructor(
    private readonly policy: SsrfPolicy = {},
    fetchFn?: typeof fetch,
    private readonly poolResolver?: PoolAgentResolver,
  ) {
    this.directFetch = createValidatedFetch({ policy, ...(fetchFn ? { fetchFn } : {}) });
  }

  /**
   * One-shot DNS resolution + SSRF validation for direct egress targets:
   * every resolved address (all families, not just the first answer) must
   * pass the SSRF policy, and the validated destination pins the address so
   * the subsequent socket cannot be re-pointed at a private/link-local host
   * by a DNS rebind between check and connect.
   */
  resolve(hostname: string, signal: AbortSignal, port = 443): Promise<ValidatedDestination> {
    return resolveAndValidateOnce(hostname, this.policy, signal, port);
  }

  /**
   * Without `networkPoolId` (or when no pool resolver is configured), dispatch
   * through validated direct egress. With one, route through that pool's
   * validated agent. A pool configuration failure is returned to the caller;
   * configured egress is never silently replaced with direct traffic.
   */
  fetch(networkPoolId?: string, tenantId?: string): ValidatedFetch {
    if (!networkPoolId || !this.poolResolver || !tenantId) return this.directFetch;
    const { poolResolver, policy } = this;
    return async (input, init) => {
      try {
        const agent = await poolResolver.resolveAgent(networkPoolId, tenantId);
        return await createValidatedFetch({ policy, agent })(input, init);
      } catch (error) {
        if (error instanceof PoolBindingError) {
          throw new GatewayError(
            "proxy_pool_unhealthy",
            503,
            "Configured proxy pool could not be established.",
            { poolId: networkPoolId, reason: error.message.slice(0, 200) },
            "network",
          );
        }
        throw error;
      }
    };
  }
  webSocket(networkPoolId?: string, tenantId?: string): ValidatedOutboundWebSocket {
    return async (url, headers, signal) => {
      if (url.protocol !== "wss:") {
        throw new GatewayError("invalid_request", 400, "validated WebSocket egress requires wss");
      }
      if (url.username || url.password || url.hash || (url.port !== "" && url.port !== "443")) {
        throw new GatewayError("invalid_request", 400, "invalid validated WebSocket target");
      }
      const hostname = url.hostname;
      if (!hostname) throw new GatewayError("invalid_request", 400, "WebSocket target hostname is required");
      const destination = await this.resolve(hostname, signal, 443);
      if (!isAddressAllowed(destination.resolvedAddress, this.policy)) {
        throw new GatewayError("invalid_request", 400, "unsafe upstream address rejected");
      }
      let agent: PoolAgent | undefined;
      if (networkPoolId || tenantId) {
        if (!networkPoolId || !tenantId || !this.poolResolver) {
          throw new GatewayError("proxy_pool_unhealthy", 503, "configured WebSocket proxy pool could not be established");
        }
        try {
          agent = await this.poolResolver.resolveWebSocketAgent(networkPoolId, tenantId);
        } catch (error) {
          if (error instanceof PoolBindingError) {
            throw new GatewayError("proxy_pool_unhealthy", 503, "configured WebSocket proxy pool could not be established");
          }
          throw error;
        }
      }
      return connectValidatedWebSocket(url, headers, signal, destination, agent);
    };
  }
}


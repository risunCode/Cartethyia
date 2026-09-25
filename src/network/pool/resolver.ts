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
import type { TransportKind } from "./agent";
import { isIP } from "node:net";
import { createHttpProxyAgent, createSocks5Agent, isProxyAgentPair, PoolBindingError, type PoolAgent } from "./agent";
import { parseAgentConfig, ProxyConfigError, type AgentConfig } from "../types";

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

  private async buildAgent(poolId: string, tenantId: string): Promise<PoolAgent> {
    const row = await this.loader.load(poolId);
    if (!row) throw new PoolBindingError(`network pool ${poolId} not found`);
    if (row.tenantId !== tenantId)
      throw new PoolBindingError(`network pool ${poolId} is not available to this tenant`);

    const agentConfig = this.resolveAgentConfig(row);
    switch (row.kind) {
      case "http":
      case "https":
      case "socks5": {
        const hostname = endpointHostname(row.kind, row.endpoint);
        if (hostname) await validateDialHost(hostname, this.ssrfPolicy, this.resolveFn);
        // The policy is handed to the agent too: both flavors re-resolve and
        // re-validate the proxy host on every connect, so the create-time
        // check cannot be bypassed by a DNS rebind of the proxy record.
        if (row.kind === "socks5")
          return createSocks5Agent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig);
        return createHttpProxyAgent(row.endpoint, row.credential, this.ssrfPolicy, agentConfig);
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
}


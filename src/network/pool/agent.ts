/**
 * Pool egress agents: the HTTP CONNECT pair, the SOCKS5 pair, and the
 * per-connect SSRF revalidation they share. `PoolAgentResolver` (resolver.ts)
 * caches instances of these; the selector owns admission.
 */
import { isIP } from "node:net";
import { accountSocketBytes, accountSocketWrites } from "./byte-accounting";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequestArgs,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { SocksProxyAgent } from "socks-proxy-agent";
import { resolveAllAddresses, validateResolvedAddresses } from "../ssrf";
import type { SsrfPolicy } from "../../config";
import { resolveProxyMaxFreeSockets, resolveProxyMaxSockets } from "../../config";
import type { AgentConfig } from "../types";

/**
 * Idle keep-alive socket timeout for every pool agent. Matches the 60s DB pool
 * idle window so long-idle resources in one process reap together.
 */
const PROXY_KEEP_ALIVE_TIMEOUT_MS = 60_000;

/**
 * The transport a network pool dials outbound traffic through. Every kind is
 * dialled directly by the resolver; no pool spawns a child process.
 *
 * `bridge` is a carte-bridge front door. Where the runtime holds a raw socket
 * (Docker/Railway/VPS/local `server.js`) the bridge answers RFC CONNECT, so the
 * pool tunnels like any HTTP proxy; on the serverless runtimes (Vercel/Netlify/
 * Deno/Cloudflare) it cannot, and answers the CONNECT attempt with an ordinary
 * HTTP error instead. The validated fetcher therefore prefers CONNECT and
 * falls back to the bridge's `x-bridge-target`/`x-bridge-path` relay contract
 * on that refusal.
 */
export const TRANSPORT_KINDS = ["http", "https", "socks5", "bridge"] as const;

/** One outbound transport kind. */
export type TransportKind = (typeof TRANSPORT_KINDS)[number];


/** Config keys reserved for endpoint/label; every other key is opaque non-secret transport config. */
export const RESERVED_ENDPOINT_CONFIG_KEYS: Record<string, true> = {
  endpoint: true,
  label: true,
};

export function splitEndpointConfig(config: Record<string, unknown>): {
  endpoint?: string;
  label?: string;
  rest: Record<string, unknown>;
} {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!RESERVED_ENDPOINT_CONFIG_KEYS[key]) rest[key] = value;
  }
  return {
    ...(typeof config.endpoint === "string" ? { endpoint: config.endpoint } : {}),
    ...(typeof config.label === "string" ? { label: config.label } : {}),
    rest,
  };
}

/** Derives the application-level `https` distinction the DB enum collapses into `http`. */
export function deriveKind(dbKind: string, endpoint: string): TransportKind {
  if (dbKind === "http") return endpoint.startsWith("https:") ? "https" : "http";
  return dbKind as TransportKind;
}

/**
 * Normalizes a `bridge` pool endpoint to the http(s) URL the pool actually
 * dials.
 *
 * A bridge front door is a real https host (Railway/Vercel/Netlify/Deno) or an
 * http one locally. Operators and the dashboard's bulk form may spell it
 * `bridge://host` to state the kind explicitly — that marker is an input
 * convention, not a transport, and `new URL("bridge://host")` would otherwise
 * parse with a `bridge:` protocol and be dialed as plaintext HTTP. A bare host
 * is read as https, since every hosted front door terminates TLS.
 *
 * Every consumer of a bridge endpoint — request validation, the loader, the
 * agent factory, the health check — reads this one shape, so the marker can
 * never reach a dial.
 */
export function normalizeBridgeEndpoint(endpoint: string): string {
  if (endpoint.startsWith("bridge://")) return `https://${endpoint.slice("bridge://".length)}`;
  return endpoint.includes("://") ? endpoint : `https://${endpoint}`;
}

// Pool agents — single egress
export type PoolAgent = HttpAgent | HttpsAgent | ProxyAgentPair;

class InvalidPoolAgentConfigError extends Error {}

function withCredential(url: URL, credential: string | undefined): URL {
  if (!credential) return url;
  const separator = credential.indexOf(":");
  const username = separator === -1 ? credential : credential.slice(0, separator);
  const password = separator === -1 ? "" : credential.slice(separator + 1);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url;
}

/**
 * Hosted relay front doors expose an application HTTP endpoint rather than
 * an RFC CONNECT proxy. Keep this classification beside the pool factory so
 * the dispatch and health-check paths cannot accidentally tunnel them with
 * CONNECT. This mirrors the supported relay-host policy in Cartethyia 21.
 */
function isRelayHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return (
    normalized.endsWith(".vercel.app") ||
    normalized.endsWith(".workers.dev") ||
    normalized.endsWith(".netlify.app") ||
    // Deno Deploy project URLs. `*.deno.dev` is the project hostname Deno
    // Deploy assigns, so a deployed relay answers there exactly like a
    // Vercel/Workers front door.
    normalized.endsWith(".deno.dev")
  );
}

/**
 * Per-connect DNS lookup that validates every resolved address of the dialed
 * host against the SSRF policy, pinning the validated address for the socket.
 * Shared by the HTTP CONNECT handshake and the SOCKS5 proxy socket: both dial
 * a *proxy* host that was validated at create-time, so a DNS-rebind of that
 * record must not be able to swap it to a private/link-local address later.
 */
function createSsrfLookup(policy: SsrfPolicy): NonNullable<RequestOptions["lookup"]> {
  return ((
    hostname: string,
    lookupOptions: { all?: boolean; family?: number } | number,
    cb: (
      error: Error | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const abort = new AbortController();
    void resolveAllAddresses(hostname, abort.signal)
      .then((addrs) => {
        try {
          validateResolvedAddresses(addrs, policy);
        } catch (error) {
          cb(error as Error);
          return;
        }
        const first = addrs[0];
        if (!first) {
          cb(new Error(`no addresses resolved for ${hostname}`));
          return;
        }
        const family = first.includes(":") ? 6 : 4;
        const opts = typeof lookupOptions === "number" ? { family: lookupOptions } : lookupOptions;
        if (opts?.all) {
          cb(null, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
          return;
        }
        cb(null, first, family);
      })
      .catch((error: unknown) => cb(error as Error));
  }) as unknown as NonNullable<RequestOptions["lookup"]>;
}

/**
 * A proxy answered the CONNECT handshake with a non-200 status instead of
 * establishing the tunnel. Typed so the caller can read the status without
 * re-parsing text: the health machine treats 402/407 as "reachable but
 * unusable", and a `bridge` pool treats the whole class as "this front door
 * does not do CONNECT, use the relay form".
 */
export class ProxyConnectRefusalError extends Error {
  constructor(
    readonly statusCode: number,
    statusMessage?: string,
  ) {
    super(`Proxy CONNECT failed: ${statusCode}${statusMessage ? ` ${statusMessage}` : ""}`);
    this.name = "ProxyConnectRefusalError";
  }
}

/**
 * A CONNECT handshake that never reached "established" for a reason other than
 * an explicit status refusal — the socket was reset, the connection refused, or
 * the peer closed before answering.
 *
 * Tagged at the handshake on purpose. The distinction that matters to a caller
 * is *when* the failure happened: this class means "the bridge could not be
 * reached as a tunnel", which is the signal to fall back to the relay form. A
 * failure that happens *inside* an established tunnel — the target's own TLS
 * handshake failing, say — is a different error from a different code path and
 * must not be retried elsewhere, so it is deliberately not this class.
 */
export class ProxyConnectHandshakeError extends Error {
  constructor(cause: Error) {
    super(`Proxy CONNECT handshake failed: ${cause.message}`);
    this.name = "ProxyConnectHandshakeError";
    this.cause = cause;
  }
}

/**
 * True when a CONNECT attempt failed at the handshake, so a `bridge` pool
 * should retry through the relay form. Only the two handshake classes qualify:
 * a `ProxyConnectRefusalError` (the front door answered "no CONNECT") and a
 * `ProxyConnectHandshakeError` (the front door reset or refused the socket). A
 * caller cancellation and any error raised after the tunnel was established are
 * never retried.
 */
export function shouldFallbackToBridgeRelay(error: unknown): boolean {
  return (
    error instanceof ProxyConnectRefusalError || error instanceof ProxyConnectHandshakeError
  );
}

/**
 * Shared HTTP CONNECT tunnel establishment (proxy handshake + SSRF-pinned
 * proxy DNS). Used by both scheme flavors below; the returned socket is the
 * raw CONNECT tunnel — node's http/https layer performs the *target* TLS
 * handshake itself over it.
 */
function createProxyConnection(
  proxy: URL,
  policy: SsrfPolicy,
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
    poolId?: string,
  ): Duplex | null | undefined {
    const targetHost = options.hostname ?? options.host ?? "";
    const targetPort = options.port ?? 443;
    const isHttpsProxy = proxy.protocol === "https:";
    const fail = (error: Error): void => {
      callback?.(error, undefined as unknown as Duplex);
    };
    const lookup = createSsrfLookup(policy);
    const proxyOptions: ClientRequestArgs = {
      hostname: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : isHttpsProxy ? 443 : 80,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      agent: false,
      lookup,
      // SNI is mandatory for name-based TLS front doors (Vercel serves a
      // fallback cert without it → altnames mismatch). Skipped for literal
      // IPs, which TLS rejects as a servername.
      ...(isHttpsProxy && !isIP(proxy.hostname) ? { servername: proxy.hostname } : {}),
    };
    if (proxy.username || proxy.password) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      proxyOptions.headers = {
        ...proxyOptions.headers,
        "proxy-authorization": `Basic ${Buffer.from(auth).toString("base64")}`,
      };
    }
    const proxyRequest = (isHttpsProxy ? httpsRequest : httpRequest)(proxyOptions);
    // Every failure before the tunnel is established — the socket reset, the
    // connection refused, the peer closing early, the CONNECT request itself
    // erroring — is a handshake failure and is tagged as such, so a `bridge`
    // pool can tell "this front door does not tunnel" from an error raised
    // later, inside a tunnel that did open.
    let established = false;
    const failHandshake = (error: Error): void => {
      if (established) {
        fail(error);
        return;
      }
      fail(new ProxyConnectHandshakeError(error));
    };
    proxyRequest.on(
      "connect",
      (response: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (response.statusCode !== 200) {
          fail(new ProxyConnectRefusalError(response.statusCode ?? 502, response.statusMessage));
          socket.destroy();
          return;
        }
        established = true;
        if (head.length > 0) socket.unshift(head);
        // Tally the tunnel from here on. The CONNECT request itself is a few
        // dozen bytes and is not counted; everything the tunnel carries is.
        if (poolId) {
          accountSocketBytes(socket, poolId);
          accountSocketWrites(socket, poolId);
        }
        callback?.(null, socket);
      },
    );
    proxyRequest.on("error", failHandshake);
    proxyRequest.end();
    return undefined;
}

/**
 * One pool's dual-scheme egress. Node validates `agent.protocol` per
 * request (`https.request` rejects an `http:` agent with `Protocol "https:"
 * not supported`), so a single Agent class cannot serve both target
 * schemes — the pair carries one flavor per scheme around one shared
 * CONNECT implementation.
 */
export interface ProxyAgentPair {
  /** Flavor for `http:` targets (protocol `http:`). */
  readonly http: HttpAgent;
  /** Flavor for `https:` targets (protocol `https:`). */
  readonly https: HttpsAgent;
  /**
   * Relay endpoint for hosted HTTP front doors (Vercel/Workers/Netlify).
   * These endpoints are application relays, not RFC CONNECT proxies; the
   * validated fetcher sends `x-relay-target`/`x-relay-path` to this URL.
   */
  readonly relayEndpoint?: URL;
  /**
   * Set only on `bridge` pools: the carte-bridge front door's base URL. The
   * fetcher dials the CONNECT pair above first and, when the front door
   * refuses (a serverless runtime cannot hold a socket), retries through the
   * bridge-specific header relay contract.
   */
  readonly bridgeEndpoint?: URL;
}

export function isProxyAgentPair(value: unknown): value is ProxyAgentPair {
  // Shape-checked (not instanceof): the socks pair holds two
  // SocksProxyAgent flavors, which are never HttpsAgent subclasses — what
  // matters is one agent per target scheme behind a shared CONNECT path.
  if (!value || typeof value !== "object") return false;
  const pair = value as Record<string, unknown>;
  const http = pair.http as { createConnection?: unknown } | undefined;
  const https = pair.https as { createConnection?: unknown } | undefined;
  return (
    typeof http?.createConnection === "function" &&
    typeof https?.createConnection === "function"
    );
}

class HttpProxyAgent extends HttpAgent {
  constructor(
    readonly proxy: URL,
    /** SSRF policy applied to the *proxy* hostname on every CONNECT so a
     *  DNS-rebind of the proxy record cannot swap it to a private/link-local
     *  address after the pool was validated at create-time. */
    private readonly policy: SsrfPolicy = {},
    config: AgentConfig = {},
    private readonly poolId?: string,
  ) {
    super({
      keepAlive: true,
      maxSockets: config.maxSockets ?? resolveProxyMaxSockets(),
      maxFreeSockets: config.maxFreeSockets ?? resolveProxyMaxFreeSockets(),
      timeout: config.keepAliveTimeout ?? PROXY_KEEP_ALIVE_TIMEOUT_MS,
    });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    return createProxyConnection(this.proxy, this.policy, options, callback, this.poolId);
  }
}

class HttpsProxyAgent extends HttpsAgent {
  constructor(
    readonly proxy: URL,
    private readonly policy: SsrfPolicy = {},
    config: AgentConfig = {},
    private readonly poolId?: string,
  ) {
    super({
      keepAlive: true,
      maxSockets: config.maxSockets ?? resolveProxyMaxSockets(),
      maxFreeSockets: config.maxFreeSockets ?? resolveProxyMaxFreeSockets(),
      timeout: config.keepAliveTimeout ?? PROXY_KEEP_ALIVE_TIMEOUT_MS,
    });
  }
  override createConnection(
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    return createProxyConnection(this.proxy, this.policy, options, (err, rawSocket) => {
      if (err || !rawSocket) {
        callback?.(err, rawSocket);
        return;
      }
      const targetHost = options.hostname ?? options.host ?? "";
      const tlsSocket = tls.connect({
        socket: rawSocket,
        servername: isIP(targetHost) ? undefined : targetHost,
        rejectUnauthorized: this.options.rejectUnauthorized !== false,
      });
      tlsSocket.once("secureConnect", () => {
        callback?.(null, tlsSocket);
      });
      tlsSocket.once("error", (tlsErr) => {
        rawSocket.destroy();
        callback?.(tlsErr, undefined as unknown as Duplex);
      });
    }, this.poolId);
  }
}
export function createHttpProxyAgent(
  endpoint: string,
  credential?: string,
  policy: SsrfPolicy = {},
  config: AgentConfig = {},
  poolId?: string,
): ProxyAgentPair {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidPoolAgentConfigError(`invalid HTTP proxy endpoint: ${endpoint}`);
  }
  const proxy = new URL(withCredential(url, credential).toString());
  return {
    http: new HttpProxyAgent(proxy, policy, config, poolId),
    https: new HttpsProxyAgent(proxy, policy, config, poolId),
    ...(isRelayHost(proxy.hostname) ? { relayEndpoint: proxy } : {}),
  };
}

/**
 * One carte-bridge front door as a pool egress.
 *
 * The CONNECT pair is the primary transport: where the bridge's runtime holds a
 * raw socket it answers RFC CONNECT and the pool tunnels exactly like an HTTP
 * proxy. `bridgeEndpoint` is carried alongside as the fallback the fetcher uses
 * when the front door refuses CONNECT (the serverless runtimes), sending the
 * bridge-specific target/path headers.
 *
 * `relayEndpoint` is deliberately NOT set here even when the host matches
 * `isRelayHost`: that field selects the `x-relay-target` contract, which is a
 * different front door. A bridge uses `x-bridge-target`/`x-bridge-path`.
 */
export function createBridgeAgent(
  endpoint: string,
  credential?: string,
  policy: SsrfPolicy = {},
  config: AgentConfig = {},
  poolId?: string,
): ProxyAgentPair {
  let url: URL;
  try {
    url = new URL(normalizeBridgeEndpoint(endpoint));
  } catch {
    throw new InvalidPoolAgentConfigError(`invalid bridge endpoint: ${endpoint}`);
  }
  const bridge = new URL(withCredential(url, credential).toString());
  return {
    http: new HttpProxyAgent(bridge, policy, config, poolId),
    https: new HttpsProxyAgent(bridge, policy, config, poolId),
    bridgeEndpoint: bridge,
  };
}


/**
 * Tally a SOCKS5 agent's tunnel.
 *
 * The socks client owns socket creation, so this wraps `createConnection`
 * instead of the CONNECT callback the HTTP path uses. The socket handed back is
 * the raw tunnel (Node applies TLS afterwards for `https:` targets), which is
 * exactly the layer whose bytes the proxy bills. The SOCKS negotiation itself
 * is a handful of bytes exchanged before this point and is not counted.
 */
function accountSocksAgent(agent: SocksProxyAgent, poolId?: string): void {
  if (!poolId) return;
  const original = agent.createConnection.bind(agent) as (
    options: ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ) => Duplex | null | undefined;
  agent.createConnection = ((options: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void) =>
    original(options, (error, socket) => {
      if (socket) {
        accountSocketBytes(socket, poolId);
        accountSocketWrites(socket, poolId);
      }
      callback?.(error, socket);
    })) as unknown as typeof agent.createConnection;
}

export function createSocks5Agent(
  endpoint: string,
  credential?: string,
  policy: SsrfPolicy = {},
  config: AgentConfig = {},
  poolId?: string,
): ProxyAgentPair {
  const authority = endpoint.includes("://") ? endpoint : `socks5://${endpoint}`;
  let url: URL;
  try {
    url = new URL(authority);
  } catch {
    throw new InvalidPoolAgentConfigError(`invalid SOCKS5 endpoint: ${endpoint}`);
  }
  // The proxy hostname is resolved by the socks client itself, so the policy
  // is applied through the socket's `lookup`: every connect re-resolves and
  // re-validates the proxy address instead of trusting the create-time check.
  const options = {
    socketOptions: { lookup: createSsrfLookup(policy) },
    keepAlive: true,
    maxSockets: config.maxSockets ?? resolveProxyMaxSockets(),
    maxFreeSockets: config.maxFreeSockets ?? resolveProxyMaxFreeSockets(),
    timeout: config.keepAliveTimeout ?? PROXY_KEEP_ALIVE_TIMEOUT_MS,
  };
  const http = new SocksProxyAgent(withCredential(url, credential), options);
  accountSocksAgent(http, poolId);
  // Same latent Node check as HTTP pools: an `http:`-protocol agent is
  // rejected for `https:` targets, so the https flavor carries an
  // overridden protocol (per-instance shadow — the shared SocksProxyAgent
  // prototype is untouched). Behavior is identical; only the check reads it.
  const https = new SocksProxyAgent(withCredential(url, credential), options);
  https.protocol = "https:";
  accountSocksAgent(https, poolId);
  return {
    http: http as unknown as HttpAgent,
    https: https as unknown as HttpsAgent,
  };
}

export class PoolBindingError extends Error {}

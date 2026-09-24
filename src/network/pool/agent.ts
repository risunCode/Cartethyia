/**
 * Pool egress agents: the HTTP CONNECT pair, the SOCKS5 pair, and the
 * per-connect SSRF revalidation they share. `PoolAgentResolver` (resolver.ts)
 * caches instances of these; the selector owns admission.
 */
import { isIP } from "node:net";
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
 */
export const TRANSPORT_KINDS = ["http", "https", "socks5"] as const;

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
    normalized.endsWith(".netlify.app")
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
    proxyRequest.on(
      "connect",
      (response: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (response.statusCode !== 200) {
          fail(new Error(`Proxy CONNECT failed: ${response.statusCode} ${response.statusMessage}`));
          socket.destroy();
          return;
        }
        if (head.length > 0) socket.unshift(head);
        callback?.(null, socket);
      },
    );
    proxyRequest.on("error", fail);
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
    return createProxyConnection(this.proxy, this.policy, options, callback);
  }
}

class HttpsProxyAgent extends HttpsAgent {
  constructor(
    readonly proxy: URL,
    private readonly policy: SsrfPolicy = {},
    config: AgentConfig = {},
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
    });
  }
}
export function createHttpProxyAgent(
  endpoint: string,
  credential?: string,
  policy: SsrfPolicy = {},
  config: AgentConfig = {},
): ProxyAgentPair {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidPoolAgentConfigError(`invalid HTTP proxy endpoint: ${endpoint}`);
  }
  const proxy = new URL(withCredential(url, credential).toString());
  return {
    http: new HttpProxyAgent(proxy, policy, config),
    https: new HttpsProxyAgent(proxy, policy, config),
    ...(isRelayHost(proxy.hostname) ? { relayEndpoint: proxy } : {}),
  };
}


export function createSocks5Agent(
  endpoint: string,
  credential?: string,
  policy: SsrfPolicy = {},
  config: AgentConfig = {},
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
  // Same latent Node check as HTTP pools: an `http:`-protocol agent is
  // rejected for `https:` targets, so the https flavor carries an
  // overridden protocol (per-instance shadow — the shared SocksProxyAgent
  // prototype is untouched). Behavior is identical; only the check reads it.
  const https = new SocksProxyAgent(withCredential(url, credential), options);
  https.protocol = "https:";
  return {
    http: http as unknown as HttpAgent,
    https: https as unknown as HttpsAgent,
  };
}

export class PoolBindingError extends Error {}

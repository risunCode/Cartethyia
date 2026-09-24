// Validated fetch: SSRF-guarded outbound fetch with optional pool-agent support.
import { GatewayError } from "../transport/gateway-error";
import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { resolveAllAddresses, validateResolvedAddresses } from "./ssrf";
import { resolveHttp2Enabled, resolveHttp2FallbackEnabled } from "../config";
import type { SsrfPolicy } from "../config";
import { isProxyAgentPair, type ProxyAgentPair } from "./pool/agent";
import { metrics } from "../observability/metrics";
import { trackNetworkCall } from "../observability/performance-metrics";
import {
  Http2ConnectionError,
  Http2UnsupportedError,
  http2PinnedFetcher,
} from "./http2-fetch";
import { stripResponseHeaders } from "./response-headers";
// Validated fetch — single egress with ProxyAgent support
export interface ValidatedFetchOptions {
  readonly fetchFn?: typeof fetch;
  readonly policy?: SsrfPolicy;
  readonly maxRedirects?: number;
  readonly resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  readonly agent?: HttpAgent | HttpsAgent | ProxyAgentPair;
  /**
   * Transport preference for direct HTTPS egress. `"http2"` (default, unless
   * `CARTETHYIA_HTTP2_ENABLED=false`) uses multiplexed pinned HTTP/2 sessions;
   * `"http1"` forces the node:http agent path. Ignored when a pool agent or a
   * custom `fetchFn` owns the dial.
   */
  readonly protocol?: "http1" | "http2";
  /** Override `CARTETHYIA_HTTP2_FALLBACK_ENABLED` for this fetch closure. */
  readonly http2Fallback?: boolean;
}
export type ValidatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Node validates `agent.protocol` per request, so a pool pair contributes
 * the flavor matching the *target* scheme (redirect hops reselect, since
 * the scheme can change mid-chain).
 */
function agentForTarget(
  agent: HttpAgent | HttpsAgent | ProxyAgentPair | undefined,
  protocol: string,
): HttpAgent | HttpsAgent | undefined {
  if (!agent) return undefined;
  if (isProxyAgentPair(agent)) return protocol === "https:" ? agent.https : agent.http;
  return agent;
}

/**
 * Builds the application-relay request used by hosted relay front doors.
 * These endpoints intentionally do not receive CONNECT: they accept the
 * target origin/path in headers and perform the upstream fetch themselves,
 * matching the 21-beta relay contract.
 */
function relayRequest(
  relayEndpoint: URL,
  target: URL,
  init: RequestInit,
): { url: URL; init: RequestInit } {
  const relayUrl = new URL(relayEndpoint.toString());
  const headers = new Headers(init.headers);
  headers.delete("host");
  headers.set("x-relay-target", target.origin);
  headers.set("x-relay-path", `${target.pathname}${target.search}`);
  if (relayUrl.username || relayUrl.password) {
    const credentials = `${decodeURIComponent(relayUrl.username)}:${decodeURIComponent(relayUrl.password)}`;
    headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
    relayUrl.username = "";
    relayUrl.password = "";
  }
  return { url: relayUrl, init: { ...init, headers } };
}

async function pinnedFetch(
  url: URL,
  init: RequestInit,
  resolvedAddress: string | undefined,
  agent?: HttpAgent | HttpsAgent,
): Promise<Response> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init.headers);
  const body =
    init.body === undefined || init.body === null
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : Buffer.from(await new Response(init.body).arrayBuffer());
  const outboundHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    outboundHeaders[key] = value;
  });
  // A known-length JSON/string body must not fall back to chunked encoding.
  // Upstream gateways may wait for the complete chunked stream before routing
  // the request, adding an avoidable RTT compared with global fetch/Undici.
  if (body !== undefined && !headers.has("content-length")) {
    outboundHeaders["content-length"] =
      typeof body === "string" ? String(Buffer.byteLength(body, "utf8")) : String(body.byteLength);
  }
  const lookup = ((
    _hostname: string,
    options: { all?: boolean; family?: number } | number,
    callback: (
      error: Error | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    if (resolvedAddress === undefined) {
      callback(new Error("no validated address available"));
      return;
    }
    const opts = typeof options === "number" ? { family: options } : options;
    const family = resolvedAddress.includes(":") ? 6 : 4;
    if (opts?.all) {
      callback(null, [{ address: resolvedAddress, family }] as never);
      return;
    }
    callback(null, resolvedAddress, family);
  }) as unknown as NonNullable<RequestOptions["lookup"]>;
  return new Promise<Response>((resolve, reject) => {
    const nodeRequest = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? url.port : url.protocol === "https:" ? "443" : "80",
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: outboundHeaders,
        signal: init.signal ?? undefined,
        ...(agent ? { agent } : { lookup }),
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      },
      (response) => {
        const responseHeaders = stripResponseHeaders(response.headers);
        const webStream = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
        resolve(
          new Response(webStream, {
            status: response.statusCode ?? 502,
            headers: responseHeaders,
          }),
        );
      },
    );
    nodeRequest.on("error", reject);
    if (body !== undefined) nodeRequest.write(body);
    nodeRequest.end();
  });
}

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;

function stripCredentialsOnCrossOrigin(
  headersInit: HeadersInit | undefined,
): Headers {
  const headers = new Headers(headersInit);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return headers;
}

export function createValidatedFetch(options: ValidatedFetchOptions = {}): ValidatedFetch {
  const policy = options.policy ?? {};
  const maxRedirects = options.maxRedirects ?? policy.maxRedirects ?? 3;
  const resolveFn = options.resolveFn ?? resolveAllAddresses;
  const configuredAgent = options.agent;
  const relayEndpoint = isProxyAgentPair(configuredAgent)
    ? configuredAgent.relayEndpoint
    : undefined;
  const protocol = options.protocol ?? (resolveHttp2Enabled() ? "http2" : "http1");
  const http2Fallback = options.http2Fallback ?? resolveHttp2FallbackEnabled();
  return async (input, init = {}) => {
    const startedAt = performance.now();
    let url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    let requestInit: RequestInit = { ...init, redirect: "manual" };
    if (input instanceof Request && init.headers === undefined) {
      requestInit.headers = new Headers(input.headers);
    }
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new TypeError("unsupported outbound URL protocol");
      const signal = requestInit.signal ?? new AbortController().signal;
      // Every hop — including proxied dials and redirect targets — is resolved
      // and checked against the SSRF policy. When a proxy agent owns the dial,
      // the proxy still resolves its own answer, so the check is advisory there;
      // it deterministically rejects targets whose *advertised* addresses fall
      // in blocked ranges (literal-IP redirects, private-space DNS, relay abuse).
      // For a pool/relay-owned dial, the upstream *target* is resolved by the
      // proxy/relay itself, so local DNS for it is an advisory SSRF check,
      // not a prerequisite for egress. Operator VPNs routinely break the
      // system resolver (tunnel DNS that is unreachable or drops queries);
      const poolDialsTarget = Boolean(configuredAgent || relayEndpoint);
      let resolvedAddress: string | undefined;
      let relayResolvedAddress: string | undefined;
      if (poolDialsTarget) {
        // The egress dials the pool/relay, which resolves the target itself.
        // Counting these lets ops confirm how much traffic depends on
        // proxy-resolved DNS rather than the local system resolver.
        metrics.cartethyia_proxy_dial_dns_fallback_total.inc();
      }
      try {
        if (!poolDialsTarget) {
          const addresses = await resolveFn(url.hostname, signal);
          validateResolvedAddresses(addresses, policy);
          resolvedAddress = addresses[0];
        }
        if (relayEndpoint) {
          const relayAddresses = await resolveFn(relayEndpoint.hostname, signal);
          validateResolvedAddresses(relayAddresses, policy);
          relayResolvedAddress = relayAddresses[0];
          if (!relayResolvedAddress)
            throw new TypeError(`no validated address for ${relayEndpoint.hostname}`);
        }
      } catch (error) {
        // A pool/relay-owned dial still needs its egress host locally; only
        // the advisory target lookup may degrade.
        if (relayEndpoint && !relayResolvedAddress) throw error;
        if (!poolDialsTarget) throw new TypeError(`no validated address for ${url.hostname}`);
      }
      if (!poolDialsTarget && !resolvedAddress)
        throw new TypeError(`no validated address for ${url.hostname}`);
      let response: Response;
      if (relayEndpoint) {
        const relay = relayRequest(relayEndpoint, url, requestInit);
        response = options.fetchFn
          ? await options.fetchFn(relay.url, relay.init)
          : await pinnedFetch(relay.url, relay.init, relayResolvedAddress!);
      } else if (options.fetchFn) {
        response = await options.fetchFn(url, requestInit);
      } else {
        const agent = agentForTarget(configuredAgent, url.protocol);
        // HTTP/2 is only reachable for direct HTTPS dials: a pool agent or an
        // injected fetchFn owns its own transport, and h2 requires TLS.
        const http2Eligible =
          protocol === "http2" && url.protocol === "https:" && configuredAgent === undefined;
        if (http2Eligible) {
          try {
            response = await http2PinnedFetcher.fetch(url, requestInit, resolvedAddress!);
            metrics.cartethyia_http2_requests_total.inc(1, { protocol: "http2" });
          } catch (error) {
            if (
              http2Fallback &&
              (error instanceof Http2UnsupportedError || error instanceof Http2ConnectionError)
            ) {
              // The upstream does not speak h2 (or the session died): degrade to
              // the HTTP/1.1 pinned path rather than failing the request.
              metrics.cartethyia_http2_fallbacks_total.inc();
              metrics.cartethyia_http2_requests_total.inc(1, { protocol: "http1" });
              response = await pinnedFetch(url, requestInit, resolvedAddress!, agent);
            } else {
              throw error;
            }
          }
        } else {
          response = await pinnedFetch(url, requestInit, resolvedAddress!, agent);
          metrics.cartethyia_http2_requests_total.inc(1, { protocol: "http1" });
        }
      }
      if (response.status < 300 || response.status >= 400) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      // The redirect response body is never consumed: release its socket
      // before following the next hop instead of leaving it open.
      await response.body?.cancel().catch(() => undefined);
      const nextUrl = new URL(location, url);
      const isCrossOriginRedirect = nextUrl.origin !== url.origin;
      if (isCrossOriginRedirect) {
        requestInit = { ...requestInit, headers: stripCredentialsOnCrossOrigin(requestInit.headers) };
      }
      if (isCrossOriginRedirect && (response.status === 307 || response.status === 308)) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && requestInit.body !== undefined) {
          throw new GatewayError("invalid_request", 400, "cross-origin redirect with body blocked");
        }
      }
      url = nextUrl;
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const { body: _body, ...withoutBody } = requestInit;
          requestInit = { ...withoutBody, method: "GET" };
        }
      }
    }
    throw new Error("outbound redirect limit exceeded");
  };
}

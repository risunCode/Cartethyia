/**
 * Proxy fetcher adapter — turns a `ProxyTarget` into a fetch-shaped function
 * `(url, init) => Promise<Response>`, the exact seam `SimpleProviderCallOptions.fetcher`
 * (and every direct-fetch provider, once threaded) already accepts.
 *
 * Two paths, chosen by protocol:
 *  - http/https: Bun's native `fetch({ proxy })` (stable since Bun 1.3.4). Zero
 *    extra work — Bun's own HTTP client tunnels the request.
 *  - socks5: Bun's fetch does NOT support this (the two upstream PRs adding
 *    SOCKS5 to Bun's native client were both closed — the latest for a
 *    handshake-hang bug — and unpatched `socks5://` still throws
 *    `UnsupportedProxyProtocol`). Routed instead through `socks-proxy-agent`
 *    (an `http.Agent`-compatible SOCKS5 tunnel) driving `node:http`/`node:https`,
 *    with the resulting `IncomingMessage` adapted back into a Web `Response`
 *    via `Readable.toWeb`. Verified end-to-end against a local SOCKS5 server
 *    before wiring this in.
 */

import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProxyFetcher, ProxyTarget } from "./types";

function proxyUrlOf(proxy: ProxyTarget): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ""}@`
    : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

/** Node's `req.write()` accepts string/Uint8Array directly; anything else is out of scope for today's callers. */
function normalizeBody(body: RequestInit["body"]): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error(`Unsupported request body type for proxied dispatch: ${Object.prototype.toString.call(body)}`);
}

function headersToObject(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Tunnels a fetch-shaped call through a SOCKS5 proxy via a Node http(s).request, adapted back into a Web Response. */
function socks5Fetcher(proxy: ProxyTarget): ProxyFetcher {
  const agentUrl = proxyUrlOf(proxy);
  return (url, init) => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        agent: new SocksProxyAgent(agentUrl),
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: headersToObject(init.headers),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const entry of value) responseHeaders.append(key, entry);
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 502, headers: responseHeaders }));
      },
    );
    req.on("error", reject);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
        return promise;
      }
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    const body = normalizeBody(init.body);
    if (body === undefined) req.end();
    else req.end(body);
    return promise;
  };
}

/** Sends a fetch-shaped call to an HTTP relay endpoint using the relay forwarding contract. */
function relayFetcher(proxy: ProxyTarget): ProxyFetcher {
  const relayUrl = proxyUrlOf(proxy);
  return (url, init) => {
    const target = new URL(url);
    const headers = new Headers(init.headers ?? {});
    headers.delete("host");
    headers.set("x-relay-target", target.origin);
    headers.set("x-relay-path", `${target.pathname}${target.search}`);
    if (proxy.username) {
      const credentials = `${proxy.username}:${proxy.password ?? ""}`;
      headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
    }
    return fetch(relayUrl, { ...init, headers });
  };
}

/** Tunnels a fetch-shaped call through an HTTP/HTTPS proxy via Bun's native `fetch({ proxy })`. */
function httpProxyFetcher(proxy: ProxyTarget): ProxyFetcher {
  const proxyUrl = proxyUrlOf(proxy);
  return (url, init) => fetch(url, { ...init, proxy: proxyUrl });
}

/** Builds a fetch-compatible fetcher routing outbound calls through the given proxy. */
export function buildProxyFetcher(proxy: ProxyTarget): ProxyFetcher {
  if (proxy.isRelay) return relayFetcher(proxy);
  return proxy.protocol === "socks5" ? socks5Fetcher(proxy) : httpProxyFetcher(proxy);
}

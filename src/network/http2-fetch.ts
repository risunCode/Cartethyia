/**
 * HTTP/2 egress over a pinned, SSRF-validated destination.
 *
 * Bun's global `fetch` can negotiate HTTP/2, but it exposes no way to pin the
 * resolved address or supply a custom socket — so using it for egress would
 * silently drop the DNS-rebind protection the HTTP/1.1 path enforces. This
 * module instead drives `node:http2` directly and supplies a `createConnection`
 * that opens TLS to the *already validated* address while keeping SNI/ALPN for
 * the real hostname. Pinning and HTTP/2 multiplexing are therefore both
 * preserved.
 *
 * Sessions are cached per origin and multiplexed across concurrent requests;
 * the cache is bounded and lazily reaped, and sessions are unref'd so an idle
 * keep-alive connection never holds the event loop open past graceful shutdown.
 */
import http2 from "node:http2";
import tls from "node:tls";
import { isIP } from "node:net";
import { Readable, type Duplex } from "node:stream";
import { metrics } from "../observability/metrics";
import { stripResponseHeaders } from "./response-headers";

/**
 * The peer did not negotiate HTTP/2 (ALPN mismatch). Fallback-eligible: the
 * caller may retry over HTTP/1.1.
 */
export class Http2UnsupportedError extends Error {}

/**
 * The HTTP/2 connection failed before a response was received. Fallback-eligible.
 */
export class Http2ConnectionError extends Error {}

interface CachedSession {
  readonly session: http2.ClientHttp2Session;
  readonly address: string;
  lastUsed: number;
}

export interface Http2PinnedFetcherOptions {
  /** Maximum concurrently cached sessions before LRU eviction. */
  readonly maxSessions?: number;
  /** Idle time after which a cached session is closed on the next request. */
  readonly idleMs?: number;
  /** TLS/HTTP/2 handshake timeout. */
  readonly connectTimeoutMs?: number;
  /**
   * Socket factory for the pinned connection. Defaults to a TLS connection to
   * the validated address. Overridable as a test/advanced seam (mirrors the
   * injected `resolveFn`/`spawnFn` seams elsewhere in this codebase).
   */
  readonly createConnection?: (params: {
    readonly host: string;
    readonly port: number;
    readonly resolvedAddress: string;
  }) => Duplex;
}

const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Opens TLS to the *validated* address while presenting the real hostname for
 * SNI and certificate validation, and advertising only h2 via ALPN.
 */
function pinnedTlsConnection(params: {
  host: string;
  port: number;
  resolvedAddress: string;
}): Duplex {
  return tls.connect({
    host: params.resolvedAddress,
    // A literal IP cannot be a TLS servername; otherwise the pinning host is
    // used for SNI and certificate validation.
    ...(isIP(params.host) === 0 ? { servername: params.host } : {}),
    port: params.port,
    ALPNProtocols: ["h2"],
    rejectUnauthorized: true,
  });
}

/** HTTP/2 forbids connection-specific request headers. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function originKey(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * Distinguishes an ALPN/negotiation mismatch from a genuine connection
 * failure. Runtimes surface the mismatch differently (Bun emits an
 * `h2 is not supported` error), so the protocol is cross-checked against the
 * error text. Both outcomes are fallback-eligible; only the classification
 * differs.
 */
function classifyConnectFailure(
  session: http2.ClientHttp2Session,
  error: Error,
): Error {
  const negotiated = session.alpnProtocol;
  if (negotiated !== "h2" && /h2|alpn|protocol/i.test(error.message)) {
    return new Http2UnsupportedError(error.message);
  }
  return new Http2ConnectionError(error.message);
}

export class Http2PinnedFetcher {
  private readonly sessions = new Map<string, CachedSession>();
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly connectTimeoutMs: number;
  private readonly createConnection: (params: {
    readonly host: string;
    readonly port: number;
    readonly resolvedAddress: string;
  }) => Duplex;

  constructor(options: Http2PinnedFetcherOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.createConnection = options.createConnection ?? pinnedTlsConnection;
  }

  /**
   * Issues one HTTP/2 request over a pinned connection. Throws
   * {@link Http2UnsupportedError} or {@link Http2ConnectionError} for
   * pre-response failures so the caller can fall back to HTTP/1.1; errors after
   * the response headers arrive propagate as-is because the body is already
   * streaming to the caller.
   */
  async fetch(url: URL, init: RequestInit, resolvedAddress: string): Promise<Response> {
    this.evictIdle();
    const key = originKey(url);
    const cached = this.sessions.get(key);
    const reusable =
      cached !== undefined && !cached.session.destroyed && !cached.session.closed;
    if (reusable) {
      cached.lastUsed = Date.now();
      metrics.cartethyia_http2_connection_reuse_total.inc();
      try {
        return await this.request(cached.session, url, init);
      } catch (error) {
        // A pooled session can fail because the peer dropped it while idle.
        // Evict and retry once on a fresh pinned connection.
        if (!(error instanceof Http2ConnectionError)) throw error;
        this.destroySession(key, cached.session);
      }
    }
    const session = await this.connect(key, url, resolvedAddress);
    return await this.request(session, url, init);
  }

  /** Closes every cached session (graceful shutdown). */
  close(): void {
    for (const entry of this.sessions.values()) entry.session.close();
    this.sessions.clear();
  }

  /** Test/diagnostic seam: number of live cached sessions. */
  size(): number {
    return this.sessions.size;
  }

  private destroySession(key: string, session: http2.ClientHttp2Session): void {
    if (this.sessions.get(key)?.session === session) this.sessions.delete(key);
    if (!session.destroyed) session.destroy();
  }

  private evictIdle(): void {
    const cutoff = Date.now() - this.idleMs;
    for (const [key, entry] of this.sessions) {
      if (entry.lastUsed >= cutoff && !entry.session.destroyed && !entry.session.closed) continue;
      this.sessions.delete(key);
      if (!entry.session.destroyed) entry.session.close();
    }
  }

  private connect(
    key: string,
    url: URL,
    resolvedAddress: string,
  ): Promise<http2.ClientHttp2Session> {
    return new Promise((resolve, reject) => {
      const host = url.hostname;
      const port = url.port ? Number(url.port) : 443;
      const authority = `https://${url.host}`;
      let settled = false;
      let session: http2.ClientHttp2Session;
      try {
        session = http2.connect(authority, {
          createConnection: () =>
            this.createConnection({ host, port, resolvedAddress }),
        });
      } catch (error) {
        reject(new Http2ConnectionError(`http2 connect failed: ${String(error)}`));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        session.destroy();
        reject(new Http2ConnectionError("http2 connect timed out"));
      }, this.connectTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      session.on("error", (error) => {
        this.sessions.delete(key);
        if (settled) {
          // An established session failed: drop it so it is never reused.
          if (!session.destroyed) session.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(classifyConnectFailure(session, error));
      });
      session.on("close", () => {
        this.sessions.delete(key);
      });
      session.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session.alpnProtocol !== "h2") {
          session.destroy();
          reject(new Http2UnsupportedError("server did not negotiate HTTP/2"));
          return;
        }
        // Idle keep-alive sessions must not keep the process alive.
        session.unref();
        this.registerSession(key, { session, address: resolvedAddress, lastUsed: Date.now() });
        resolve(session);
      });
    });
  }

  private registerSession(key: string, entry: CachedSession): void {
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) {
        const victim = this.sessions.get(oldest);
        this.sessions.delete(oldest);
        victim?.session.close();
      }
    }
    this.sessions.set(key, entry);
  }

  private async request(
    session: http2.ClientHttp2Session,
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

    const headers: Record<string, string | number> = {};
    new Headers(init.headers).forEach((value, key) => {
      if (FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())) return;
      headers[key] = value;
    });
    const body = await this.encodeBody(init);
    if (body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] =
        typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
    }
    headers[":method"] = init.method ?? "GET";
    headers[":path"] = `${url.pathname}${url.search}`;
    headers[":authority"] = url.host;
    headers[":scheme"] = "https";

    const stream = session.request(headers, { endStream: body === undefined });

    return await new Promise<Response>((resolve, reject) => {
      let responded = false;
      const onAbort = (): void => {
        if (stream.destroyed) return;
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("response", (responseHeaders) => {
        responded = true;
        // Keep the abort listener for the whole body: removing it here
        // would leave mid-body aborts to implicit toWeb cancel propagation,
        // while H1 tears the socket down deterministically via signal.
        const status = Number(responseHeaders[":status"] ?? 502);
        const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
        resolve(
          new Response(webStream, {
            status,
            headers: stripResponseHeaders(
              responseHeaders as Record<string, string | string[] | undefined>,
            ),
          }),
        );
      });
      stream.on("error", (error) => {
        cleanup();
        // A response already streamed to the caller cannot be replaced.
        if (responded) return;
        reject(new Http2ConnectionError(error.message));
      });
      stream.on("close", () => {
        cleanup();
        if (!responded) reject(new Http2ConnectionError("http2 stream closed before response"));
      });

      if (body !== undefined) stream.end(body);
    });
  }

  private async encodeBody(init: RequestInit): Promise<string | Buffer | undefined> {
    if (init.body === undefined || init.body === null) return undefined;
    if (typeof init.body === "string") return init.body;
    return Buffer.from(await new Response(init.body).arrayBuffer());
  }
}

/** Process-wide fetcher shared by every validated direct egress closure. */
export const http2PinnedFetcher = new Http2PinnedFetcher();

import { createCartethyiaRuntime, runProxyRequest, type CartethyiaRuntime } from "./app/composition";
import { lookupProxyEndpoint, readBoundedJson } from "./open-sse/translate";
import type { ModelMetadata, ProxyEndpoint } from "./domain/contracts";
import type { ResolvedModelMetadata } from "./domain/model-metadata";
import { isRouteAllowed } from "./console/key-acl";
import type { ApiKeyPublic } from "./storage";
import { appendTerminalError } from "./open-sse/shaping";
import { resolveConsoleStatic, applySecurityHeaders } from "./console/static";
import { runtimeRecordFromJson, runtimeSettings } from "./console/runtime-settings";
import { runtimeMemoryLimits } from "./traffic/limits";
import { encodeSurfaceStream } from "./providers/surfaces";
import { clientIp } from "./console/services";
import { activePerIpFlights } from "./traffic/per-ip";
import { SlidingWindowRateLimiter } from "./traffic/rate-limiter";
import { terminalWebSocket, isTerminalUpgradeRequest, type TerminalWsData } from "./console/terminal-ws";
import { guardConsoleRequest } from "./console/session";

const port = Number(Bun.env.PORT ?? "12800");
const perIpFlights = activePerIpFlights;

/** In-memory IP ban set — refreshed from DB on a TTL and on console mutations. */
let bannedIpsCache: ReadonlySet<string> = new Set();
let bannedIpsCacheAt = 0;
const BANNED_IPS_TTL_MS = 5_000;

async function refreshBannedIps(runtime: CartethyiaRuntime): Promise<void> {
  bannedIpsCache = await runtime.config.ipBans.bannedSet();
  bannedIpsCacheAt = Date.now();
}

function isIpBanned(ip: string): boolean {
  return bannedIpsCache.has(ip);
}

/** Cached /v1/models catalog — rebuilt only when the catalog shape changes. */
interface CatalogEntry {
  readonly id: string;
  readonly owned_by: string;
  readonly metadata: ModelMetadata | ResolvedModelMetadata | null;
}
interface CatalogCache {
  readonly revision: number;
  readonly entries: readonly CatalogEntry[];
}
let catalogCache: CatalogCache | null = null;

function catalogRevision(runtime: CartethyiaRuntime): number {
  // Simple generation counter: sum of adapter count + alias count + combo count.
  // Any add/remove/update changes at least one of these.
  return runtime.registry.size + runtime.config.aliases.list().length + runtime.config.combos.list().length;
}

async function buildCatalog(runtime: CartethyiaRuntime): Promise<readonly CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const adapter of runtime.registry.list()) {
    for (const model of adapter.models.list) {
      const id = model.id.startsWith(`${adapter.metadata.id}/`) ? model.id : `${adapter.metadata.id}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, owned_by: adapter.metadata.id, metadata: runtime.models.lookup(adapter.metadata.id, model.id) });
    }
  }
  const namedRefs = [
    ...runtime.config.aliases.list().map((alias) => alias.alias),
    ...runtime.config.combos.list().map((combo) => combo.name),
  ];
  const unseen = namedRefs.filter((name) => !seen.has(name));
  const resolved = await Promise.all(unseen.map((name) => runtime.models.resolve(name)));
  for (let i = 0; i < unseen.length; i++) {
    const name = unseen[i];
    if (name === undefined) continue;
    const result = resolved[i];
    if (result === undefined || result === null) continue;
    const owner = result.targets[0]?.providerId ?? "alias";
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ id: name, owned_by: owner, metadata: result });
  }
  return entries;
}

function requestToken(request: Request): string | null {
  const bearer = request.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim() || null;
  return request.headers.get("x-api-key");
}

function splitAcl(value: string | null): readonly string[] | null {
  if (value === null || value.trim() === "") return null;
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Parsed ACL fields cached per ApiKeyPublic so the hot path parses once per key, not per request. */
interface CachedAcl {
  readonly providerAllowlist: readonly string[] | null;
  readonly modelAllowlist: readonly string[] | null;
  readonly modelDenylist: readonly string[] | null;
}

const aclCache = new WeakMap<ApiKeyPublic, CachedAcl>();

function aclFor(key: ApiKeyPublic): CachedAcl {
  let cached = aclCache.get(key);
  if (cached === undefined) {
    cached = {
      providerAllowlist: splitAcl(key.providerAllowlist),
      modelAllowlist: splitAcl(key.modelAllowlist),
      modelDenylist: splitAcl(key.modelDenylist),
    };
    aclCache.set(key, cached);
  }
  return cached;
}

/** Stable error codes for the proxy data plane — shared with the public error body. */
type ProxyErrorCode =
  | "invalid_request"
  | "authentication_failed"
  | "authorization_denied"
  | "rate_limit_error"
  | "request_too_large"
  | "not_found"
  | "internal_error"
  | "model_not_found"
  | "provider_unavailable"
  | "uri_too_long";

function errorResponse(status: number, code: ProxyErrorCode, message: string, requestId = crypto.randomUUID()): Response {
  return Response.json({ error: { type: "error", code, message, request_id: requestId } }, { status, headers: { "cache-control": "no-store", "x-request-id": requestId } });
}

async function readImageEditMultipart(request: Request): Promise<unknown | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > runtimeMemoryLimits.requestBodyBytes) return errorResponse(413, "request_too_large", `Request body exceeds ${runtimeMemoryLimits.requestBodyBytes} bytes`);
  try {
    const form = await request.formData();
    const model = form.get("model");
    const prompt = form.get("prompt");
    if (typeof model !== "string" || typeof prompt !== "string") return errorResponse(400, "invalid_request", "Image edit form requires model and prompt fields");
    const files = [...form.getAll("image"), ...form.getAll("images")].filter((value) => typeof value !== "string");
    const images = await Promise.all(files.map(async (value) => {
      const file = value as unknown as { readonly type?: string; arrayBuffer: () => Promise<ArrayBuffer> };
      return `data:${file.type || "application/octet-stream"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
    }));
    return { model, prompt, images };
  } catch {
    return errorResponse(400, "invalid_request", "Image edit body must be valid multipart form data");
  }
}

async function readProxyBody(request: Request, endpoint: ProxyEndpoint): Promise<unknown | Response> {
  if (endpoint === "/v1/images/edits" && request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) return readImageEditMultipart(request);
  const parsedBody = await readBoundedJson(request, runtimeMemoryLimits.requestBodyBytes);
  if (!parsedBody.ok) {
    if (parsedBody.reason === "too_large") return errorResponse(413, "request_too_large", `Request body exceeds ${runtimeMemoryLimits.requestBodyBytes} bytes`);
    return errorResponse(400, "invalid_request", "Request body must be valid JSON");
  }
  return parsedBody.value;
}

/** Cached slice of runtime settings for the proxy data plane — invalidated when the settings JSON object identity changes. */
let cachedProxySettings: { maxFlightsPerIp: number; trustProxy: boolean } | null = null;
let cachedProxySettingsJson: Record<string, unknown> | null = null;

function proxyRuntimeSettings(runtime: CartethyiaRuntime): { maxFlightsPerIp: number; trustProxy: boolean } {
  const json = runtime.config.settings.getSettingsJson();
  if (cachedProxySettings !== null && json === cachedProxySettingsJson) return cachedProxySettings;
  const settings = runtimeSettings(runtime.config);
  cachedProxySettings = { maxFlightsPerIp: settings.maxFlightsPerIp, trustProxy: settings.trustProxy };
  cachedProxySettingsJson = json;
  return cachedProxySettings;
}

/** Hard cap on concurrent in-flight proxy requests to bound resource use under load. */
const MAX_GLOBAL_IN_FLIGHT = 500;

function recordAccessLog(runtime: CartethyiaRuntime, pathname: string, request: Request, requestId: string, status: number, startedAt: number): void {
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  runtime.runtime.consoleLogs.push(level, "http", `${request.method} ${pathname} ${status} ${Math.max(0, performance.now() - startedAt).toFixed(1)}ms request_id=${requestId}`);
}

async function main(): Promise<void> {
  const runtime = await createCartethyiaRuntime();
  const rateLimiter = new SlidingWindowRateLimiter(runtimeMemoryLimits.rateLimitMaxRequests, runtimeMemoryLimits.rateLimitWindowMs);
  let globalInFlight = 0;
  const server = Bun.serve({
    port,
    websocket: terminalWebSocket,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      // Fast reject: absurdly long paths never reach routing or filesystem I/O.
      if (url.pathname.length > 2048) return errorResponse(414, "uri_too_long", "URI too long");
      // Terminal WebSocket upgrade — verify console session before upgrading
      if (isTerminalUpgradeRequest(request)) {
        const snapshot = runtime.config.settings.get();
        if (snapshot === null) {
          return errorResponse(503, "internal_error", "Console settings not initialized.");
        }
        const verdict = await guardConsoleRequest(request, {
          jwtSecret: snapshot.jwtSecret ?? "",
          passwordVersion: snapshot.passwordVersion,
          trustProxy: runtimeRecordFromJson(snapshot.settingsJson).trustProxy === true,
        });
        if (!verdict.ok) {
          const code: ProxyErrorCode = verdict.code === "forbidden" ? "authorization_denied" : "authentication_failed";
          return errorResponse(verdict.status, code, verdict.message);
        }
        const ok = server.upgrade(request, { data: { ws: undefined } as unknown as TerminalWsData });
        if (ok) return new Response(null, { status: 101 });
        return errorResponse(400, "invalid_request", "WebSocket upgrade failed.");
      }
      if (url.pathname === "/") {
        return Response.redirect(new URL("/console/login", request.url).toString(), 302);
      }
      if (url.pathname === "/health") return Response.json({ status: "ok", providers: runtime.registry.size });
      if (url.pathname.startsWith("/console/api/") || url.pathname === "/console/api") return safeConsoleHandle(runtime, request);
      if (url.pathname === "/v1/models" && request.method === "GET") {
        const token = requestToken(request);
        const key = token === null ? null : runtime.config.apiKeys.getBySecret(token);
        if (key === null) return errorResponse(401, "authentication_failed", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy.");
        const acl = aclFor(key);
        const revision = catalogRevision(runtime);
        if (catalogCache === null || catalogCache.revision !== revision) {
          catalogCache = { revision, entries: await buildCatalog(runtime) };
        }
        const data = catalogCache.entries
          .filter((entry) => isRouteAllowed(entry.owned_by, entry.id, acl))
          .map((entry) => ({ id: entry.id, object: "model" as const, owned_by: entry.owned_by, metadata: entry.metadata }));
        return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store" } });
      }
      const route = lookupProxyEndpoint(url.pathname);
      if (route === null || request.method !== "POST") {
        // Fast reject: only attempt static file resolution for genuine console asset paths.
        // Unknown/random paths skip filesystem I/O entirely and return 404 immediately.
        if (url.pathname.startsWith("/console/") && !url.pathname.startsWith("/console/api/")) {
          const resolution = await resolveConsoleStatic(url.pathname, (file) => Bun.file(file).exists());
          if (resolution.kind !== "not-found") {
            const asset = Bun.file(resolution.file);
            if (await asset.exists()) {
              const headers = new Headers(resolution.kind === "entry" ? { "content-type": "text/html; charset=utf-8" } : undefined);
              applySecurityHeaders(headers, request);
              return new Response(asset, { headers });
            }
            if (resolution.kind === "entry") return errorResponse(404, "not_found", "Console entry not found");
          }
        }
        return errorResponse(404, "not_found", "Route not found");
      }
      const requestId = crypto.randomUUID();
      const startedAt = performance.now();
      const token = requestToken(request);
      const key = token === null ? null : runtime.config.apiKeys.getBySecret(token);
      if (key === null) {
        const response = errorResponse(401, "authentication_failed", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy.", requestId);
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      // Global concurrency guard: reject when at capacity so 10k concurrent requests
      // can't exhaust resources. Authenticated requests are counted; unauthenticated
      // ones bail above and don't consume a slot.
      if (globalInFlight >= MAX_GLOBAL_IN_FLIGHT) {
        const response = errorResponse(429, "rate_limit_error", "Server is at capacity. Try again shortly.", requestId);
        response.headers.set("retry-after", "5");
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      globalInFlight++;
      const parsedBody = await readProxyBody(request, route.endpoint);
      if (parsedBody instanceof Response) {
        globalInFlight--;
        recordAccessLog(runtime, url.pathname, request, requestId, parsedBody.status, startedAt);
        return parsedBody;
      }
      const body = parsedBody;
      const bodyRecord = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const settings = proxyRuntimeSettings(runtime);
      const ip = clientIp(request, settings.trustProxy);
      if (Date.now() - bannedIpsCacheAt > BANNED_IPS_TTL_MS) void refreshBannedIps(runtime);
      if (isIpBanned(ip)) {
        globalInFlight--;
        const response = errorResponse(403, "authorization_denied", "Your IP address has been banned.", requestId);
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      const rateLimit = rateLimiter.tryAcquire(ip);
      if (!rateLimit.allowed) {
        globalInFlight--;
        const response = errorResponse(429, "rate_limit_error", "Rate limit exceeded. Try again shortly.", requestId);
        response.headers.set("retry-after", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      const flight = perIpFlights.tryAcquire(ip, settings.maxFlightsPerIp);
      if (flight === null) {
        globalInFlight--;
        const response = errorResponse(429, "rate_limit_error", "Too many concurrent requests from this IP. Try again shortly.", requestId);
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      let released = false;
      const release = (status: number): void => {
        if (released) return;
        released = true;
        globalInFlight--;
        flight.release();
        recordAccessLog(runtime, url.pathname, request, requestId, status, startedAt);
      };
      try {
        const presented = await runProxyRequest(
          { request: { requestId, endpoint: route.endpoint, surface: route.surface, headers: request.headers, body, signal: request.signal, clientIp: ip }, authorization: { apiKeyId: key.id, apiKey: key, trustedIdentity: null, ...aclFor(key) } },
          runtime.proxy,
        );
        runtime.config.apiKeys.touch(key.id);
        const bodyResponse = presented.body;
        if (bodyResponse.mode === "json") {
          release(presented.status);
          const headers = new Headers(presented.headers);
          headers.set("x-request-id", requestId);
          return Response.json(bodyResponse.value, { status: presented.status, headers });
        }
        const requestedModel = typeof bodyRecord.model === "string" ? bodyRecord.model : "unknown";
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const chunk of encodeSurfaceStream(route.surface, appendTerminalError(bodyResponse.events), requestedModel)) controller.enqueue(chunk);
              controller.close();
            } catch {
              controller.close();
            } finally {
              release(presented.status);
            }
          },
          cancel() {
            release(presented.status);
          },
        });
        const headers = new Headers(presented.headers);
        headers.set("x-request-id", requestId);
        return new Response(stream, { status: presented.status, headers });
      } catch (error) {
        release(500);
        throw error;
      }
    },
  });
  console.log(`[cartethyia] listening on ${server.url}`);
  const close = (): void => { runtime.close(); server.stop(); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

async function safeConsoleHandle(runtime: CartethyiaRuntime, request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  // Fast body-size rejection: a single header parse, no crypto or DB work.
  // Restore endpoints allow up to MAX_BACKUP_BYTES (64 MiB — sidebar icon
  // data URLs alone can reach ~36 MiB). All other console routes cap at 5 MiB.
  const contentLength = request.headers.get("content-length");
  const isRestorePath = pathname === "/console/api/settings/restore" || pathname === "/console/api/settings/restore/9router";
  const maxBodyBytes = isRestorePath ? 64 * 1024 * 1024 : 5_000_000;
  if (contentLength !== null && Number(contentLength) > maxBodyBytes) {
    return errorResponse(413, "request_too_large", "Request body too large");
  }

  // Fast auth check before Elysia parses the body. Elysia's lifecycle parses
  // the request body BEFORE .guard({ beforeHandle }) runs, so under a flood of
  // unauthenticated requests the JSON parser burns CPU on bodies that are
  // immediately rejected by the session guard. Login is the only public
  // mutating endpoint — it must receive the password, so it bypasses this
  // pre-check. The Elysia .guard() remains as defense-in-depth for every
  // other route. When settings aren't initialized yet (snapshot === null)
  // there is no JWT secret or password version to validate against, so we
  // skip the pre-check and let Elysia's own guard handle it after bootstrap.
  const isLogin = pathname === "/console/api/login";
  if (!isLogin) {
    const snapshot = runtime.config.settings.get();
    if (snapshot !== null) {
      const verdict = await guardConsoleRequest(request, {
        jwtSecret: snapshot.jwtSecret ?? "",
        passwordVersion: snapshot.passwordVersion,
        trustProxy: runtimeRecordFromJson(snapshot.settingsJson).trustProxy === true,
      });
      if (!verdict.ok) {
        const code: ProxyErrorCode = verdict.code === "forbidden" ? "authorization_denied" : "authentication_failed";
        return errorResponse(verdict.status, code, verdict.message);
      }
    }
  }

  // Auth verified (or bypassed for login) — now safe to let Elysia parse the body.
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  try {
    const response = await runtime.consoleApp.handle(request);
    recordAccessLog(runtime, pathname, request, requestId, response.status, startedAt);
    return response;
  } catch (error) {
    runtime.runtime.consoleLogs.push("error", "console", `${request.method} ${pathname} failed request_id=${requestId} error=${error instanceof Error ? error.name : "unknown"}`);
    return errorResponse(500, "internal_error", `Console ${request.method} request to ${pathname} failed`, requestId);
  }
}

void main();

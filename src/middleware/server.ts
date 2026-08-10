import { createCartethyiaRuntime, runProxyRequest, type CartethyiaRuntime } from "../bootstrap/composition";
import { lookupProxyEndpoint } from "../open-sse/translate";
import { isRouteAllowed } from "../security/access";
import { appendTerminalError } from "../open-sse/handlers";
import { resolveConsoleStatic, resolveLandingStatic, applySecurityHeaders } from "../console/static";
import { applySecurityHeaders as applyCommonSecurityHeaders, secureResponse } from "../security/headers";
import { runtimeSettings } from "../console/runtime-settings";
import { runtimeMemoryLimits } from "../traffic/limits";
import { encodeSurfaceStream } from "../providers/surfaces";
import { clientIp } from "../console/services/composition";
import { activePerIpFlights } from "../traffic/per-ip";
import { SlidingWindowRateLimiter } from "../traffic/rate-limiter";
import { safeConsoleHandle } from "./console";
import { aclFor, buildCatalog, catalogRevision, hasConflictingCredentials, readProxyBody, requestToken, type CatalogEntry } from "./proxy";
import { errorResponse, recordAccessLog } from "./shared";
import { handleShareRequest } from "../console/share";
import { translateLegacyGet } from "./query";
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
async function recordSecurityEvent(runtime: CartethyiaRuntime, requestId: string, ip: string, category: string): Promise<void> {
  const decision = await runtime.config.ipBans.recordOffense?.(ip, category);
  runtime.logger.web("warn", JSON.stringify({
    event: "security_event",
    category,
    ip,
    request_id: requestId,
    strike_count: decision?.strikeCount ?? null,
    threshold_reached: decision?.thresholdReached ?? false,
  }));
  if (decision?.thresholdReached) await refreshBannedIps(runtime);
}
let catalogCache: { readonly revision: number; readonly entries: readonly CatalogEntry[] } | null = null;
let catalogBuildPromise: Promise<{ readonly revision: number; readonly entries: readonly CatalogEntry[] }> | null = null;

async function buildStableCatalog(runtime: CartethyiaRuntime): Promise<{ readonly revision: number; readonly entries: readonly CatalogEntry[] }> {
  while (true) {
    const revision = catalogRevision(runtime);
    const entries = await buildCatalog(runtime);
    if (catalogRevision(runtime) === revision) return { revision, entries };
  }
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

/** Separate console cap prevents dashboard polling from consuming proxy slots. */
const MAX_CONSOLE_IN_FLIGHT = 64;
const MAX_GLOBAL_IN_FLIGHT = 500;
const PUBLIC_V1_HEALTH_BODY = [
  "          .     .",
  "       .  /|\\ . /|\\  .",
  "        \\-***-/-***-/",
  "       .-'  .---.  '-.",
  "      /    / o o \\    \\",
  "     ;    |   ^   |    ;",
  "     |     \\ '-' /     |",
  "     ;      '---'      ;",
  "      \\    CARTETHYIA /",
  "       '.           .'",
  "         '-._____.-'",
  "          IS SERVING",
  "",
  "Endpoints:",
  "POST /v1/chat/completions",
  "POST /v1/responses",
  "POST /v1/messages",
  "POST /v1/images/generations",
  "POST /v1/images/edits",
  "QUERY /v1/models",
].join("\n");
let consoleInFlight = 0;

export async function startServer(): Promise<void> {
  const runtime = await createCartethyiaRuntime();
  await refreshBannedIps(runtime);
  const rateLimiter = new SlidingWindowRateLimiter(runtimeMemoryLimits.rateLimitMaxRequests, runtimeMemoryLimits.rateLimitWindowMs);
  let globalInFlight = 0;
  const server = Bun.serve({
    port,
    idleTimeout: 30,
    async fetch(request, server): Promise<Response> {
      request = translateLegacyGet(request);
      const url = new URL(request.url);
      // Fast reject: absurdly long paths never reach routing or filesystem I/O.
      if (url.pathname.length > 2048) return errorResponse(414, "uri_too_long", "URI too long");
      if (url.pathname === "/health" && request.method === "GET") {
        return secureResponse(new Response(`${PUBLIC_V1_HEALTH_BODY}\n`, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        }), { request, noStore: true });
      }
      if (url.pathname === "/") {
        const resolution = await resolveLandingStatic(url.pathname, async (file) => Bun.file(file).exists());
        if (resolution.kind === "entry") {
          const asset = Bun.file(resolution.file);
          if (!(await asset.exists())) return errorResponse(404, "not_found", "Landing entry not found");
          const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
          applySecurityHeaders(headers, request);
          return new Response(asset, { headers });
        }
        return errorResponse(404, "not_found", "Landing entry not found");
      }
      if (url.pathname === "/v1/models" && request.method === "QUERY") {
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
          return errorResponse(415, "invalid_request", "QUERY requests require Content-Type: application/json");
        }
        server.timeout(request, 0);
        if (hasConflictingCredentials(request)) return errorResponse(400, "invalid_request", "Use exactly one API credential header.");
        const token = requestToken(request);
        const key = token === null ? null : runtime.config.apiKeys.getBySecret(token);
        if (key === null) return errorResponse(401, "authentication_failed", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy.");
        const acl = aclFor(key);
        const revision = catalogRevision(runtime);
        if (catalogCache === null || catalogCache.revision !== revision) {
          if (catalogBuildPromise === null) {
            const pending = buildStableCatalog(runtime);
            catalogBuildPromise = pending;
            void pending.then(
              () => {
                if (catalogBuildPromise === pending) catalogBuildPromise = null;
              },
              () => {
                if (catalogBuildPromise === pending) catalogBuildPromise = null;
              },
            );
          }
          catalogCache = await catalogBuildPromise;
        }
        const data = catalogCache.entries
          .filter((entry) => isRouteAllowed(entry.owned_by, entry.id, acl))
          .map((entry) => ({ id: entry.id, object: "model" as const, owned_by: entry.owned_by, metadata: entry.metadata }));
        const response = Response.json({ object: "list", data }, { headers: { "cache-control": "no-store", "accept-query": "application/json" } });
        return secureResponse(response, { request, noStore: true });
      }
      if (url.pathname === "/console/api" || url.pathname.startsWith("/console/api/")) {
        if (url.pathname.endsWith("/stream")) server.timeout(request, 0);
        if (consoleInFlight >= MAX_CONSOLE_IN_FLIGHT) {
          const response = errorResponse(429, "rate_limit_error", "Console is busy. Try again shortly.");
          response.headers.set("retry-after", "1");
          return response;
        }
        consoleInFlight += 1;
        try {
          return await safeConsoleHandle(runtime, request);
        } finally {
          consoleInFlight -= 1;
        }
      }
      const shareResponse = await handleShareRequest(runtime.config, runtime.runtime, request);
      if (shareResponse !== null) return shareResponse;
      const route = lookupProxyEndpoint(url.pathname);
      if (route !== null && request.method === "POST") server.timeout(request, 0);
      if (route === null || request.method !== "POST") {
        // Fast reject: only attempt static file resolution for known public and console asset paths.
        // Unknown/random paths skip filesystem I/O entirely and return 404 immediately.
        if ((url.pathname === "/console" || url.pathname.startsWith("/console/")) && !url.pathname.startsWith("/console/api/")) {
          const resolution = await resolveConsoleStatic(url.pathname, async (file) => Bun.file(file).exists());
          if (resolution.kind !== "not-found") {
            const asset = Bun.file(resolution.file);
            if (resolution.kind === "entry" && !(await asset.exists())) return errorResponse(404, "not_found", "Console entry not found");
            const headers = new Headers(resolution.kind === "entry" ? { "content-type": "text/html; charset=utf-8" } : undefined);
            applySecurityHeaders(headers, request);
            return new Response(asset, { headers });
          }
        }
        const landingResolution = await resolveLandingStatic(url.pathname, async (file) => Bun.file(file).exists());
        if (landingResolution.kind !== "not-found") {
          const asset = Bun.file(landingResolution.file);
          if (landingResolution.kind === "entry" && !(await asset.exists())) return errorResponse(404, "not_found", "Landing entry not found");
          const headers = new Headers(landingResolution.kind === "entry" ? { "content-type": "text/html; charset=utf-8" } : undefined);
          applySecurityHeaders(headers, request);
          return new Response(asset, { headers });
        }
        return errorResponse(404, "not_found", "Route not found");
      }
      const requestId = crypto.randomUUID();
      const startedAt = performance.now();
      const settings = proxyRuntimeSettings(runtime);
      const ip = clientIp(request, settings.trustProxy);
      if (hasConflictingCredentials(request)) {
        void recordSecurityEvent(runtime, requestId, ip, "ambiguous_credentials");
        const response = errorResponse(400, "invalid_request", "Use exactly one API credential header.", requestId);
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      const token = requestToken(request);
      const key = token === null ? null : runtime.config.apiKeys.getBySecret(token);
      if (key === null) {
        void recordSecurityEvent(runtime, requestId, ip, "invalid_api_key");
        const response = errorResponse(401, "authentication_failed", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy.", requestId);
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      if (Date.now() - bannedIpsCacheAt > BANNED_IPS_TTL_MS) void refreshBannedIps(runtime);
      if (isIpBanned(ip)) {
        const response = errorResponse(403, "authorization_denied", "Your IP address has been banned.", requestId);
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      if (globalInFlight >= MAX_GLOBAL_IN_FLIGHT) {
        void recordSecurityEvent(runtime, requestId, ip, "rate_limit");
        const response = errorResponse(429, "rate_limit_error", "Server is at capacity. Try again shortly.", requestId);
        response.headers.set("retry-after", "5");
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      globalInFlight++;
      const parsedBody = await readProxyBody(request, route.endpoint);
      if (parsedBody instanceof Response) {
        globalInFlight--;
        if (parsedBody.status === 413) void recordSecurityEvent(runtime, requestId, ip, "request_too_large");
        recordAccessLog(runtime, url.pathname, request, requestId, parsedBody.status, startedAt);
        return parsedBody;
      }
      const body = parsedBody;
      const bodyRecord = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const rateLimit = rateLimiter.tryAcquire(ip);
      if (!rateLimit.allowed) {
        globalInFlight--;
        void recordSecurityEvent(runtime, requestId, ip, "rate_limit");
        const response = errorResponse(429, "rate_limit_error", "Rate limit exceeded. Try again shortly.", requestId);
        response.headers.set("retry-after", String(Math.ceil(rateLimit.retryAfterMs / 1000)));
        recordAccessLog(runtime, url.pathname, request, requestId, response.status, startedAt);
        return response;
      }
      const flight = perIpFlights.tryAcquire(ip, settings.maxFlightsPerIp);
      if (flight === null) {
        globalInFlight--;
        void recordSecurityEvent(runtime, requestId, ip, "rate_limit");
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
          const headers = new Headers(presented.headers);
          headers.set("x-request-id", requestId);
          applyCommonSecurityHeaders(headers, { request, noStore: true });
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
        applyCommonSecurityHeaders(headers, { request, noStore: true });
        return new Response(stream, { status: presented.status, headers });
      } catch (error) {
        release(500);
        throw error;
      }
    },
  });
  const configuredProviders = new Set(runtime.config.accounts.list().map((account) => account.provider));
  void runtime.registry.prewarm([...configuredProviders]);
  console.log(`[cartethyia] listening on ${server.url}`);
  const close = (): void => { runtime.close(); server.stop(); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}



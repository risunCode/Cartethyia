// HTTP ingress policy, authentication, lifecycle, and request context hooks.
import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { GatewayError, explainGatewayError, publicGatewayErrorDetails } from "../gateway-error";
import { resolveClientIdentity } from "../../security/ip-boundary";
import { resolveUpstreamTimeoutMs } from "../../config";
import type { TrustedProxyBoundary } from "../../config";
import type { ProxyRequestState, ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../request/pathname";
import type { ProxyRequestPreparer } from "../request/preparer";
import type { CanonicalRequest } from "../canonical-model";
import type { SurfaceAdapterRegistry } from "../surface/adapters";
import { requestToken, resolveApiKeyAuthorization } from "../../security/api-key-auth";
import { createAccessDecision } from "../../security/access-control";
import { GATEWAY_SECURITY_HEADERS } from "../../security/outbound-headers";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { parseCookieValue, SESSION_COOKIE_NAME, isCsrfValid } from "../../security/csrf";
import type { IpAbuseProtectionService } from "../../security/abuse";
import type { ReadinessCheckResult } from "../../persistence/readiness";
import type { TelemetryBatchBuffer, TelemetryEventInput } from "../../observability/telemetry-buffer";
import { metrics } from "../../observability/metrics";
import { computeTokensPerSec } from "../../observability/token-speed";
import { pushStructuredConsoleLog } from "../../observability/log-ring";
import type { ConsoleLogLevel, ConsoleLogMetadata } from "../../observability/log-ring";

interface RequestApp {
  request(
    handler: (context: { request: Request; set?: { headers: Record<string, string> } }) => void,
  ): RequestApp;
}

export interface RequestContextDeps {
  readonly stateStore: ProxyRequestStateStore;
  readonly clock?: () => number;
  /** Explicit deadline override; defaults to `CARTETHYIA_UPSTREAM_TIMEOUT_MS` (120s). */
  readonly requestDeadlineMs?: number;
  readonly maxBodyBytes?: number;
}

export interface IngressPolicyOptions {
  readonly maxBodyBytes?: number;
}
function isProxyRequest(request: Request): boolean {
  return fastPathname(request.url).startsWith("/v1/");
}

/**
 * Canonical JSON proxy routes that read a body through the ingress pipeline.
 *
 * This list must mirror the routes `app.ts` actually mounts. It drives
 * body-read policy — a JSON route rejects a missing or non-JSON content-type
 * with 415, while an unrouted path is not read at all — so an entry with no
 * handler behind it describes a route the gateway does not serve. Three such
 * entries (`/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`) sat
 * here with no adapter and no handler: they advertised a surface that 404s.
 */
const PROXY_JSON_ROUTES = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/completions",
  "/v1/responses/compact",
  "/v1/messages",
] as const;

/** Whether `path` is one of the canonical JSON proxy routes. */
function isJsonProxyRoute(path: string): boolean {
  return (PROXY_JSON_ROUTES as readonly string[]).includes(path);
}

/**
 * Whether `path` is a provider-dispatching route. Discovery/surface routes
 * such as `/v1/models` are authenticated gateway routes but never dispatch, so
 * they must not be reported as proxy request lifecycle events or enqueue
 * telemetry rows.
 */
export function isProxyDispatchRoute(path: string | undefined): path is string {
  return path !== undefined && isJsonProxyRoute(path);
}

/** Reads a proxy body exactly once and enforces its encoded size and media type. */
export async function readIngressBody(
  request: Request,
  options: IngressPolicyOptions = {},
): Promise<unknown> {
  if (!isProxyRequest(request)) return undefined;
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const p = fastPathname(request.url);
  const isJsonRoute = isJsonProxyRoute(p);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType) {
    if (isJsonRoute) throw new GatewayError("invalid_request", 415, "content-type must be application/json");
    return undefined;
  }
  if (contentType !== "application/json") {
    if (isJsonRoute) throw new GatewayError("invalid_request", 415, "content-type must be application/json");
    return undefined;
  }
  const maxBytes = options.maxBodyBytes ?? 1_048_576;
  const declared = request.headers.get("content-length");
  const parsed = declared === null ? undefined : Number(declared);
  if (declared !== null && (!/^\d+$/.test(declared) || parsed === undefined || parsed > maxBytes))
    throw new GatewayError("invalid_request", 413, "request body exceeds configured limit");

  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError("invalid_request", 400, "malformed JSON request body");
  // Decode incrementally — no intermediate chunk array or contiguous buffer,
  // so the body never exists as a third full copy before parsing. The cap is
  // enforced against accumulated BYTES: `text.length` counts UTF-16 code
  // units, which undercounts multibyte UTF-8 and would let oversized bodies
  // through across chunk boundaries.
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GatewayError("invalid_request", 413, "request body exceeds configured limit");
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } finally {
    // The oversize branch above cancels the reader, and `cancel()` releases
    // the lock itself — releasing again throws ERR_INVALID_STATE, which would
    // replace the intended 413 with an opaque runtime error.
    try {
      if (request.body?.locked) reader.releaseLock();
    } catch {
      // Already released by cancel().
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    assertBoundedJsonDepth(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("invalid_request", 400, "malformed JSON request body");
  }
}

/** Maximum nesting depth accepted for an ingress JSON body. */
const MAX_JSON_DEPTH = 64;

function assertBoundedJsonDepth(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH)
    throw new GatewayError("invalid_request", 400, "request body nesting exceeds the allowed depth");
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedJsonDepth(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>))
      assertBoundedJsonDepth(item, depth + 1);
  }
}

export function createIngressPolicyMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly maxBodyBytes?: number;
}): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const state = deps.stateStore.get(request);
      if (!state) return;
      state.ingressBody = await readIngressBody(
        request,
        ...(deps.maxBodyBytes === undefined ? [] : [{ maxBodyBytes: deps.maxBodyBytes }]),
      );
    })
    .as("plugin");
}

/**
 * Initializes per-request `ProxyRequestState` before any other hook runs.
 * Only gateway (`/v1/*`) requests get state: this middleware is mounted at
 * the composition root so it also observes health checks, console traffic,
 * and dashboard assets, but none of those use proxy state and none of them
 * run the `/v1`-scoped cleanup hooks — initializing for them leaked a state,
 * a deadline timer, a live-controller entry, and an in-flight count per
 * request that was never reclaimed. Cleanup (abort + WeakMap eviction) is
 * intentionally NOT done here via `afterResponse`: Elysia's afterResponse
 * hook order across plugins is not something this composition can guarantee
 * ahead of `createTelemetryLifecycleMiddleware`'s afterResponse (now in
 * lifecycle.ts), which still needs to read the state. The WeakMap entry is
 * reclaimed by GC once `request` is unreferenced; nothing needs to run after
 * the response is sent.
 */
export function createRequestContextMiddleware(deps: RequestContextDeps): Elysia {
  const app = new Elysia() as unknown as RequestApp;
  app.request(({ request, set }) => {
    const pathname = fastPathname(request.url);
    if (pathname !== "/v1" && !pathname.startsWith("/v1/")) return;
    const state = deps.stateStore.initialize(
      request,
      (deps.clock ?? (() => Date.now()))(),
      deps.requestDeadlineMs ?? resolveUpstreamTimeoutMs(),
    );
    if (set) {
      set.headers["x-request-id"] = state.requestId;
      Object.assign(set.headers, GATEWAY_SECURITY_HEADERS);
    }
  });
  return app as unknown as Elysia;
}

export function createClientIdentityMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly trustedProxyBoundary: TrustedProxyBoundary;
  readonly resolvePeerAddress?: (request: Request) => string | null;
}): Elysia {
  // `beforeHandle`, not `onRequest`: plugin-scoped `onRequest` hooks do not
  // fire for these routes under Elysia 2 beta (same scoping gap that muted
  // plugin `afterResponse` before `registerTelemetryLifecycle`), which left
  // `clientIdentity` unset and every gateway row without a client IP.
  // `beforeHandle` hooks from `.use()` plugins run in registration order, so
  // pipeline position still guarantees this executes before IP-abuse checks.
  return new Elysia()
    .beforeHandle(({ request, server }) => {
      const peer = deps.resolvePeerAddress
        ? deps.resolvePeerAddress(request)
        : (server?.requestIP(request)?.address ?? null);
      if (!peer)
        throw new GatewayError("admission_unavailable", 503, "client peer address unavailable");
      const address = resolveClientIdentity(request, deps.trustedProxyBoundary, peer);
      const state = deps.stateStore.require(request);
      state.clientIdentity = {
        address,
        source: address === peer ? "tcp-peer" : "trusted-forwarded-header",
      };
      const path = state.ingressPath;
      if (!isProxyDispatchRoute(path)) return;
      // The ingress policy stage already decoded the body, so the client's
      // requested model is readable here — before canonical parsing runs. It is
      // read defensively and only for display: routing still resolves the model
      // through the surface adapter, and a body that is not an object simply
      // yields no model rather than failing the request.
      const body = state.ingressBody;
      const requestedModel =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)["model"]
          : undefined;
      const userAgent = request.headers.get("user-agent");
      pushStructuredConsoleLog("info", "Incoming proxy request", {
        event: "request_start",
        requestId: state.requestId,
        method: request.method,
        endpoint: path,
        clientIp: address,
        ...(typeof requestedModel === "string" && requestedModel.length > 0
          ? { model: requestedModel }
          : {}),
        ...(userAgent === null || userAgent.length === 0
          ? {}
          : { userAgent: userAgent.slice(0, 512) }),
      });
    })
    .as("plugin");
}

export interface CanonicalAdapter {
  parse(input: { body: unknown; headers: Record<string, string>; path: string }): CanonicalRequest;
}
export function createCanonicalRequestMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly surfaceRegistry: SurfaceAdapterRegistry;
  readonly adapters: ReadonlyMap<string, CanonicalAdapter>;
}): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (!path.startsWith("/v1/")) return;
      if (request.method === "GET" || request.method === "HEAD") return;
      // `/v1/completions` needs no separate arm: it is already in
      // `PROXY_JSON_ROUTES`, so `isJsonProxyRoute` covers it.
      if (!isJsonProxyRoute(path) || path === "/v1/responses/compact") return;
      // Model discovery and other GET/multimodal routes must not go through canonical parsing.
      const state = deps.stateStore.require(request);
      // Single-read invariant: the ingress policy middleware already decoded the
      // body once into `state.ingressBody`. Never re-read `request.body` here —
      // it is already consumed/locked. `undefined` means the ingress stage did
      // not run (reduced composition); fail closed. An explicit `null` (JSON
      // literal `null` body) is a valid single-read value and flows to the
      // surface adapter's parse error rather than triggering a second read.
      if (state.ingressBody === undefined)
        throw new GatewayError("admission_unavailable", 503, "proxy request context unavailable");
      const body = state.ingressBody;
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const detection = deps.surfaceRegistry.detectOnce({ body, headers, path });
      const adapter = deps.adapters.get(detection.surface);
      if (!adapter)
        throw new GatewayError(
          "capability_unsupported",
          400,
          `Surface adapter unavailable: ${detection.surface}`,
          { surface: detection.surface },
        );
      const ingress = deps.stateStore.require(request);
      const userAgent = headers["user-agent"];
      if (userAgent) ingress.clientUserAgent = userAgent.slice(0, 512);
      ingress.canonicalRequest = adapter.parse({ body, headers, path });
    })
    .as("plugin");
}

export function createProxyRoutePreparationMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly preparer: ProxyRequestPreparer;
}): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (!path.startsWith("/v1/")) return;
      if (request.method === "GET" || request.method === "HEAD") return;
      const isJsonRoute = isJsonProxyRoute(path);
      if (!isJsonRoute || path === "/v1/responses/compact") return;
      const state = deps.stateStore.require(request);
      if (!state.authorization || !state.canonicalRequest)
        throw new GatewayError("admission_unavailable", 503, "proxy request context unavailable");
      state.preparedRequest = await deps.preparer.prepare({
        canonicalRequest: state.canonicalRequest,
        authorization: state.authorization,
        deadlineMs: state.deadlineMs,
        signal: state.abortController.signal,
      });
    })
    .as("plugin");
}


/**
 * Stateless Elysia `beforeHandle` gateway checks: API-key authentication,
 * console CSRF, dependency readiness, and IP-abuse protection — all wired
 * into the same middleware chain in `app.ts`.
 */

export function createApiKeyAuthenticationMiddleware(deps: {
  readonly db: CartethyiaDatabase;
  readonly stateStore: ProxyRequestStateStore;
}): Elysia {
  // Single policy for every `/v1/*` gateway route: authenticated, scoped to
  // `routing:invoke`, and tenant-bound (the snapshot's tenant is the only
  // tenant this key may address). The check is inline rather than routed
  // through a per-route policy table: Elysia's router already owns which
  // paths exist, so a per-route table only added a second place to keep in
  // sync.
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const pathname = fastPathname(request.url);
      if (!pathname.startsWith("/v1/")) return;
      const token = requestToken(request.headers);
      const authorization = await resolveApiKeyAuthorization(deps.db, token);
      if (!authorization)
        throw new GatewayError("invalid_request", 401, "invalid or revoked API key");
      const decision = createAccessDecision({
        id: authorization.id,
        tenantId: authorization.tenantId,
        scopes: authorization.scopes,
      });
      if (!decision.scopes.includes("routing:invoke"))
        throw new GatewayError("invalid_request", 403, "API key lacks routing:invoke scope");
      deps.stateStore.require(request).authorization = authorization;
    })
    .as("plugin");
}

/**
 * Stateless double-submit CSRF guard for unsafe `/console/api/*` mutations.
 * Compares the `x-csrf-token` header against the readable `csrf_token`
 * cookie — zero database I/O, so dashboard writes no longer pay a token
 * SELECT + UPDATE on top of the session lookup, and there is no token
 * store whose outage could masquerade as an auth failure.
 */
export function createConsoleCsrfMiddleware(): Elysia {
  const excluded = ["/auth/login", "/auth/setup", "/auth/session"];
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        !path.startsWith("/console/api/") ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
        excluded.some((suffix) => path.endsWith(suffix))
      )
        return;
      const token = parseCookieValue(request, SESSION_COOKIE_NAME);
      // No session cookie means no ambient authority to forge: logout and
      // other mutations without a session fail authentication downstream.
      // CSRF enforcement applies exactly when a session cookie is present.
      if (!token) return;
      if (!isCsrfValid(request))
        throw new GatewayError("invalid_request", 403, "CSRF validation failed");
    })
    .as("plugin");
}

/**
 * Per-session console mutation throttle: at most 240 unsafe requests per
 * 10-second sliding window per session. A stolen session cookie can
 * otherwise rewrite settings, rotate keys, or trigger restores at full
 * request rate; this bounds the blast radius while staying far above
 * legitimate bulk operations (bulk-deleting 40+ fetched models fires one
 * DELETE per model as fast as the loop runs, plus interleaved probes).
 * Keyed by session-cookie hash (never the raw secret); mutations without a
 * session fail authentication downstream and are not tracked. Exceeding
 * requests get 429 with `retry-after` instead of executing.
 */
const CONSOLE_MUTATION_LIMIT = 240;
const CONSOLE_MUTATION_WINDOW_MS = 10_000;
const CONSOLE_MUTATION_MAX_KEYS = 1024;
const consoleMutationHits = new Map<string, number[]>();

function consoleMutationKey(request: Request): string | undefined {
  const token = parseCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex");
}

function pruneConsoleMutationHits(now: number): void {
  for (const [key, hits] of consoleMutationHits) {
    while (hits.length > 0 && (hits[0] as number) <= now - CONSOLE_MUTATION_WINDOW_MS) hits.shift();
    if (hits.length === 0) consoleMutationHits.delete(key);
  }
  while (consoleMutationHits.size > CONSOLE_MUTATION_MAX_KEYS) {
    const oldest = consoleMutationHits.keys().next().value;
    if (oldest === undefined) return;
    consoleMutationHits.delete(oldest);
  }
}

export function createConsoleMutationLimiterMiddleware(): Elysia {
  const excluded = ["/auth/login", "/auth/setup", "/auth/session"];
  return new Elysia()
    .beforeHandle(async ({ request, set }) => {
      const path = fastPathname(request.url);
      if (
        !path.startsWith("/console/api/") ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
        excluded.some((suffix) => path.endsWith(suffix))
      )
        return;
      const key = consoleMutationKey(request);
      // No session cookie means no ambient authority to abuse: the request
      // fails authentication downstream. Only tracked sessions are throttled.
      if (key === undefined) return;
      const now = Date.now();
      pruneConsoleMutationHits(now);
      const hits = consoleMutationHits.get(key) ?? [];
      if (hits.length >= CONSOLE_MUTATION_LIMIT) {
        // Measured, not a literal: the wait is however long the oldest tracked
        // mutation still needs to age out of the window. A hardcoded value had
        // to be kept in step with `CONSOLE_MUTATION_WINDOW_MS` by hand.
        const oldest = hits[0];
        const retryAfterSeconds =
          oldest === undefined
            ? Math.ceil(CONSOLE_MUTATION_WINDOW_MS / 1000)
            : Math.max(1, Math.ceil((oldest + CONSOLE_MUTATION_WINDOW_MS - now) / 1000));
        set.headers["retry-after"] = String(retryAfterSeconds);
        throw new GatewayError("quota_exceeded", 429, "Console mutation rate limit exceeded");
      }
      hits.push(now);
      consoleMutationHits.set(key, hits);
    })
    .as("plugin");
}

export interface ShutdownDrainSource {
  isDraining(): boolean;
}

export interface ReadinessMiddlewareDeps {
  readonly readiness: () => Promise<ReadinessCheckResult>;
  readonly shutdownCoordinator?: ShutdownDrainSource;
}
export function createDependencyReadinessMiddleware(deps: ReadinessMiddlewareDeps): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        path === "/health" ||
        path === "/health/ready" ||
        (!path.startsWith("/v1/") && !path.startsWith("/console/api/"))
      )
        return;
      if (deps.shutdownCoordinator?.isDraining())
        throw new GatewayError("shutting_down", 503, "Service is shutting down");
      const readiness = await deps.readiness();
      if (readiness.status !== "ready")
        throw new GatewayError("platform_unavailable", 503, "Service dependencies are unavailable");
    })
    .as("plugin");
}

/**
 * Counts every `/v1/*` attempt against the per-IP ceiling, including the ones
 * that never reach a route.
 *
 * Mounted at the root through the `request` hook, deliberately not as a
 * gateway plugin stage. A plugin `beforeHandle` only runs for a request that
 * matches a registered route, and so does a root `beforeHandle` — measured:
 * 300 attempts rotating unregistered `/v1/*` paths produced zero 429s and no
 * ban, while the same attempts against a real route escalated normally. A
 * caller that has already decided to hammer the gateway could therefore pick
 * the cheapest evasion available: address a path that does not exist, or a
 * real path with the wrong method, and the counter was never touched. Only
 * the root `request` hook runs for every inbound request regardless of
 * whether anything matches it.
 *
 * The root `request` hook runs ahead of the gateway plugin's `beforeHandle`
 * chain, so the counter still executes before authentication: an
 * unauthenticated attempt is counted, and a rejected attempt keeps counting
 * toward the ban — which is the escalation path, not an exemption from it.
 * Throwing here short-circuits the request, so a banned or over-limit caller
 * is rejected before it can reach routing.
 */
export function createIpAbuseProtectionMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly ipAbuseProtection: IpAbuseProtectionService;
  readonly trustedProxyBoundary: TrustedProxyBoundary;
  readonly resolvePeerAddress?: (request: Request) => string | null;
}): Elysia {
  const app = new Elysia() as unknown as {
    request(
      handler: (context: {
        request: Request;
        server?: { requestIP(request: Request): { address: string } | null };
      }) => void | Promise<void>,
    ): unknown;
  };
  app.request(async ({ request, server }) => {
    const path = fastPathname(request.url);
    if (
      path === "/health" ||
      path === "/health/ready" ||
      // Scoped to /v1/* only: /console/api/auth/* already has its own
      // fail-closed, DB-persisted ConsoleLockoutService with a lower
      // (5-failure) threshold that always trips first — running both
      // here paid a second sequential counter per login with zero
      // effect (dual-throttler refinement pass).
      !path.startsWith("/v1/")
    )
      return;
    // The client identity is resolved here rather than read off request state:
    // this hook runs at the root, ahead of the gateway plugin's `beforeHandle`
    // chain, so `state.clientIdentity` is not populated yet. Resolving it from
    // the same boundary the identity middleware uses keeps one answer for the
    // same request, and keeps the counter independent of middleware ordering.
    const peer = deps.resolvePeerAddress
      ? deps.resolvePeerAddress(request)
      : (server?.requestIP(request)?.address ?? null);
    if (!peer)
      throw new GatewayError("admission_unavailable", 503, "client peer address unavailable");
    const address = resolveClientIdentity(request, deps.trustedProxyBoundary, peer);
    const state = deps.stateStore.get(request);
    try {
      await deps.ipAbuseProtection.checkBeforeAccess({
        identity: {
          address,
          source: address === peer ? "tcp-peer" : "trusted-forwarded-header",
        },
        route: path,
        ...(state === undefined ? {} : { signal: state.abortController.signal }),
      });
    } catch (error) {
      // No fixed `retry-after` here. The store measures the real remainder —
      // a ban's marker TTL, or the age of the oldest attempt in a rate-limited
      // window — and carries it as `retryAfterMs`, which the error
      // normalization middleware turns into the header. Assigning a constant
      // here pre-empted that hint (`retry-after` is only filled when unset) and
      // told a client facing a 60-second window to wait a full hour.
      throw error;
    }
  });
  return app as unknown as Elysia;
}


interface ElysiaBuiltinError {
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
}

/**
 * The `retry-after` value a gateway error can justify, in whole seconds, or
 * `undefined` when the failure carries no real wait evidence.
 *
 * Reads the two hints the taxonomy already populates: `retryAfterMs` (parsed
 * from upstream `Retry-After`-family headers, or a reset quoted in the
 * provider's message) and `retryAt` (an absolute instant, from an admission
 * lease or a pool cooldown). A value is never invented — an unretryable or
 * evidence-free failure gets no header at all, because a fabricated backoff is
 * worse than none: the client waits for a number nobody measured.
 */
function retryAfterSeconds(error: GatewayError | undefined): string | undefined {
  if (!error) return undefined;
  const retryAfterMs = error.details.retryAfterMs;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }
  const retryAt = error.details.retryAt;
  if (typeof retryAt === "string") {
    const target = Date.parse(retryAt);
    if (Number.isFinite(target)) {
      const delayMs = target - Date.now();
      if (delayMs > 0) return String(Math.max(1, Math.ceil(delayMs / 1000)));
    }
  }
  return undefined;
}

/**
 * Normalizes every thrown error (from any lifecycle hook or handler, on
 * `/v1/*` or `/console/api/*`) into the stable public `{ error: { code,
 * message, details? } }` JSON shape. Mounted at the composition root with
 * global scope so it covers both route groups. Elysia's own built-in errors
 * (404 not-found, 422 validation, etc.) keep their real status/code instead
 * of collapsing to a generic 400 invalid_request.
 */
export function createErrorNormalizationMiddleware(deps: {
  readonly stateStore: ProxyRequestStateStore;
  readonly hsts?: boolean;
}): Elysia {
  const app = new Elysia()
    .error(({ request, error, set }) => {
      const state = deps.stateStore.get(request as Request);
      const gateway = error instanceof GatewayError ? error : undefined;
      const builtin =
        !gateway && typeof error === "object" && error !== null
          ? (error as ElysiaBuiltinError)
          : undefined;
      const status =
        gateway?.status ?? (typeof builtin?.status === "number" ? builtin.status : 400);
      const code = gateway?.code ?? builtin?.code ?? "invalid_request";
      const rawMessage = gateway?.message ?? builtin?.message ?? "Unable to process request";
      const message =
        gateway?.origin === "upstream"
          ? explainGatewayError(gateway)
          : rawMessage.startsWith("Cartethyia Error:")
            ? rawMessage
            : `Cartethyia Error: ${rawMessage}`;
      const origin = gateway?.origin ?? "cartethyia";
      // `afterResponse` telemetry hook can enqueue it even when the request
      // never reached canonical parse / auth / preparation.
      if (state && !state.outcome) {
        const cancelled =
          state.abortController.signal.aborted || gateway?.code === "transport_closed";
        state.outcome = {
          status: cancelled ? "cancelled" : "failed",
          errorCategory: code,
          errorOrigin: origin,
          httpStatus: status,
        };
      }
      if (!state?.canonicalRequest && !state?.authorization)
        metrics.proxy_requests_total.inc(1, { status: "rejected" });
      set.headers["cache-control"] = "no-store";
      set.headers["x-request-id"] = state?.requestId ?? crypto.randomUUID();
      Object.assign(set.headers, GATEWAY_SECURITY_HEADERS);
      if (deps.hsts) set.headers["strict-transport-security"] = "max-age=31536000";
      set.status = status;
      // Emit `retry-after` whenever the failure carries a real wait hint, not
      // only on a literal 429. `classifyUpstreamFailure` marks several
      // non-429 responses retryable (503 `admission_unavailable`, 529
      // `capacity_exhausted`), and those upstreams often state a reset in
      // `retryAfterMs`/`retryAt` — the client had no way to learn it. The
      // fallback below stays only for a 429 with no parsed evidence, where
      // "wait at least a second" is the safe floor the contract already had.
      if (set.headers["retry-after"] === undefined) {
        const hint = retryAfterSeconds(gateway);
        if (hint !== undefined) set.headers["retry-after"] = hint;
        else if (status === 429) set.headers["retry-after"] = "1";
      }
      return {
        error: {
          origin,
          code,
          message,
          ...(gateway
            ? { details: publicGatewayErrorDetails(gateway) }
            : {}),
        },
      };
    })
    .as("global");
  return app as unknown as Elysia;
}

/**
 * The minimal hook surface the telemetry/cleanup lifecycle needs. Exported so
 * the pipeline owner can register the lifecycle at the root while keeping the
 * real Elysia instance out of this signature.
 */
export interface AfterResponseApp {
  afterResponse(handler: (context: { request: Request }) => Promise<void>): AfterResponseApp;
}

/**
 * Emits the per-request telemetry row and observes request latency. Shared by
 * the non-stream `afterResponse` path and the streaming response's
 * completion/cancel path, so a streamed request reports the identical
 * telemetry shape as a buffered one — the only difference is *when* it runs
 * (stream termination vs. response-headers flush).
 */
export function finalizeRequestTelemetry(
  state: ProxyRequestState,
  telemetryBuffer: TelemetryBatchBuffer,
): void {
  // Discovery/surface routes under `/v1` (e.g. `/v1/models`) are authenticated
  // gateway routes that never dispatch upstream. They hold request state but
  // are not proxy requests: finalizing them emitted a phantom failed lifecycle
  // event plus a telemetry row with no endpoint.
  if (!isProxyDispatchRoute(state.ingressPath)) return;
  const requestData = state.canonicalRequest;
  const authorization = state.authorization;
  const latencyMs = Math.max(0, Date.now() - state.startedAtMs);
  metrics.proxy_request_latency_ms.observe(latencyMs);

  // Token speed: decode throughput when the client-visible token window was
  // observed (streaming — see `computeTokensPerSec`), end-to-end effective
  // speed otherwise. Non-streaming decode happens upstream inside TTFT and is
  // unobservable from the gateway; dividing by the ~ms of (latency - TTFT)
  // local overhead produced absurd 7000+ tok/s rows.
  const tokensPerSec = computeTokensPerSec({
    outputTokens: state.outcome?.usage?.output_tokens,
    latencyMs,
    stream: requestData?.stream ?? false,
    ...(state.outcome?.firstContentDeltaAtMs === undefined
      ? {}
      : { firstContentDeltaAtMs: state.outcome.firstContentDeltaAtMs }),
    ...(state.outcome?.lastEventAtMs === undefined
      ? {}
      : { lastEventAtMs: state.outcome.lastEventAtMs }),
  });
  const status = state.outcome?.status ?? "failed";
  const requestStatus =
    state.outcome?.httpStatus ?? (status === "completed" ? 200 : status === "cancelled" ? 499 : 500);
  pushStructuredConsoleLog(
    terminalLogLevel(status),
    terminalLogMessage(status),
    requestLogMetadata(state, {
      status,
      requestStatus,
      latencyMs,
      requestedModel: requestData?.model,
      routedModel: state.preparedRequest?.plan.resolved_model,
    }),
  );

  // Early rejections (ingress/auth/parse/preparer) still produce durable
  // telemetry when the tenant is known. Without a tenant id there is no
  // valid `telemetry_events` row (tenant_id is NOT NULL), so metrics +
  // outcome above remain the only signal — never enqueue a bogus row.
  if (!authorization) {
    return;
  }

  telemetryBuffer.enqueue(
    requestTelemetryEvent(state, authorization, {
      status,
      httpStatus: requestStatus,
      latencyMs,
      tokensPerSec,
    }),
  );
}

/** Console-log severity for a terminal request status. */
function terminalLogLevel(status: string): ConsoleLogLevel {
  return status === "completed" ? "info" : status === "cancelled" ? "warn" : "error";
}

/** Console-log message for a terminal request status. */
function terminalLogMessage(status: string): string {
  return status === "completed" ? "Proxy request completed" : "Proxy request failed";
}

/** The `request_complete` / `request_error` console-log payload. */
function requestLogMetadata(
  state: ProxyRequestState,
  derived: {
    status: string;
    requestStatus: number;
    latencyMs: number;
    requestedModel: string | undefined;
    routedModel: string | undefined;
  },
): ConsoleLogMetadata {
  const { status, requestStatus, latencyMs, requestedModel, routedModel } = derived;
  return {
    event: status === "completed" ? "request_complete" : "request_error",
    requestId: state.requestId,
    ...(state.ingressMethod ? { method: state.ingressMethod } : {}),
    ...(state.ingressPath ? { endpoint: state.ingressPath } : {}),
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(routedModel ? { routedModel } : {}),
    ...(state.outcome?.providerId ? { providerId: state.outcome.providerId } : {}),
    ...(state.outcome?.accountId ? { accountId: state.outcome.accountId } : {}),
    ...(state.outcome?.accountLabel ? { accountLabel: state.outcome.accountLabel } : {}),
    ...(state.outcome?.networkPoolId ? { networkPoolId: state.outcome.networkPoolId } : {}),
    ...(state.clientIdentity ? { clientIp: state.clientIdentity.address } : {}),
    ...(state.clientUserAgent ? { userAgent: state.clientUserAgent } : {}),
    status: requestStatus,
    durationMs: latencyMs,
    ...(state.outcome?.errorCategory ? { errorCode: state.outcome.errorCategory } : {}),
    ...(state.outcome?.errorOrigin ? { errorOrigin: state.outcome.errorOrigin } : {}),
    ...(state.outcome?.usage
      ? {
          details: {
            inputTokens: state.outcome.usage.input_tokens,
            outputTokens: state.outcome.usage.output_tokens,
            cachedInputTokens: state.outcome.usage.cached_input_tokens,
            reasoningTokens: state.outcome.usage.reasoning_tokens,
            estimatedCost: state.outcome.usage.estimated_cost,
          },
        }
      : {}),
  };
}

/**
 * The durable telemetry row for one request. Read off the same state the
 * console log uses, so a streamed request and a buffered one report an
 * identical shape.
 */
function requestTelemetryEvent(
  state: ProxyRequestState,
  authorization: NonNullable<ProxyRequestState["authorization"]>,
  derived: {
    status: string;
    httpStatus: number;
    latencyMs: number;
    tokensPerSec: number | undefined;
  },
): TelemetryEventInput {
  const { status, httpStatus, latencyMs, tokensPerSec } = derived;
  const requestData = state.canonicalRequest;
  const isEarlyRejection = !requestData;
  return {
    tenantId: authorization.tenantId,
    requestId: state.requestId,
    sourceSurface: requestData?.source_surface ?? "chat",
    requestedModel: requestData?.model ?? "unknown",
    ...(state.ingressPath ? { endpoint: state.ingressPath } : {}),
    ...(authorization.id ? { apiKeyId: authorization.id } : {}),
    ...(state.clientUserAgent ? { userAgent: state.clientUserAgent } : {}),
    ...(state.clientIdentity ? { clientIp: state.clientIdentity.address } : {}),
    stream: requestData?.stream ?? false,
    status:
      isEarlyRejection &&
      status !== "completed" &&
      status !== "cancelled" &&
      status !== "truncated"
        ? "failed"
        : (status as TelemetryEventInput["status"]),
    httpStatus,
    latencyMs,
    ...(state.outcome?.ttfbMs === undefined ? {} : { ttfbMs: state.outcome.ttfbMs }),
    ...(state.outcome?.providerId ? { providerId: state.outcome.providerId } : {}),
    ...(state.outcome?.accountId ? { accountId: state.outcome.accountId } : {}),
    ...(state.outcome?.networkPoolId ? { networkPoolId: state.outcome.networkPoolId } : {}),
    ...(state.outcome?.errorCategory ? { errorCategory: state.outcome.errorCategory } : {}),
    ...(state.outcome?.errorOrigin ? { errorOrigin: state.outcome.errorOrigin } : {}),
    ...(state.outcome?.usage ? { usage: state.outcome.usage } : {}),
    ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
    ...(state.outcome?.firstContentDeltaAtMs !== undefined
      ? { firstContentDeltaAtMs: state.outcome.firstContentDeltaAtMs }
      : {}),
    ...(state.outcome?.lastEventAtMs !== undefined
      ? { lastEventAtMs: state.outcome.lastEventAtMs }
      : {}),
  };
}

/**
 * Registers the telemetry `afterResponse` hook directly on the app that owns
 * the `/v1` routes. It must NOT live in a sub-plugin mounted via `.use()`:
 * Elysia 2 beta does not fire plugin-scoped `afterResponse` for parent routes,
 * which silently drops every gateway telemetry row (probes still record —
 * they enqueue directly, bypassing this hook).
 */
export function registerTelemetryLifecycle(
  app: AfterResponseApp,
  deps: {
    readonly stateStore: ProxyRequestStateStore;
    readonly telemetryBuffer: TelemetryBatchBuffer;
  },
): void {
  app.afterResponse(async ({ request }) => {
    const state = deps.stateStore.get(request);
    if (!state) return;
    // Streaming responses run telemetry + cleanup on stream completion/cancel
    // (see dispatch/proxy-request), never at the headers-flush `afterResponse`
    // boundary: cleanup aborts the controller, killing the in-flight stream.
    if (state.streaming) return;
    try {
      // Terminal attempts already finalized inside `completeAttempt`
      // (dispatch/proxy-request) — this hook stays only as the fallback
      // finalizer for requests that never reached completion (early
      // rejections). Cleanup below must still run for completed requests:
      // skipping it leaks one in-flight count per request, forever.
      if (!state.completed) finalizeRequestTelemetry(state, deps.telemetryBuffer);
    } finally {
      state.cleanup();
    }
  });
}

/** Cleans request state when telemetry is not mounted in a reduced composition. */
export function registerRequestCleanup(
  app: AfterResponseApp,
  deps: {
    readonly stateStore: ProxyRequestStateStore;
  },
): void {
  app.afterResponse(async ({ request }) => {
    const state = deps.stateStore.get(request);
    if (!state || state.streaming) return;
    state.cleanup();
  });
}


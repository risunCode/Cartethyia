// Per-request context, client identity, canonical parse, and route preparation.
import { Elysia } from "elysia";
import { GatewayError } from "../gateway-error";
import type { TrustedProxyBoundary } from "../../config";
import { resolveUpstreamTimeoutMs } from "../../config";
import type { ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../request/pathname";
import type { ProxyRequestPreparer } from "../request/preparer";
import type { CanonicalRequest } from "../canonical-model";
import type { SurfaceAdapterRegistry } from "../surface/adapters";
import { resolveClientIdentity } from "../../security/ip-boundary";
import { GATEWAY_SECURITY_HEADERS } from "../../security/outbound-headers";
import { pushStructuredConsoleLog } from "../../observability/log-ring";
import { log } from "../../observability/logger";
import { isJsonProxyRoutePath, isProxyDispatchRoute } from "./body-policy";
import { isNativeServicePath } from "../dispatch/native-services";
import {
  modelAbuseBannedError,
  modelWarningMessage,
  type ModelAbuseOutcome,
  type ModelStrikeService,
} from "../../security/model-abuse";

/**
 * Whether a thrown error is a *model* rejection the strike layer counts: the
 * key may not use the named model (`isModelAllowed` → 404), or the name
 * resolves to nothing (`modelNotFoundError` → 404). Both surface as
 * `model_not_found`; every other failure — an aborted request, a store outage,
 * a capability mismatch — is not the caller probing for models and is not
 * counted.
 */
function isModelRejection(error: unknown): boolean {
  return error instanceof GatewayError && error.code === "model_not_found";
}

/**
 * Re-throws a model rejection carrying the escalating strike warning, so an
 * honest client that mistyped sees "Warning 1 of 3" instead of the same generic
 * 404 three times and then a ban. The code/status are unchanged — only the
 * message gains the warning, and the count rides in `details` for the console.
 */
function withModelWarning(
  error: unknown,
  outcome: ModelAbuseOutcome,
  limit: number,
): GatewayError {
  if (!(error instanceof GatewayError)) return error as GatewayError;
  return new GatewayError(error.code, error.status, modelWarningMessage(String(error.details.model ?? ""), outcome, limit), {
    ...error.details,
    strikes: outcome.strikes,
    strike_limit: limit,
  }, error.origin);
}

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
      // the JSON routes table, so the body-policy predicate covers it.
      // Native routes (compact, System One) read a body but are never parsed
      // into a canonical request — their bodies are opaque by contract.
      if (!isJsonProxyRoutePath(path) || path === "/v1/responses/compact" || isNativeServicePath(path))
        return;
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
      if (detection.disagreement) {
        // A path-vs-body disagreement is expected traffic, not a fault: a
        // standard chat body ({model, messages[], max_tokens}) also matches
        // the messages body shape, so nearly every chat request with
        // max_tokens "disagrees". Warn only when the explicit header is
        // involved — a marker contradicting the path means the client is
        // genuinely confused about which surface it wants.
        const markerInvolved = detection.signals.some((s) => s.source === "explicit_marker");
        if (markerInvolved) {
          log.warn("[surface] conflicting signals detected for surface routing", {
            resolved: detection.surface,
            winning_source: detection.winning_source,
            signals: detection.signals,
          });
        } else {
          log.debug("[surface] ambiguous body shape resolved by endpoint path", {
            resolved: detection.surface,
            signals: detection.signals,
          });
        }
      }
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
  /**
   * Graduated strikes for repeated invalid-model requests. The preparation step
   * is the single choke point where a request is rejected for naming a model the
   * key may not use (`isModelAllowed`) or a model that resolves to nothing
   * (`modelNotFoundError`), so it is where a strike is recorded and where a
   * valid model clears one.
   */
  readonly modelStrikes?: ModelStrikeService;
}): Elysia {
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (!path.startsWith("/v1/")) return;
      if (request.method === "GET" || request.method === "HEAD") return;
      const isJsonRoute = isJsonProxyRoutePath(path);
      if (!isJsonRoute || path === "/v1/responses/compact" || isNativeServicePath(path)) return;
      const state = deps.stateStore.require(request);
      if (!state.authorization || !state.canonicalRequest)
        throw new GatewayError("admission_unavailable", 503, "proxy request context unavailable");
      const strikes = deps.modelStrikes;
      const ip = state.clientIdentity?.address;
      const strikeIdentity = strikes && ip !== undefined ? { strikes, ip } : undefined;
      try {
        state.preparedRequest = await deps.preparer.prepare({
          canonicalRequest: state.canonicalRequest,
          authorization: state.authorization,
          deadlineMs: state.deadlineMs,
          signal: state.abortController.signal,
          ...(state.clientUserAgent === undefined
            ? {}
            : { clientUserAgent: state.clientUserAgent }),
        });
      } catch (error) {
        // Only a *model* rejection is a strike: an invalid model the key may not
        // use, or a name that resolves to nothing. A store outage, an aborted
        // request, or any other failure is not the caller probing for models.
        if (strikeIdentity && isModelRejection(error)) {
          const outcome = await strikeIdentity.strikes
            .noteInvalid({ ip: strikeIdentity.ip })
            .catch(() => null);
          if (outcome?.banned === true) throw modelAbuseBannedError();
          if (outcome) throw withModelWarning(error, outcome, strikeIdentity.strikes.limit);
        }
        throw error;
      }
      // A valid model clears the caller's consecutive strike, so one typo
      // followed by a working request never accumulates toward a ban.
      if (strikeIdentity)
        void strikeIdentity.strikes
          .noteValid({ ip: strikeIdentity.ip })
          .catch(() => undefined);
    })
    .as("plugin");
}

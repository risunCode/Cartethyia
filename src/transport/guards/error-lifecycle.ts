// Error normalization + telemetry/cleanup lifecycle for the transport pipeline.
import { Elysia } from "elysia";
import { GatewayError, explainGatewayError, formatPublicErrorMessage, publicGatewayErrorDetails } from "../../protocol/gateway-error";
import type { ProxyRequestState, ProxyRequestStateStore } from "../request/state";
import { GATEWAY_SECURITY_HEADERS } from "../../security/outbound-headers";
import type { TelemetryBatchBuffer, TelemetryEventInput } from "../../observability/telemetry-buffer";
import { reasoningEffortFromIntent } from "../../providers/reasoning";
import { metrics } from "../../observability/metrics";
import { computeTokensPerSec } from "../../observability/token-speed";
import { pushStructuredConsoleLog } from "../../observability/log-ring";
import type { ConsoleLogLevel, ConsoleLogMetadata } from "../../observability/log-ring";
import { isProxyDispatchRoute } from "./body-policy";

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
      const builtinStatus = typeof builtin?.status === "number" ? builtin.status : undefined;
      const builtinCode = typeof builtin?.code === "string" ? builtin.code : undefined;
      const isBuiltinError = builtinStatus !== undefined || builtinCode !== undefined;
      const isInputError =
        !gateway &&
        !isBuiltinError &&
        state &&
        !state.canonicalRequest;
      const status =
        gateway?.status ?? builtinStatus ?? (isBuiltinError || isInputError ? 400 : 500);
      const code =
        gateway?.code ?? builtinCode ?? (isBuiltinError || isInputError ? "invalid_request" : "internal_error");
      const message =
        gateway !== undefined
          ? explainGatewayError(gateway)
          : isInputError && error instanceof Error
            ? formatPublicErrorMessage(code, error.message)
            : formatPublicErrorMessage(
                code,
                isBuiltinError
                  ? builtin?.message ?? "Unable to process the request as written."
                  : "The gateway hit an internal error. Retry; if it persists, the server logs carry the request id.",
              );
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
  const requestedEffort = (() => {
    if (requestData?.reasoning === undefined) return undefined;
    const effort = reasoningEffortFromIntent(requestData.reasoning);
    return effort === undefined || effort === "none" ? undefined : effort;
  })();
  return {
    tenantId: authorization.tenantId,
    requestId: state.requestId,
    sourceSurface: requestData?.source_surface ?? "chat",
    requestedModel: requestData?.model ?? "unknown",
    ...(requestedEffort === undefined ? {} : { requestedEffort }),
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
    ...(state.upstreamDispatchStartedAtMs !== undefined
      ? { resolveMs: Math.max(0, state.upstreamDispatchStartedAtMs - state.startedAtMs) }
      : {}),
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

import { GatewayError } from "../gateway-error";
// Attempt completion bookkeeping: one home for everything every dispatch attempt ends with.
import type { ValidatedOutboundFetch } from "../../providers/provider-registry";
import { reportAttemptOutcome } from "../../providers/operations/account-health-service";
import type { UsageRecord } from "../canonical-model";
import { classifyUpstreamFailure } from "../failure-policy";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { TelemetryPayloadCapture } from "../../observability/payload-capture";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { CachedPreferencesReader, DrizzlePreferencesReader } from "../../persistence/tenant-preferences";
import type { TelemetryPayloadMode } from "../../console/settings/contracts";
import type { ProxyRequestOutcome, ProxyRequestState } from "../request/state";
import { finalizeRequestTelemetry } from "../middleware/error-lifecycle";
import { log } from "../../observability/logger";
import {
  disablePoolForProxyHttpStatus,
  recordPoolDispatchOutcome,
} from "../../network/pool-health-machine";

let preferencesCache: { db: CartethyiaDatabase; reader: CachedPreferencesReader } | undefined;

export function preferencesReaderFor(db: CartethyiaDatabase): CachedPreferencesReader {
  // Rebound when the db identity changes (tests use a different database
  // per file); production passes the same singleton every request.
  if (!preferencesCache || preferencesCache.db !== db) {
    preferencesCache = {
      db,
      reader: new CachedPreferencesReader(new DrizzlePreferencesReader(db)),
    };
  }
  return preferencesCache.reader;
}

export function clearConsoleSettingsCacheForTests(): void {
  preferencesCache?.reader.clear();
}

/**
 * Settings-gated payload capture mode. Request-event metadata is always
 * retained; tenants opt into drawer capture through Settings → Privacy:
 * `metadata` keeps only the Proxy→Provider request line, `full` keeps
 * redacted bodies up to the configured capture limit. Fail-closed on error.
 */
async function resolvePayloadCaptureMode(
  db: CartethyiaDatabase,
  tenantId: string | null,
): Promise<TelemetryPayloadMode> {
  if (!tenantId) return "none";
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    const mode = prefs?.telemetryPayloads;
    if (mode === "full" || mode === "metadata" || mode === "none") return mode;
    // Unset preferences default to metadata (Proxy→Provider request line).
    return "metadata";
  } catch {
    // Preference read failure must not invent body capture; metadata is the
    // safe default that still matches Settings → Privacy.
    return "metadata";
  }
}

export function parseCapturedBody(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const PROVIDER_CAPTURE_MAX_BYTES = 256 * 1024;
const PROVIDER_CAPTURE_AWAIT_MS = 2_000;
const CAPTURABLE_RESPONSE_TYPES = /^(text\/|application\/(json|x-ndjson|sse))/i;

/** Only JSON/SSE/text bodies are parseable; binary native wire is skipped. */
function shouldCaptureProviderResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType === "") return true;
  return CAPTURABLE_RESPONSE_TYPES.test(contentType);
}

/** Bounded read of a response clone's body; never disturbs the caller's stream. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (text.length + chunk.length > maxBytes) {
        text += chunk.slice(0, maxBytes - text.length);
        break;
      }
      text += chunk;
    }
  } catch {
    // Best-effort capture must never fail the request path.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The clone branch is discarded either way.
    }
  }
  return text;
}

export interface ProviderExchangeCapture {
  request: unknown;
  response: Promise<unknown>;
}

/**
 * Outbound request headers worth recording for diagnosis.
 *
 * Deliberately an allowlist of non-secret protocol headers: the capture store
 * is read through the console, so a blanket copy would persist bearer tokens
 * and API keys. These are the headers that describe *how* a request was
 * framed (session identity, turn index, model routing), which is what makes a
 * provider bug reproducible after the fact.
 */
const CAPTURED_REQUEST_HEADERS = [
  "x-grok-session-id",
  "x-grok-conv-id",
  "x-grok-turn-idx",
  "x-grok-req-id",
  "x-grok-model-override",
  "x-grok-client-version",
  "x-grok-client-identifier",
  "x-grok-agent-id",
  "x-session-id",
  "x-claude-code-session-id",
  "user-agent",
] as const;

/** Copies only the allowlisted, non-empty headers from an outbound request. */
function selectCapturedHeaders(init?: RequestInit): Record<string, string> | undefined {
  if (init?.headers === undefined) return undefined;
  let source: Headers;
  try {
    source = new Headers(init.headers);
  } catch {
    return undefined;
  }
  const selected: Record<string, string> = {};
  for (const name of CAPTURED_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && value.length > 0) selected[name] = value;
  }
  return Object.keys(selected).length === 0 ? undefined : selected;
}

/**
 * Keeps the Proxy→Provider request line (method, URL, allowlisted headers) and
 * drops the body. Used by the `metadata` capture mode so operators can inspect
 * framing without retaining prompt/response content.
 */
export function providerRequestMetadataOnly(request: unknown): unknown {
  if (typeof request !== "object" || request === null) return null;
  const record = request as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  if (typeof record["method"] === "string") metadata["method"] = record["method"];
  if (typeof record["url"] === "string") metadata["url"] = record["url"];
  if (
    typeof record["headers"] === "object" &&
    record["headers"] !== null &&
    !Array.isArray(record["headers"])
  ) {
    metadata["headers"] = record["headers"];
  }
  return Object.keys(metadata).length === 0 ? null : metadata;
}

/** Wraps a validated outbound fetch to tee the provider request/response. */
export function captureProviderExchange(
  inner: ValidatedOutboundFetch,
  sink: ProviderExchangeCapture,
): ValidatedOutboundFetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const headers = selectCapturedHeaders(init);
    sink.request = {
      method: init?.method ?? "GET",
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(rawBody === null ? {} : { body: parseCapturedBody(rawBody) }),
    };
    const response = await inner(input, init);
    sink.response = shouldCaptureProviderResponse(response)
      ? readBoundedBody(response.clone(), PROVIDER_CAPTURE_MAX_BYTES).then(parseCapturedBody)
      : Promise.resolve(null);
    return response;
  };
}

async function resolvedProviderResponse(
  provider: ProviderExchangeCapture | undefined,
): Promise<unknown> {
  if (!provider) return null;
  const settled = await Promise.race([
    provider.response,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PROVIDER_CAPTURE_AWAIT_MS)),
  ]);
  return settled ?? null;
}

/**
 * Fire-and-forget terminal payload capture. Never throws, never blocks the
 * response path — telemetry must not fail requests.
 *
 * A failure here is *not* silent: capture is an operator-visible switch, so an
 * opted-in tenant whose bodies never appear is a defect they cannot diagnose
 * from the UI. The usual cause is a deployment one — the payload directory is
 * not writable by the runtime user, which a bind-mounted `/app/data` produces
 * when the host directory is owned by root. The error is reported once per
 * process so a broken directory cannot flood the log per request, and the
 * message names the directory and the fix.
 */
function captureTerminalPayload(
  db: CartethyiaDatabase,
  tenantId: string | null,
  requestId: string,
  requestBody: unknown,
  responseBody: unknown,
  clientResponseBody?: unknown,
  providerCapture?: ProviderExchangeCapture,
): void {
  if (!tenantId) return;
  void (async () => {
    try {
      const mode = await resolvePayloadCaptureMode(db, tenantId);
      if (mode === "none") return;
      if (mode === "metadata") {
        const providerRequest = providerRequestMetadataOnly(providerCapture?.request ?? null);
        if (providerRequest === null) return;
        await new TelemetryPayloadCapture(db).capture({
          tenantId,
          requestId,
          requestBody: null,
          responseBody: null,
          providerRequestBody: providerRequest,
          scope: "tenant",
          tenantOptIn: true,
        });
        return;
      }
      const providerRequest = providerCapture?.request ?? null;
      const providerResponse = await resolvedProviderResponse(providerCapture);
      await new TelemetryPayloadCapture(db).capture({
        tenantId,
        requestId,
        requestBody: requestBody ?? null,
        responseBody: responseBody ?? null,
        ...(clientResponseBody === undefined ? {} : { clientResponseBody: clientResponseBody ?? null }),
        ...(providerRequest === null ? {} : { providerRequestBody: providerRequest }),
        ...(providerResponse === null ? {} : { providerResponseBody: providerResponse }),
        scope: "tenant",
        tenantOptIn: true,
      });
    } catch (error) {
      reportCaptureFailure(error);
    }
  })();
}

let captureFailureReported = false;

/**
 * One warning per process for a failing payload capture. The cause is a
 * deployment condition that does not change per request, so repeating it for
 * every request would bury the rest of the log without adding information.
 */
export function reportCaptureFailure(error: unknown): void {
  if (captureFailureReported) return;
  captureFailureReported = true;
  const directory = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR?.trim() || "./data/telemetry-payloads";
  const reason = error instanceof Error ? error.message : String(error);
  log.warn(
    `[telemetry] payload capture is enabled for this tenant but the body was not stored ` +
      `(${reason}). Check that "${directory}" exists and is writable by the runtime user; ` +
      `a bind-mounted data directory is often owned by root while the container runs unprivileged.`,
  );
}

/** Test-only: allow a later failure to be reported again. */
export function resetCaptureFailureReportForTests(): void {
  captureFailureReported = false;
}

/**
 * Maps a missing or non-successful upstream terminal event to the GatewayError
 * the client should see.
 *
 * Shared by the streaming and non-streaming dispatch paths so both report the
 * same code, status and message for the same upstream condition. The stream
 * path passes `truncated` because it can distinguish "ended early" from "never
 * terminated"; the non-stream path cannot.
 */
export function terminalFailure(
  terminal: { readonly state: string; readonly stop_reason?: string; readonly provider_stop_reason?: string; readonly stop_details?: Record<string, unknown> } | undefined,
  options: { readonly truncated?: boolean } = {},
): GatewayError | undefined {
  if (terminal === undefined) {
    // The upstream produced no terminal event: its own stream is what ended
    // without a verdict, so this is an upstream failure, not ours.
    return new GatewayError(
      "transport_unavailable",
      502,
      "upstream produced no terminal event",
      {},
      "upstream",
    );
  }
  if (terminal.state === "failed") {
    // A terminal `failed` state is only ever written by the upstream decoders
    // (a provider error envelope or a corrupt provider stream), so it carries
    // the upstream's failure, not the gateway's.
    const details: Record<string, unknown> = {};
    if (terminal.provider_stop_reason) details["provider_code"] = terminal.provider_stop_reason;
    if (terminal.stop_details) Object.assign(details, terminal.stop_details);
    const message = typeof details["message"] === "string" ? details["message"] : "upstream request failed";
    return new GatewayError("transport_unavailable", 502, message, details, "upstream");
  }
  if (terminal.state === "aborted") {
    // A client-initiated cancellation is not an upstream fault; the stream path
    // reports it as truncation instead.
    return options.truncated === true
      ? undefined
      : new GatewayError("transport_closed", 499, "request was cancelled");
  }
  return undefined;
}

/**
 * A usage record carrying only the request's own token estimate, with no price
 * yet: `estimated_cost` is `null` (unpriced) so the analytics `partial` flag
 * counts it, rather than `0`, which would claim the turn cost nothing. The
 * dispatch call sites reprice it against the routed model before committing.
 */
export function estimatedUsage(inputTokens: number, outputTokens: number): UsageRecord {
  return {
    input_tokens: inputTokens,
    cached_input_tokens: "unavailable",
    cache_write_tokens: "unavailable",
    uncached_input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: "unavailable",
    estimated_cost: null,
  };
}

/**
 * Single attempt completion: one home for everything every dispatch attempt
 * ends with — outcome recording, usage commit, health report, payload
 * capture, telemetry finalization. Streaming and non-streaming paths build
 * the same completion (outcome literal first, so `state.outcome` keeps its
 * exact per-path shape) and differ only in `terminal`: intermediate
 * failover attempts commit usage + report health but defer capture and
 * telemetry to the terminal attempt, so one request emits exactly one
 * telemetry row however many candidates it tried.
 *
 * Pool cooldown flagging, metrics, client encoding, and failover/refresh
 * decisions stay at the call sites — they are retry/transport policy, not
 * completion bookkeeping.
 */
export interface AttemptCompletion extends ProxyRequestOutcome {
  readonly modelId?: string;
  readonly error?: unknown;
  readonly lease?: AdmissionLease;
  /** Usage to reconcile, or undefined when this attempt consumed nothing billable. */
  readonly commitUsage?: UsageRecord;
  /** Capture + telemetry run only for the terminal attempt of a request. */
  readonly terminal: boolean;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly responseBody: unknown;
  readonly clientResponseText?: string;
  readonly providerCapture?: ProviderExchangeCapture;
  readonly db: CartethyiaDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly snapshotService?: { invalidate(): unknown };
  /** First content delta timestamp (for TTFT calculation). */
  readonly firstContentDeltaAtMs?: number;
  /** Last event timestamp (for generation duration calculation). */
  readonly lastEventAtMs?: number;
}

/**
 * The fields every dispatch completion shares, regardless of outcome.
 *
 * The streaming path and the non-streaming path each assembled this set by
 * hand, so a field added to one (a new telemetry buffer, a snapshot service)
 * could silently miss the other. Callers spread this and add only what differs:
 * status, usage, error classification, and the response body.
 */
export function completionContext(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly tenantId: string | null;
  readonly ingressBody: unknown;
  readonly providerCapture?: ProviderExchangeCapture;
  readonly db: CartethyiaDatabase;
  readonly accountId?: string | undefined;
  readonly accountLabel?: string | undefined;
  readonly networkPoolId?: string | undefined;
  readonly lease?: AdmissionLease | undefined;
  readonly telemetryBuffer?: TelemetryBatchBuffer | undefined;
  readonly snapshotService?: { invalidate(): unknown } | undefined;
}): Pick<
  AttemptCompletion,
  | "providerId"
  | "modelId"
  | "tenantId"
  | "ingressBody"
  | "db"
  | "terminal"
  | "accountId"
  | "accountLabel"
  | "networkPoolId"
  | "lease"
  | "providerCapture"
  | "telemetryBuffer"
  | "snapshotService"
> {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    tenantId: input.tenantId,
    ingressBody: input.ingressBody,
    ...(input.providerCapture === undefined ? {} : { providerCapture: input.providerCapture }),
    db: input.db,
    terminal: true,
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
    ...(input.networkPoolId === undefined ? {} : { networkPoolId: input.networkPoolId }),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    ...(input.telemetryBuffer === undefined ? {} : { telemetryBuffer: input.telemetryBuffer }),
    ...(input.snapshotService === undefined ? {} : { snapshotService: input.snapshotService }),
  };
}

export async function completeAttempt(
  state: ProxyRequestState,
  completion: AttemptCompletion,
): Promise<void> {
  // Idempotency guard: the terminal completion claims the request before any
  // await, so a caller that retries completion after a bookkeeping failure
  // (e.g. the streaming error path re-entering after `commitUsage` threw)
  // cannot double-commit usage, report health twice, or emit a second
  // telemetry row. Intermediate failover attempts deliberately leave
  // `completed` clear: they commit their own usage estimate and report
  // health, then the terminal attempt records the real outcome and emits the
  // one telemetry row the request is owed.
  if (state.completed) return;
  state.outcome = {
    status: completion.status,
    httpStatus:
      completion.httpStatus ??
      (completion.error instanceof GatewayError
        ? completion.error.status
        : completion.status === "completed"
          ? 200
          : completion.status === "cancelled"
            ? 499
            : completion.status === "truncated"
              ? 502
              : 500),
    ...(completion.providerId === undefined ? {} : { providerId: completion.providerId }),
    ...(completion.accountId === undefined ? {} : { accountId: completion.accountId }),
    ...(completion.accountLabel === undefined ? {} : { accountLabel: completion.accountLabel }),
    ...(completion.networkPoolId === undefined ? {} : { networkPoolId: completion.networkPoolId }),
    ...(completion.errorCategory === undefined ? {} : { errorCategory: completion.errorCategory }),
    ...(completion.errorOrigin === undefined ? {} : { errorOrigin: completion.errorOrigin }),
    ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    ...(completion.ttfbMs === undefined ? {} : { ttfbMs: completion.ttfbMs }),
    ...(completion.tokensPerSec === undefined ? {} : { tokensPerSec: completion.tokensPerSec }),
    ...(completion.firstContentDeltaAtMs === undefined ? {} : { firstContentDeltaAtMs: completion.firstContentDeltaAtMs }),
    ...(completion.lastEventAtMs === undefined ? {} : { lastEventAtMs: completion.lastEventAtMs }),
  };
  if (completion.terminal) state.completed = true;
  // Usage reconciliation is bookkeeping, and it is the last thing standing
  // between the caller and its resource release. Letting a store failure
  // propagate from here aborts the completion sequence *after* `completed` is
  // claimed, so the caller's release never runs and the in-flight gauge climbs
  // for the life of the process; the reservation is released unreconciled
  // either way, so the slot is not what is at stake. Swallowed for the same
  // reason the health and pool reports below are: a failed report must not
  // decide the request's outcome.
  if (completion.lease?.commitUsage && completion.commitUsage) {
    try {
      await completion.lease.commitUsage(completion.commitUsage);
    } catch {
      // Swallowed: usage reconciliation is non-critical bookkeeping.
    }
  }
  const responseHttpStatus =
    completion.error instanceof GatewayError ? completion.error.status : completion.httpStatus;
  // Only a proxy-origin payment/auth response proves the pool itself is unusable;
  // an upstream provider's 402 is a quota/billing response for that provider.
  const errorOrigin =
    completion.error instanceof GatewayError
      ? completion.error.origin
      : completion.errorOrigin;
  const disableProxy =
    completion.networkPoolId !== undefined &&
    completion.status !== "completed" &&
    errorOrigin === "network" &&
    (responseHttpStatus === 402 || responseHttpStatus === 407);
  // Cancelled attempts write no health (client gone; outcome unknown) —
  // matches the historical `!cancelled` guards at every site. Health is
  // advisory: a failed report must never re-enter the retry path (a retry
  // would see `completed` and skip completion entirely), so it is swallowed.
  if (completion.status !== "cancelled" && !disableProxy) {
    try {
      await reportAttemptOutcome(completion.db, {
        accountId: completion.accountId,
        ...(completion.modelId === undefined ? {} : { modelId: completion.modelId }),
        ...(completion.status === "failed"
          ? {
              error: completion.error,
              evidence: { ...classifyUpstreamFailure(completion.error) },
            }
          : {}),
        ...(completion.snapshotService ? { snapshotService: completion.snapshotService } : {}),
      });
    } catch {
      // Swallowed: health reporting is non-critical bookkeeping.
    }
  }
  if (completion.networkPoolId && completion.status !== "cancelled") {
    try {
      if (disableProxy && (responseHttpStatus === 402 || responseHttpStatus === 407)) {
        await disablePoolForProxyHttpStatus(
          completion.db,
          completion.networkPoolId,
          responseHttpStatus,
          completion.snapshotService,
        );
      } else {
        await recordPoolDispatchOutcome(completion.db, completion.networkPoolId, {
          succeeded: completion.status === "completed",
          ...(completion.error === undefined ? {} : { error: completion.error }),
          ...(completion.errorOrigin === undefined ? {} : { errorOrigin: completion.errorOrigin }),
          ...(completion.snapshotService === undefined
            ? {}
            : { snapshotInvalidator: completion.snapshotService }),
        });
      }
    } catch {
      // Pool health is advisory; never fail or retry a completed request for it.
    }
  }
  if (!completion.terminal) return;
  captureTerminalPayload(
    completion.db,
    completion.tenantId,
    state.requestId,
    completion.ingressBody,
    completion.responseBody,
    completion.clientResponseText,
    completion.providerCapture,
  );
  if (completion.telemetryBuffer) finalizeRequestTelemetry(state, completion.telemetryBuffer);
}

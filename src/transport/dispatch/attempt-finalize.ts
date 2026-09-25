import { GatewayError } from "../gateway-error";
// Attempt completion bookkeeping: one home for everything every dispatch attempt ends with.
import type { ValidatedOutboundFetch } from "../../providers/provider-registry";
import { reportAttemptOutcome } from "../../providers/operations/account-health-service";
import type { UsageRecord } from "../canonical-model";
import { classifyUpstreamFailure } from "../failure-policy";
import type { AdmissionLease } from "../../security/admission";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { TelemetryPayloadCapture } from "../../observability/payload-capture";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { CachedPreferencesReader, DrizzlePreferencesReader } from "../../persistence/tenant-preferences";
import type { ProxyRequestOutcome, ProxyRequestState } from "../request/state";
import { finalizeRequestTelemetry } from "../middleware/ingress";
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
 * Settings-gated payload capture switch. Metadata is the default; tenants must
 * explicitly opt into bounded body capture through Settings → Privacy. Reads
 * go through the shared revision-keyed preferences cache, fail-closed on error.
 */
async function isPayloadCaptureEnabled(db: CartethyiaDatabase, tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    return prefs?.telemetryPayloads === "bounded";
  } catch {
    return false;
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
      if (!(await isPayloadCaptureEnabled(db, tenantId))) return;
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
    } catch {
      // Swallowed: see above.
    }
  })();
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
  terminal: { readonly state: string } | undefined,
  options: { readonly truncated?: boolean } = {},
): GatewayError | undefined {
  if (terminal === undefined) {
    return new GatewayError("transport_unavailable", 502, "upstream produced no terminal event");
  }
  if (terminal.state === "failed") {
    return new GatewayError("transport_unavailable", 502, "upstream request failed");
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
  if (completion.lease?.commitUsage && completion.commitUsage)
    await completion.lease.commitUsage(completion.commitUsage);
  const responseHttpStatus =
    completion.error instanceof GatewayError ? completion.error.status : completion.httpStatus;
  const disableProxy =
    completion.networkPoolId !== undefined &&
    completion.status !== "completed" &&
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

/**
 * Stream completion, capture, and resource release for one streamed attempt.
 *
 * Owns everything the stream's tail does: the single-shot settle/release
 * guards, the stall/first-chunk watchdog timers, the SSE keepalive timer,
 * abort handling, lease release, and the two terminal paths
 * (`finalizeStream` on a clean/aborted end, `emitStreamErrorAndClose` on a
 * failure). Extracted from `dispatchStreamingAttempt` as a seam, not a
 * behavior change: the recorded outcome shapes, the error-frame vocabulary,
 * and the event ordering are the original ones.
 *
 * `test/gateway/streaming-contract.test.ts` pins the observable contract.
 */
import { GatewayError, explainGatewayError, formatPublicErrorMessage, publicGatewayErrorDetails } from "../../../protocol/gateway-error";
import { classifyTerminalOutcome } from "../../failure-policy";
import type { CanonicalEvent } from "../../../protocol/canonical-model";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import type { ProxyRequestState } from "../../request/state";
import type { PreparedProxyRequest } from "../../request/preparer";
import type { AdmissionLease } from "../../../security/admission/contracts";
import type { Reservation } from "../../routing/route-model";
import { repriceUsage } from "../../../providers/usage";
import { metrics } from "../../../observability/metrics";
import { flagPoolCooldown } from "../../../network/pool-health";
import { shouldCooldownPool } from "../retry-policy";
import { releaseAttemptLeases } from "../leases";
import { finalizeRequestTelemetry } from "../../guards/error-lifecycle";
import { drainAbortReason } from "../../shutdown-notice";
import {
  completeAttempt,
  completionContext,
  estimatedUsage,
  terminalFailure,
  type ProviderExchangeCapture,
} from "../attempt-finalize";
import { KEEPALIVE_COMMENT_BYTES, type StreamEventPipeline } from "./encoder";

/**
 * Upstream iterator settle budget. An upstream generator whose `return()`
 * never settles (pending read the abort never rejects) would otherwise hold
 * the admission lease, pool slot, and reservation forever — the exact leak
 * the inflight backstop force-releases. The fetch is already torn down by
 * the abort, so after this budget the gateway releases unconditionally.
 */
const ITERATOR_SETTLE_TIMEOUT_MS = 10_000;

/** Collaborators the stream tail reads from the dispatch handler. */
export interface StreamFinalizeDeps {
  readonly db: CartethyiaDatabase;
  readonly poolSelector?: NetworkPoolSelector | undefined;
  readonly telemetryBuffer?: TelemetryBatchBuffer | undefined;
  readonly snapshotService?: { invalidate(): unknown } | undefined;
}

/** Immutable identity of the candidate this stream belongs to. */
export interface StreamCandidateIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string | undefined;
  readonly accountLabel: string | undefined;
  readonly networkPoolId: string | undefined;
}

/** What the stream tail needs from the attempt's input. */
export interface StreamFinalizeInput {
  readonly state: ProxyRequestState;
  readonly deps: StreamFinalizeDeps;
  readonly prepared: PreparedProxyRequest;
  readonly candidate: StreamCandidateIdentity;
  readonly lease: AdmissionLease;
  readonly reservation: Reservation;
  readonly proxySlot: { poolId: string; release: () => void } | undefined;
  readonly providerCapture: ProviderExchangeCapture;
  /**
   * The stream's current upstream iterator. Re-read on every call because the
   * single pre-content Responses retry rebinds it mid-stream.
   */
  readonly getIterator: () => AsyncIterator<CanonicalEvent>;
  /** First-token latency in the spread shape `completeAttempt` accepts. */
  readonly ttfbFields: (
    firstByteAt: number | undefined,
    firstContentDeltaAtMs: number | undefined,
    startedAtMs: number | undefined,
  ) => { ttfbMs?: number };
}

/**
 * The stream's tail: watchdogs, abort handling, terminal completion, capture,
 * and single-shot resource release.
 *
 * Single-shot guards: exactly one of `finalizeStream` /
 * `emitStreamErrorAndClose` may record the terminal outcome (`streamSettled`),
 * and `releaseStreamResources` runs once (`streamReleased`). A client
 * disconnect racing stream completion otherwise cascades —
 * controller.close() throws on the dead controller, routing the completed
 * stream back into the error path and emitting duplicate telemetry rows (and
 * a second resource release) for one request.
 */
export class StreamFinalizer {
  /**
   * True only while a `pull()` is awaiting the upstream iterator. A watchdog
   * abort that lands during a pull is caught by that pull's own handler; one
   * that lands while the stream is paused (the client stopped reading, so no
   * pull is pending) has no reader to catch it and must be released by the
   * abort handler instead.
   */
  pullActive = false;

  /**
   * Max time between upstream events before the stream is declared stalled,
   * and max time to the first client-visible chunk. Both are resolved from
   * config once per stream (`CARTETHYIA_STREAM_STALL_TIMEOUT_MS` defaults to
   * 360s, `CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS` to 200s). The stall
   * bound is sized to stay *above* every legitimate long silence:
   * provider-side reasoning/long-context generation can hold silence for
   * minutes (Codex/o1-style hidden reasoning up to ~5 min), and the bound
   * must also comfortably exceed transient upstream connection pauses. It
   * sits below the derived pool-slot crash-recovery TTL (`network-pool.ts`
   * `poolInflightTtlSeconds`, the request deadline plus this stall budget
   * plus a buffer) so the watchdog always releases the lease before the
   * crash-recovery sweep could ever reclaim it, and far below the hourly
   * lease TTL in admission. The watchdog is re-armed on every upstream read,
   * so it measures the inter-event gap, not stream duration; until the first
   * client-visible byte lands it uses the tighter first-chunk bound instead
   * of the stall bound.
   */
  readonly streamStallTimeoutMs: number;

  private readonly input: StreamFinalizeInput;
  private readonly pipeline: StreamEventPipeline;
  private readonly streamFirstChunkTimeoutMs: number;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private clientKeepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private streamSettled = false;
  private streamReleased = false;
  // Stable reference so the (currently unreferenced) removal below matches
  // what registration would remove; see `releaseStreamResources`.
  private readonly handleAbort = (): void => this.onStreamAbort();

  constructor(input: StreamFinalizeInput, pipeline: StreamEventPipeline, timeouts: {
    stallTimeoutMs: number;
    firstChunkTimeoutMs: number;
  }) {
    this.input = input;
    this.pipeline = pipeline;
    this.streamStallTimeoutMs = timeouts.stallTimeoutMs;
    this.streamFirstChunkTimeoutMs = timeouts.firstChunkTimeoutMs;
  }

  /**
   * Re-arms the stall watchdog. Called before every upstream read.
   *
   * Once the upstream has produced anything — even surface-invisible
   * reasoning deltas — it is alive: the stall bound governs and the tighter
   * first-chunk bound no longer applies. The hard ceiling (state deadline)
   * still caps total duration.
   */
  armStallWatchdog(sawUpstreamActivity: boolean): void {
    clearTimeout(this.stallTimer);
    const timeoutMs =
      this.pipeline.firstByteAt === undefined && !sawUpstreamActivity
        ? this.streamFirstChunkTimeoutMs
        : this.streamStallTimeoutMs;
    this.stallTimer = setTimeout(() => {
      // The bound that expired is silence *from the upstream*, so the
      // origin is the upstream's: labelling it `cartethyia` reported a
      // provider that stopped sending as a gateway defect.
      this.input.state.abortController.abort(
        new GatewayError("deadline_exceeded", 504, "upstream stream stalled", {}, "upstream"),
      );
    }, timeoutMs);
  }

  clearStallWatchdog(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  /**
   * Starts the SSE keepalive comment timer for one constructed stream. The
   * comment frame is valid framing on every streamed surface and ignored by
   * EventSource clients; it is never part of content or telemetry.
   */
  startClientKeepalive(
    controller: ReadableStreamDefaultController<Uint8Array>,
    intervalMs: number,
  ): void {
    const { state } = this.input;
    this.clientKeepaliveTimer = setInterval(() => {
      if (this.streamSettled || this.streamReleased || state.abortController.signal.aborted) {
        this.clearClientKeepaliveTimer();
        return;
      }
      // Do not accumulate comments when the consumer is applying
      // backpressure; the next pull will resume normal streaming.
      if (controller.desiredSize !== null && controller.desiredSize > 0)
        controller.enqueue(KEEPALIVE_COMMENT_BYTES);
    }, intervalMs);
  }

  clearClientKeepaliveTimer(): void {
    if (this.clientKeepaliveTimer !== undefined) clearInterval(this.clientKeepaliveTimer);
    this.clientKeepaliveTimer = undefined;
  }

  /**
   * Fires when the request controller aborts. Every abort here must end in a
   * release, because the alternative is a flight that never leaves the gauge:
   *
   * - **Client disconnect** (an `AbortError` bridged from the inbound
   *   signal). The client is gone, so no frame would reach it: release here.
   * - **Drain** (a typed shutdown `GatewayError`). The client is still
   *   reading, so the terminal frame matters — let `pull()` emit it and
   *   release; releasing here would finalize telemetry before the frame and
   *   could double-finalize.
   * - **Deadline / stall watchdog** (`deadline_exceeded`, `TimeoutError`).
   *   These *usually* fire from inside `pull()`'s watchdog, which already
   *   records the terminal outcome and releases — but `pull()` runs only
   *   when the consumer asks for more data. A client that half-closes (stops
   *   reading, keeps the socket) leaves no pending `pull()`, so the watchdog
   *   abort lands with nothing to catch it and the flight leaked for the
   *   life of the process. That is why the release cannot be skipped on the
   *   *assumption* that a pull is watching: gate it on whether a pull is
   *   actually in flight.
   */
  onStreamAbort(): void {
    const { state } = this.input;
    const reason = state.abortController.signal.reason;
    const drain = drainAbortReason(reason);
    const clientDisconnect =
      drain === undefined && reason instanceof DOMException && reason.name === "AbortError";
    // A drain always defers to `pull()`: the client is still reading, so
    // the terminal frame matters and releasing here would finalize
    // telemetry before it (and could double-finalize).
    if (drain !== undefined) return;
    // A deadline/stall abort fired from inside `pull()`'s watchdog is
    // recorded and released by that pull — defer to it. But a pull only
    // exists while the consumer asks for data, so the same abort with no
    // pending pull (a half-closed client) has nothing to catch it and must
    // be released here. A client disconnect always releases: the consumer
    // is gone, the frame would go nowhere, and the upstream iterator may
    // ignore the abort entirely (never rejecting the pending `next()`).
    if (this.pullActive && !clientDisconnect) return;
    if (clientDisconnect && !state.outcome) {
      state.outcome = { status: "cancelled", httpStatus: 499 };
    }
    void (async () => {
      await this.settleUpstreamIterator();
      await this.releaseStreamResources();
    })();
  }

  /**
   * Bounded wait for the current upstream iterator's `return()` (see
   * `ITERATOR_SETTLE_TIMEOUT_MS`).
   */
  async settleUpstreamIterator(): Promise<void> {
    try {
      const iterator = this.input.getIterator();
      await Promise.race([
        iterator.return?.() ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, ITERATOR_SETTLE_TIMEOUT_MS)),
      ]);
    } catch {
      // Upstream iterator cleanup on abort is best-effort.
    }
  }

  async releaseStreamResources(): Promise<void> {
    if (this.streamReleased) return;
    this.streamReleased = true;
    const { state, deps, prepared, lease, reservation, proxySlot } = this.input;
    state.abortController.signal.removeEventListener("abort", this.handleAbort);
    this.clearClientKeepaliveTimer();
    this.clearStallWatchdog();
    await releaseAttemptLeases(
      {
        lease,
        reservation,
        proxySlot,
      },
      prepared.routingEngine,
    );
    // Streaming responses defer telemetry + request/state cleanup to
    // stream completion/cancel: `afterResponse` fires at the headers
    // flush and would otherwise abort this controller mid-stream.
    // completeAttempt already finalized terminal outcomes; only
    // unterminated paths (client abort mid-pull) finalize here.
    if (!state.completed && deps.telemetryBuffer)
      finalizeRequestTelemetry(state, deps.telemetryBuffer);
    state.cleanup();
  }

  /**
   * Terminal path for a stream that ended (cleanly, truncated, or with a
   * failed terminal event). Records the completion, flushes the closing
   * frames, and closes the controller; any failure falls through to
   * `emitStreamErrorAndClose`. Exactly-once per stream.
   */
  async finalizeStream(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const { state, prepared, candidate, ttfbFields } = this.input;
    const pipeline = this.pipeline;
    let upstreamTruncated = false;
    try {
      if (!pipeline.terminal) {
        upstreamTruncated = true;
        pipeline.enqueueEvent(
          {
            type: "terminal",
            sequence_number: pipeline.streamedEvents.length + 1,
            state: "aborted",
            stop_reason: "error",
          },
          controller,
        );
      }
      if (pipeline.terminal === undefined) throw terminalFailure(undefined);
      const terminalError = terminalFailure(pipeline.terminal, { truncated: upstreamTruncated });
      if (terminalError !== undefined) throw terminalError;
      const truncationError = upstreamTruncated
        ? new GatewayError(
            "transport_unavailable",
            502,
            "upstream stream ended before terminal event",
            {},
            "upstream",
          )
        : undefined;
      pipeline.finishEncoders(controller);
      const finalUsage = repriceUsage(
        pipeline.terminal.usage ?? pipeline.usage ?? estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens),
        candidate.providerId,
        candidate.modelId,
      );
      await completeAttempt(state, {
        status: upstreamTruncated ? "truncated" : "completed",
        ...this.streamCompletionContext(),
        ...ttfbFields(pipeline.firstByteAt, pipeline.firstContentDeltaAtMs, state.upstreamDispatchStartedAtMs),
        ...(upstreamTruncated
          ? {
              errorCategory: "transport_unavailable",
              errorOrigin: "upstream",
              error: truncationError,
            }
          : {}),
        usage: finalUsage,
        commitUsage: finalUsage,
        responseBody: pipeline.streamedEvents,
        ...(pipeline.clientResponseText ? { clientResponseText: pipeline.clientResponseText } : {}),
        ...(pipeline.firstContentDeltaAtMs !== undefined ? { firstContentDeltaAtMs: pipeline.firstContentDeltaAtMs } : {}),
        ...(pipeline.lastEventAtMs !== undefined ? { lastEventAtMs: pipeline.lastEventAtMs } : {}),
      });
      metrics.proxy_requests_total.inc(1, {
        status: upstreamTruncated ? "truncated" : "completed",
      });
      controller.close();
    } catch (err) {
      await this.emitStreamErrorAndClose(err, controller);
    } finally {
      void this.releaseStreamResources();
    }
  }

  /**
   * Terminal path for a failed stream: records the failed/cancelled outcome,
   * emits the SSE error frame, and releases. No-op when the terminal outcome
   * was already recorded (the `streamSettled` guard).
   */
  async emitStreamErrorAndClose(err: unknown, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    // Already recorded (completed or failed) — e.g. controller.close()
    // threw on the dead controller after a recorded completion. Return
    // without recording again; the caller's finally still releases.
    if (this.streamSettled) return;
    const { state, deps, prepared, ttfbFields, candidate } = this.input;
    const pipeline = this.pipeline;
    const abortReason = state.abortController.signal.reason;
    const watchdogFailure =
      abortReason instanceof GatewayError && abortReason.code === "deadline_exceeded"
        ? abortReason
        : abortReason instanceof DOMException && abortReason.name === "TimeoutError"
          ? new GatewayError(
              "deadline_exceeded",
              504,
              "request deadline exceeded",
              {},
              "cartethyia",
            )
          : undefined;
    // A drain aborts the controller too. When it races the upstream
    // read's own rejection, the shutdown error must win the frame: the
    // client is being told "we are restarting", not "the upstream
    // failed".
    const drainFailure = drainAbortReason(abortReason);
    const streamError = watchdogFailure ?? drainFailure ?? err;
    // A drain is not a client cancel: the client is still reading and
    // gets the terminal frame below. The record must say `failed` with
    // the shutdown code, not `cancelled`. Status, category, and origin
    // come from one classifier so they cannot disagree.
    const terminalOutcome = classifyTerminalOutcome(streamError, state.abortController.signal);
    const cancelled = terminalOutcome.status === "cancelled";
    await completeAttempt(state, {
      status: terminalOutcome.status,
      ...this.streamCompletionContext(),
      ...ttfbFields(pipeline.firstByteAt, pipeline.firstContentDeltaAtMs, state.upstreamDispatchStartedAtMs),
      errorCategory: terminalOutcome.errorCategory,
      // Every fallback category the classifier returns (client close,
      // deadline, genuine unknown) is a gateway-side lifecycle outcome,
      // never an upstream-reported error — the upstream path is already
      // covered by the `GatewayError` branch keeping its own origin.
      errorOrigin: terminalOutcome.errorOrigin,
      ...(!cancelled ? { error: streamError } : {}),
      ...(!cancelled
        ? {
            commitUsage: estimatedUsage(
              prepared.estimatedInputTokens,
              prepared.estimatedOutputTokens,
            ),
          }
        : {}),
      // A returned stream never fails over: its error is terminal.
      // Keep whatever reached the client before the failure: an error
      // after content was delivered is diagnosed from the transcript,
      // and `null` here made the drawer's panels read "no payload" for
      // exactly the requests an operator most needs to inspect.
      responseBody: pipeline.streamedEvents.length > 0 ? pipeline.streamedEvents : null,
      ...(pipeline.clientResponseText.length > 0 ? { clientResponseText: pipeline.clientResponseText } : {}),
    });
    this.streamSettled = true;
    if (candidate.networkPoolId && !cancelled && deps.poolSelector && shouldCooldownPool(err, candidate.providerId)) {
      flagPoolCooldown(deps.poolSelector, deps.db, candidate.networkPoolId, candidate.providerId, err);
    }
    if (!cancelled) metrics.proxy_requests_total.inc(1, { status: "failed" });
    else metrics.proxy_requests_total.inc(1, { status: "cancelled" });
    if (!cancelled) {
      const gatewayError = err instanceof GatewayError ? err : undefined;
      const code = gatewayError?.code ?? "transport_unavailable";
      const origin = gatewayError?.origin ?? "network";
      const message = gatewayError
        ? explainGatewayError(gatewayError)
        : formatPublicErrorMessage(code, "Upstream stream failed");
      // Merge upstream details when available so a provider-reported error keeps its requestId/code.
      const details = gatewayError ? publicGatewayErrorDetails(gatewayError) : {};
      // For cb gpt-6.1-sol style invoke errors, upstream extError is already in gatewayError details via provider pipeline.
      pipeline.emitErrorFrame({ origin, code, message, details }, controller);
    }
    controller.close();
    void this.releaseStreamResources();
  }

  /**
   * Completion context shared by every terminal outcome of this stream.
   *
   * Built once rather than written out at each `completeAttempt` call. Three
   * hand-written copies had already drifted: the success path and the
   * truncation path both carried `networkPoolId`, and the error path did not
   * — so a pool that failed a stream was never parked, which is exactly the
   * pool an operator needs taken out of rotation. The effect is not cosmetic:
   * `completeAttempt` gates `recordPoolDispatchOutcome` (and the 402/407
   * `disablePoolForProxyHttpStatus` branch) on this field, and omitting it
   * silently skipped both.
   *
   * The account and pool fields are conditionally spread so an absent value
   * stays absent rather than becoming an explicit `undefined`, which
   * `exactOptionalPropertyTypes` and the completion contract both distinguish.
   */
  private streamCompletionContext() {
    const { state, deps, prepared, candidate, providerCapture, lease } = this.input;
    return completionContext({
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      tenantId: prepared.authorization.tenantId,
      ingressBody: state.ingressBody,
      providerCapture,
      db: deps.db,
      ...(candidate.accountId ? { accountId: candidate.accountId } : {}),
      ...(candidate.accountLabel ? { accountLabel: candidate.accountLabel } : {}),
      ...(candidate.networkPoolId ? { networkPoolId: candidate.networkPoolId } : {}),
      ...(lease ? { lease } : {}),
      ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
      ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
    });
  }
}

/**
 * The streaming half of provider dispatch: one candidate's SSE response, from
 * the primed first upstream event to the client's last frame.
 *
 * This is the gateway's hottest and most consequential path. It owns the
 * admission lease, the routing reservation, and the network-pool slot for the
 * whole body lifetime — a response returned here outlives the attempt loop that
 * created it, so releasing them is this module's job and no one else's. It was
 * extracted from `proxy-request.ts`, where it sat as a 672-line closure inside
 * an already-long handler; the seam is real rather than cosmetic because the
 * branch reads a fixed set of values and returns a `Response`, and nothing
 * outside it depends on how it is organised.
 *
 * The shape worth understanding before editing:
 *
 * - **The first upstream event is primed before the response is committed.**
 *   Returning an SSE `Response` flushes `200 OK`, so a candidate that cannot
 *   produce even one event must fail *before* that point, letting the attempt
 *   loop advance to the next candidate instead of emitting an error into a
 *   stream the client already sees as successful.
 * - **`pull` demand-drives the upstream.** The runtime calls `pull` only when
 *   the consumer has drained the queue, which is where backpressure comes from.
 *   A `pull` that returns without enqueuing can leave Web Streams waiting
 *   forever, so the inner loop keeps reading until a wire chunk is produced.
 * - **Release is single-shot and coordinated with abort.** `streamReleased`
 *   makes release idempotent; `pullActive` tells the abort listener whether a
 *   pending pull owns the release or the listener must do it itself (a
 *   half-closed client leaves no pull to catch the abort).
 * - **A stream that ends without a terminal event is a failure.** It is
 *   reported as `finish_reason: error`, never as a clean `stop`.
 *
 * `test/gateway/streaming-contract.test.ts` pins the observable contract — the
 * encoded frames a client reads and the in-flight gauge returning to zero — so
 * a change here that alters behavior fails there.
 */
import { GatewayError, explainGatewayError, formatPublicErrorMessage, publicGatewayErrorDetails } from "../gateway-error";
import { classifyTerminalOutcome } from "../failure-policy";
import type { CanonicalEvent, CanonicalRequest, UsageRecord } from "../canonical-model";
import type { ProviderAdapter, ResolvedCredential } from "../../providers/provider-registry";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { Reservation, RouteCandidate, RouteSnapshotService } from "../routing/route-model";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProviderExchangeCapture } from "./attempt-finalize";
import { releaseAttemptLeases } from "./leases";
import { proxySuccessHeaders, buildUpstreamDispatchContext } from "./upstream";
import { createDispatchStreamEncoder } from "./stream-bridge";
import { shouldCooldownPool } from "./retry-policy";
import { metrics } from "../../observability/metrics";
import { flagPoolCooldown } from "../../network/pool-health";
import { resolveStreamFirstChunkTimeoutMs, resolveStreamStallTimeoutMs, resolveUpstreamTimeoutMs } from "../../config";
import type { ProxyRequestState } from "../request/state";
import type { PreparedProxyRequest } from "../request/preparer";
import { repriceUsage } from "../../providers/usage";
import { finalizeRequestTelemetry } from "../middleware/error-lifecycle";
import {
  captureProviderExchange,
  completeAttempt,
  completionContext,
  estimatedUsage,
  terminalFailure,
} from "./attempt-finalize";
import { drainAbortReason } from "../shutdown-notice";

/** Collaborators the streaming branch reads from the dispatch handler. */
export interface StreamingDispatchDeps {
  readonly db: CartethyiaDatabase;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory | undefined;
  readonly poolSelector?: NetworkPoolSelector | undefined;
  readonly snapshotService?: RouteSnapshotService | undefined;
  readonly telemetryBuffer?: TelemetryBatchBuffer | undefined;
}

/** Everything one streamed attempt needs, all resolved by its caller. */
export interface StreamingDispatchInput {
  readonly state: ProxyRequestState;
  readonly deps: StreamingDispatchDeps;
  readonly prepared: PreparedProxyRequest;
  readonly canonicalRequest: CanonicalRequest;
  readonly candidate: RouteCandidate;
  readonly credential: ResolvedCredential;
  readonly adapter: ProviderAdapter;
  /** The request as projected for this candidate's route. */
  readonly dispatchRequest: CanonicalRequest;
  /** The candidate in the shape the adapter contract expects. */
  readonly providerRouteCandidate: unknown;
  readonly inboundHeaders: Record<string, string>;
  readonly conversationAffinity: string | undefined;
  readonly lease: AdmissionLease;
  readonly reservation: Reservation;
  readonly proxySlot: { poolId: string; release: () => void } | undefined;
  readonly networkPoolId: string | undefined;
  readonly providerCapture: ProviderExchangeCapture;
  /** Hands lease ownership to the returned `Response`'s async lifetime. */
  retainLeases: () => void;
  /** First-token latency in the spread shape `completeAttempt` accepts. */
  readonly ttfbFields: (
    firstByteAt: number | undefined,
    firstContentDeltaAtMs: number | undefined,
    startedAtMs: number | undefined,
  ) => { ttfbMs?: number };
}

/**
 * Streams one candidate's answer to the client.
 *
 * Never throws for an upstream failure: by the time the body streams, `200 OK`
 * is already on the wire, so every failure rides in the frames. A throw is
 * reserved for the pre-commit window, where the attempt loop can still fail
 * over to another candidate.
 */
export async function dispatchStreamingAttempt(input: StreamingDispatchInput): Promise<Response> {
  const {
    state,
    deps,
    prepared,
    canonicalRequest,
    candidate,
    credential,
    adapter,
    dispatchRequest,
    providerRouteCandidate,
    inboundHeaders,
    conversationAffinity,
    lease,
    reservation,
    proxySlot,
    networkPoolId,
    providerCapture,
    retainLeases,
    ttfbFields,
  } = input;

  const outboundFetch = deps.networkBindingFactory?.fetch(
    networkPoolId,
    prepared.authorization.snapshot.tenant_id,
  );
  const wrappedOutboundFetch = outboundFetch
    ? captureProviderExchange(outboundFetch, providerCapture)
    : undefined;
  const dispatchContext = buildUpstreamDispatchContext({
    credential,
    deadline: state.deadlineMs,
    signal: state.abortController.signal,
    headers: inboundHeaders,
    requestIdentity: state,
    ...(conversationAffinity ? { conversationAffinity } : {}),
    ...(candidate.user_agent === undefined ? {} : { userAgent: candidate.user_agent }),
    ...(wrappedOutboundFetch ? { outboundFetch: wrappedOutboundFetch } : {}),
    ...(deps.networkBindingFactory
      ? {
          outboundWebSocket: deps.networkBindingFactory.webSocket(
            networkPoolId,
            prepared.authorization.snapshot.tenant_id,
          ),
        }
      : {}),
  });
  // `ProviderAdapter.dispatch` is declared to return a non-nullable
  // `AsyncIterable`, so an adapter that returned `undefined` would be a
  // type violation rather than a state this code could handle. The guard
  // that used to sit here (`if (!iterable) throw ...`) was therefore
  // unreachable, and it advertised a contract the interface does not
  // have. Enforcing it belongs at the adapter boundary, not here.
  const createUpstreamIterable = () =>
    adapter.dispatch(
      dispatchRequest,
      providerRouteCandidate as never,
      dispatchContext as never,
    );
  let iterable = createUpstreamIterable();
  const streamLease = lease;
  const streamReservation = reservation;
  const streamProxySlot = proxySlot;
  const streamNetworkPoolId = networkPoolId;
  const streamProviderId = candidate.provider_id;
  const streamAccountId = candidate.provider_account_id;
  const streamAccountLabel = candidate.provider_account_label;
  /**
   * Completion context shared by every terminal outcome of this stream.
   *
   * Built once rather than written out at each `completeAttempt` call. Three
   * hand-written copies had already drifted: the success path and the
   * truncation path both carried `networkPoolId`, and the error path did not —
   * so a pool that failed a stream was never parked, which is exactly the pool
   * an operator needs taken out of rotation. The effect is not cosmetic:
   * `completeAttempt` gates `recordPoolDispatchOutcome` (and the 402/407
   * `disablePoolForProxyHttpStatus` branch) on this field, and omitting it
   * silently skipped both.
   *
   * The account and pool fields are conditionally spread so an absent value
   * stays absent rather than becoming an explicit `undefined`, which
   * `exactOptionalPropertyTypes` and the completion contract both distinguish.
   */
  const streamCompletionContext = () =>
    completionContext({
      providerId: streamProviderId,
      modelId: candidate.model_id,
      tenantId: prepared.authorization.tenantId,
      ingressBody: state.ingressBody,
      providerCapture,
      db: deps.db,
      ...(streamAccountId ? { accountId: streamAccountId } : {}),
      ...(streamAccountLabel ? { accountLabel: streamAccountLabel } : {}),
      ...(streamNetworkPoolId ? { networkPoolId: streamNetworkPoolId } : {}),
      ...(streamLease ? { lease: streamLease } : {}),
      ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
      ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
    });
  const streamOptions = {
    created: Date.now() / 1000,
    include_usage: canonicalRequest.generation_controls["extension:include_usage"] === true,
  };
  // Prime the very first upstream event BEFORE committing the HTTP 200
  // response (which flushes headers). If candidate 0 cannot even produce
  // its first event, the error propagates to the outer candidate loop
  // (which advances to the next candidate) instead of firing inside
  // `start` after the response was already returned.
  let iterator = iterable[Symbol.asyncIterator]();
  // Mark the moment we actually pull from the upstream adapter; this is
  // the zero point for time-to-first-token.
  state.upstreamDispatchStartedAtMs = Date.now();
  const first: IteratorResult<CanonicalEvent> = await iterator.next();
  // Shared streaming state and helpers lifted into the closure so
  // `start` seeds the primed event and `pull` demand-drives the rest:
  // the runtime only calls `pull` when the consumer has drained its
  // queue (desiredSize > 0), giving natural backpressure without the
  // old 4ms busy-poll loop.
  let terminal: Extract<CanonicalEvent, { type: "terminal" }> | undefined;
  let upstreamTruncated = false;
  let usage: UsageRecord | undefined;
  let firstByteAt: number | undefined;
  let firstContentDeltaAtMs: number | undefined;
  let lastEventAtMs: number | undefined;
  // Any upstream event (even surface-invisible) proves liveness for
  // watchdog bound selection.
  let sawUpstreamActivity = false;
  // Canonical events streamed to the client; captured as the response
  // body for telemetry so streaming tool calls/text are traceable.
  const streamedEvents: CanonicalEvent[] = [];
  // The actual client-facing response transcript (decoded SSE/JSON) —
  // distinct from the provider-side canonical events above.
  let clientResponseText = "";
  const CLIENT_RESPONSE_CAP = 512 * 1024;
  // SSE comment frame: valid framing on every streamed surface,
  // ignored by EventSource clients. Never part of content/telemetry.
  const KEEPALIVE_COMMENT_BYTES = new TextEncoder().encode(": keepalive\n\n");
  const CLIENT_SSE_KEEPALIVE_INTERVAL_MS = 15_000;
  // One decoder per stream: `new TextDecoder()` per chunk would allocate
  // on every upstream event for the telemetry transcript copy.
  const clientResponseDecoder = new TextDecoder();
  const appendClientResponse = (bytes: Uint8Array): void => {
    if (clientResponseText.length >= CLIENT_RESPONSE_CAP) return;
    clientResponseText += clientResponseDecoder.decode(bytes, { stream: true });
    if (clientResponseText.length > CLIENT_RESPONSE_CAP)
      clientResponseText = clientResponseText.slice(0, CLIENT_RESPONSE_CAP);
  };
  const streamEncoder = createDispatchStreamEncoder(
    canonicalRequest.source_surface,
    canonicalRequest.source_surface === "completion"
      ? {
          model: candidate.model_id,
          created: Date.now() / 1000,
          prompt: canonicalRequest.generation_controls["extension:completion.prompt"],
          echo: canonicalRequest.generation_controls["extension:completion.echo"] === true,
          suffix: canonicalRequest.generation_controls["extension:completion.suffix"],
        }
      : canonicalRequest.source_surface === "messages"
        ? { response_id: `msg-${crypto.randomUUID()}`, model: candidate.model_id }
        : streamOptions,
  );
  const recoverableResponsesPrelude = candidate.wire_family === "responses";
  let clientVisibleEvent = false;
  let preContentRetryCount = 0;
  const isClientVisibleEvent = (event: CanonicalEvent): boolean => {
    if (event.type === "tool_call_delta" || event.type === "tool_result") return true;
    if (event.type === "content_delta") {
      // Extension payloads carry no client-renderable content. Reasoning
      // deltas do: they drive the reasoning pane, and withholding them
      // until the first answer token left the client blank for the whole
      // reasoning phase (seconds to minutes). A reasoning delta commits
      // the candidate the same way answer text does.
      return event.content.kind !== "extension";
    }
    return event.type === "terminal" && event.state === "complete";
  };
  const pushEncodedEvent = (
    event: CanonicalEvent & { timestamp: number },
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    const toEnqueue = streamEncoder.push(event);
    if (toEnqueue.length > 0 && firstByteAt === undefined) firstByteAt = Date.now();
    for (const bytes of toEnqueue) {
      controller.enqueue(bytes);
      appendClientResponse(bytes);
    }
    return toEnqueue.length > 0;
  };
  const enqueueEvent = (
    event: CanonicalEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    const timestampedEvent = { ...event, timestamp: Date.now() };
    streamedEvents.push(timestampedEvent);
    lastEventAtMs = timestampedEvent.timestamp;

    if (event.type === "content_delta" && firstContentDeltaAtMs === undefined) {
      firstContentDeltaAtMs = timestampedEvent.timestamp;
    }

    if (event.type === "terminal") {
      terminal = event as Extract<CanonicalEvent, { type: "terminal" }>;
      if (event.usage) usage = event.usage;
    } else if (event.type === "usage") {
      usage = event.usage;
    }
    // A Responses prelude that carries no client-renderable content
    // (response_start, usage, extension deltas) is tracked so a provider
    // that closes before producing anything can be retried once. It is
    // streamed as it arrives, not held: holding it until the first answer
    // token blanked the client for the whole reasoning phase, which is the
    // perceived "first response is slow and doesn't chunk" behavior.
    if (recoverableResponsesPrelude && isClientVisibleEvent(event)) {
      clientVisibleEvent = true;
    }
    return pushEncodedEvent(timestampedEvent, controller);
  };
  const finishEncoders = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const bytes of streamEncoder.finish()) {
      controller.enqueue(bytes);
      appendClientResponse(bytes);
    }
  };

  const retryUncommittedResponsesPrelude = async (): Promise<boolean> => {
    if (
      !recoverableResponsesPrelude ||
      clientVisibleEvent ||
      preContentRetryCount >= 1 ||
      state.abortController.signal.aborted
    )
      return false;
    preContentRetryCount += 1;
    try {
      await iterator.return?.();
    } catch {
      // The failed provider iterator is already being discarded.
    }
    // Only prelude events can be buffered here: the retry guard requires
    // `!clientVisibleEvent`, so nothing client-visible is discarded.
    streamedEvents.length = 0;
    terminal = undefined;
    usage = undefined;
    lastEventAtMs = undefined;
    sawUpstreamActivity = false;
    iterable = createUpstreamIterable();
    iterator = iterable[Symbol.asyncIterator]();
    state.upstreamDispatchStartedAtMs = Date.now();
    return true;
  };
  /**
   * Max time between upstream events before the stream is declared
   * stalled, and max time to the first client-visible chunk. Both are
   * resolved from config once per stream (`CARTETHYIA_STREAM_STALL_TIMEOUT_MS`
   * defaults to 360s, `CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS` to 200s).
   * The stall bound is sized to stay *above* every legitimate long
   * silence: provider-side reasoning/long-context generation can hold
   * silence for minutes (Codex/o1-style hidden reasoning up to ~5 min),
   * and the bound must also comfortably exceed transient upstream
   * connection pauses. It sits below the derived pool-slot crash-recovery
   * TTL (`network-pool.ts` `poolInflightTtlSeconds`, the request deadline
   * plus this stall budget plus a buffer) so the watchdog always releases
   * the lease before the crash-recovery sweep could ever reclaim it,
   * and far below the hourly lease TTL in admission. The watchdog is
   * re-armed on every upstream read, so it measures the inter-event gap,
   * not stream duration; until the first client-visible byte lands it
   * uses the tighter first-chunk bound instead of the stall bound.
   */
  const streamStallTimeoutMs = resolveStreamStallTimeoutMs();
  const streamFirstChunkTimeoutMs = resolveStreamFirstChunkTimeoutMs();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallWatchdog = () => {
    clearTimeout(stallTimer);
    // Once the upstream has produced anything — even surface-invisible
    // reasoning deltas — it is alive: the stall bound governs and the
    // tighter first-chunk bound no longer applies. The hard ceiling
    // (state deadline) still caps total duration.
    const timeoutMs =
      firstByteAt === undefined && !sawUpstreamActivity
        ? streamFirstChunkTimeoutMs
        : streamStallTimeoutMs;
    stallTimer = setTimeout(() => {
      // The bound that expired is silence *from the upstream*, so the
      // origin is the upstream's: labelling it `cartethyia` reported a
      // provider that stopped sending as a gateway defect.
      state.abortController.abort(
        new GatewayError("deadline_exceeded", 504, "upstream stream stalled", {}, "upstream"),
      );
    }, timeoutMs);
  };
  const clearStallWatchdog = () => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  // Single-shot guards: exactly one of finalizeStream /
  // emitStreamErrorAndClose may record the terminal outcome, and
  // releaseStreamResources runs once. A client disconnect racing
  // stream completion otherwise cascades — controller.close() throws
  // on the dead controller, routing the completed stream back into
  // the error path and emitting duplicate telemetry rows (and a
  // second resource release) for one request.
  let streamSettled = false;
  let streamReleased = false;
  // True only while a `pull()` is awaiting the upstream iterator. A
  // watchdog abort that lands during a pull is caught by that pull's own
  // handler; one that lands while the stream is paused (the client
  // stopped reading, so no pull is pending) has no reader to catch it and
  // must be released by the abort listener instead.
  let pullActive = false;
  let clientKeepaliveTimer: ReturnType<typeof setInterval> | undefined;
  const clearClientKeepaliveTimer = () => {
    if (clientKeepaliveTimer !== undefined) clearInterval(clientKeepaliveTimer);
    clientKeepaliveTimer = undefined;
  };

  /**
   * Fires when the request controller aborts. Every abort here must end in
   * a release, because the alternative is a flight that never leaves the
   * gauge:
   *
   * - **Client disconnect** (an `AbortError` bridged from the inbound
   *   signal). The client is gone, so no frame would reach it: release
   *   here.
   * - **Drain** (a typed shutdown `GatewayError`). The client is still
   *   reading, so the terminal frame matters — let `pull()` emit it and
   *   release; releasing here would finalize telemetry before the frame
   *   and could double-finalize.
   * - **Deadline / stall watchdog** (`deadline_exceeded`, `TimeoutError`).
   *   These *usually* fire from inside `pull()`'s watchdog, which already
   *   records the terminal outcome and releases — but `pull()` runs only
   *   when the consumer asks for more data. A client that half-closes
   *   (stops reading, keeps the socket) leaves no pending `pull()`, so the
   *   watchdog abort lands with nothing to catch it and the flight leaked
   *   for the life of the process. That is why the release cannot be
   *   skipped on the *assumption* that a pull is watching: gate it on
   *   whether a pull is actually in flight.
  /**
   * Upstream iterator settle budget. An upstream generator whose `return()`
   * never settles (pending read the abort never rejects) would otherwise hold
   * the admission lease, pool slot, and reservation forever — the exact leak
   * the inflight backstop force-releases. The fetch is already torn down by
   * the abort, so after this budget the gateway releases unconditionally.
   */
  const ITERATOR_SETTLE_TIMEOUT_MS = 10_000;
  async function settleUpstreamIterator(): Promise<void> {
    try {
      await Promise.race([
        iterator.return?.() ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, ITERATOR_SETTLE_TIMEOUT_MS)),
      ]);
    } catch {
      // Upstream iterator cleanup on abort is best-effort.
    }
  }
  function onStreamAbort(): void {
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
    if (pullActive && !clientDisconnect) return;
    if (clientDisconnect && !state.outcome) {
      state.outcome = { status: "cancelled", httpStatus: 499 };
    }
    void (async () => {
      await settleUpstreamIterator();
      await releaseStreamResources();
    })();
  }
  // The client may already be gone before the stream is even constructed.
  if (state.abortController.signal.aborted) onStreamAbort();

  async function releaseStreamResources() {
    if (streamReleased) return;
    streamReleased = true;
    state.abortController.signal.removeEventListener("abort", onStreamAbort);
    clearClientKeepaliveTimer();
    clearStallWatchdog();
    await releaseAttemptLeases(
      {
        lease: streamLease,
        reservation: streamReservation,
        proxySlot: streamProxySlot,
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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clientKeepaliveTimer = setInterval(() => {
        if (streamSettled || streamReleased || state.abortController.signal.aborted) {
          clearClientKeepaliveTimer();
          return;
        }
        // Do not accumulate comments when the consumer is applying
        // backpressure; the next pull will resume normal streaming.
        if (controller.desiredSize !== null && controller.desiredSize > 0)
          controller.enqueue(KEEPALIVE_COMMENT_BYTES);
      }, CLIENT_SSE_KEEPALIVE_INTERVAL_MS);
      if (!first.done) enqueueEvent(first.value, controller);
    },
    async pull(controller) {
      pullActive = true;
      try {
        if (state.abortController.signal.aborted) {
          const reason = state.abortController.signal.reason;
          // A drain is a *server* close while the client is still reading:
          // emit the terminal frame so it is not seen as a truncation.
          const drainFailure = drainAbortReason(reason);
          const deadlineFailure =
            reason instanceof GatewayError && reason.code === "deadline_exceeded"
              ? reason
              : reason instanceof DOMException && reason.name === "TimeoutError"
                ? new GatewayError(
                    "deadline_exceeded",
                    504,
                    "request deadline exceeded",
                    {},
                    "cartethyia",
                  )
                : undefined;
          const closeFailure = drainFailure ?? deadlineFailure;
          if (closeFailure) {
            // Hard deadline / stall watchdog / server drain: emit an SSE
            // error so the client sees the failure instead of a silent
            // socket close that Usage records as a generic streaming 500.
            try {
              await emitStreamErrorAndClose(closeFailure, controller);
            } finally {
              void releaseStreamResources();
            }
          } else {
            try {
              await iterator.return?.();
            } catch {
              // Upstream iterator cleanup on abort is best-effort.
            }
            await releaseStreamResources();
            controller.close();
          }
          return;
        }
        try {
          // A canonical event may be intentionally invisible on the
          // selected client surface (for example xAI's encrypted
          // reasoning item when the client is Chat Completions). Keep
          // pulling until at least one wire chunk is enqueued; returning
          // from pull with an empty queue can leave Web Streams waiting
          // forever, which is why real clients previously saw one
          // assistant header and then a 60s socket reset.
          for (;;) {
            // Re-arm on every upstream read: the watchdog fires only
            // when the provider stays silent longer than the bound.
            armStallWatchdog();
            let result: IteratorResult<CanonicalEvent>;
            try {
              result = await iterator.next();
            } catch (err) {
              clearStallWatchdog();
              if (await retryUncommittedResponsesPrelude()) continue;
              throw err;
            }
            clearStallWatchdog();
            if (result.done) {
              if (await retryUncommittedResponsesPrelude()) continue;
              await finalizeStream(controller);
              return;
            }
            sawUpstreamActivity = true;
            if (enqueueEvent(result.value, controller)) return;
          }
        } catch (err) {
          clearStallWatchdog();
          // A drain that landed mid-read aborts the pending `next()`, which
          // rejects here. Emit the shutdown terminal frame rather than
          // synthesizing a truncation terminal and a generic 502.
          const drain = drainAbortReason(state.abortController.signal.reason);
          try {
            await emitStreamErrorAndClose(drain ?? err, controller);
          } finally {
            // The release must not depend on the error path completing:
            // anything that throws above it (a bookkeeping call, a dead
            // controller) would otherwise skip it, and `afterResponse`
            // cannot rescue a request whose `state.streaming` is set. The
            // `streamReleased` guard makes this safe to reach twice.
            void releaseStreamResources();
          }
        }
      } finally {
        // The watchdog abort and the abort listener coordinate through
        // this flag: while a pull is pending it owns the release; once
        // pull returns, an abort with no reader must release itself.
        pullActive = false;
      }
    },
    async cancel() {
      // A cancelled stream may never see another pull(), so abort alone
      // would leak the quota lease, routing reservation, and pool slot.
      // Close the upstream iterator and release everything here; the
      // streamReleased guard keeps this idempotent against a pull()
      // racing on the abort. The settle budget bounds a hung iterator so
      // cancel itself cannot wedge behind it.
      state.abortController.abort(new DOMException("client disconnect", "AbortError"));
      await settleUpstreamIterator();
      await releaseStreamResources();
    },
  });

  async function finalizeStream(controller: ReadableStreamDefaultController<Uint8Array>) {
    try {
      if (!terminal) {
        upstreamTruncated = true;
        enqueueEvent(
          {
            type: "terminal",
            sequence_number: streamedEvents.length + 1,
            state: "aborted",
            stop_reason: "error",
          },
          controller,
        );
      }
      if (terminal === undefined) throw terminalFailure(undefined);
      const terminalError = terminalFailure(terminal, { truncated: upstreamTruncated });
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
      finishEncoders(controller);
      const finalUsage = repriceUsage(
        terminal.usage ?? usage ?? estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens),
        streamProviderId,
        candidate.model_id,
      );
      await completeAttempt(state, {
        status: upstreamTruncated ? "truncated" : "completed",
        ...streamCompletionContext(),
        ...ttfbFields(firstByteAt, firstContentDeltaAtMs, state.upstreamDispatchStartedAtMs),
        ...(upstreamTruncated
          ? {
              errorCategory: "transport_unavailable",
              errorOrigin: "upstream",
              error: truncationError,
            }
          : {}),
        usage: finalUsage,
        commitUsage: finalUsage,
        responseBody: streamedEvents,
        ...(clientResponseText ? { clientResponseText } : {}),
        ...(firstContentDeltaAtMs !== undefined ? { firstContentDeltaAtMs } : {}),
        ...(lastEventAtMs !== undefined ? { lastEventAtMs } : {}),
      });
      metrics.proxy_requests_total.inc(1, {
        status: upstreamTruncated ? "truncated" : "completed",
      });
      controller.close();
    } catch (err) {
      await emitStreamErrorAndClose(err, controller);
    } finally {
      void releaseStreamResources();
    }
  }

  async function emitStreamErrorAndClose(err: unknown, controller: ReadableStreamDefaultController<Uint8Array>) {
    // Already recorded (completed or failed) — e.g. controller.close()
    // threw on the dead controller after a recorded completion. Return
    // without recording again; the caller's finally still releases.
    if (streamSettled) return;
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
      ...streamCompletionContext(),
      ...ttfbFields(firstByteAt, firstContentDeltaAtMs, state.upstreamDispatchStartedAtMs),
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
      responseBody: streamedEvents.length > 0 ? streamedEvents : null,
      ...(clientResponseText.length > 0 ? { clientResponseText } : {}),
    });
    streamSettled = true;
    if (streamNetworkPoolId && !cancelled && deps.poolSelector && shouldCooldownPool(err, streamProviderId)) {
      flagPoolCooldown(deps.poolSelector, deps.db, streamNetworkPoolId, streamProviderId, err);
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
      for (const bytes of streamEncoder.encodeError({ origin, code, message, details })) {
        controller.enqueue(bytes);
        appendClientResponse(bytes);
      }
    }
    controller.close();
    void releaseStreamResources();
  }
  // Ownership of the lease handles now belongs to the stream's async
  // lifetime; handing them over only after the ReadableStream has been
  // successfully constructed avoids a leak if `new ReadableStream(...)`
  // itself throws — in which case `start` never runs and the attempt
  // loop's `finally` must still release them.
  retainLeases();
  // Set before returning so `afterResponse` lifecycle hooks (telemetry +
  // cleanup) skip this request and let stream completion/cancel finalize.
  state.streaming = true;
  // Re-arm the request deadline so the stream watchdogs, not the shorter
  // pre-stream deadline, govern body duration. The hard ceiling becomes
  // pre-stream budget + stall budget, which is exactly the 480s pool-slot
  // crash-recovery budget the network pool is sized for.
  state.extendDeadline(
    Math.max(
      0,
      state.startedAtMs + resolveUpstreamTimeoutMs() + streamStallTimeoutMs - Date.now(),
    ),
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      connection: "keep-alive",
      ...proxySuccessHeaders(state),
      // Intermediaries (nginx, Cloudflare, corporate proxies) otherwise
      // buffer the whole SSE response and flush it at the end, which
      // makes a live stream look like one delayed chunk. `no-transform`
      // forbids compression and `x-accel-buffering: no` disables nginx
      // proxy buffering for this response. These override the generic
      // `cache-control: no-store` above, which a proxy may still buffer.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

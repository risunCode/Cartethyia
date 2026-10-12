/**
 * The streaming half of provider dispatch: one candidate's SSE response, from
 * the primed first upstream event to the client's last frame.
 *
 * This is the gateway's hottest and most consequential path. It owns the
 * admission lease, the routing reservation, and the network-pool slot for the
 * whole body lifetime — a response returned here outlives the attempt loop that
 * created it, so releasing them is this module's job and no one else's. It was
 * extracted from `proxy-request.ts` (and again, internally, into
 * `encoder.ts` / `finalize.ts`) along real seams: the branch reads a fixed set
 * of values and returns a `Response`, and nothing outside it depends on how it
 * is organised.
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
 *   makes release idempotent; `pullActive` tells the abort handler whether a
 *   pending pull owns the release or the handler must do it itself (a
 *   half-closed client leaves no pull to catch the abort).
 * - **A stream that ends without a terminal event is a failure.** It is
 *   reported as `finish_reason: error`, never as a clean `stop`.
 *
 * `test/gateway/streaming-contract.test.ts` pins the observable contract — the
 * encoded frames a client reads and the in-flight gauge returning to zero — so
 * a change here that alters behavior fails there.
 */
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import type { ProviderAdapter, ResolvedCredential } from "../../../providers/contracts";
import type { ValidatedNetworkBindingFactory } from "../../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { Reservation, RouteCandidate, RouteSnapshotService } from "../../routing/route-model";
import type { AdmissionLease } from "../../../security/admission/contracts";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import type { ProviderExchangeCapture } from "../attempt-finalize";
import { captureProviderExchange } from "../attempt-finalize";
import { proxySuccessHeaders, buildUpstreamDispatchContext } from "../upstream";
import { resolveStreamFirstChunkTimeoutMs, resolveStreamStallTimeoutMs, resolveUpstreamTimeoutMs } from "../../../config/timeouts";
import type { ProxyRequestState } from "../../request/state";
import type { PreparedProxyRequest } from "../../request/preparer";
import { drainAbortReason } from "../../shutdown-notice";
import { StreamEventPipeline } from "./encoder";
import { StreamFinalizer, type StreamCandidateIdentity } from "./finalize";

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
  /** Fallback search hits to echo before the selected model's frames. */
  readonly servedSearch?: readonly CanonicalEvent[];
  /** Search-tool loop collaborators, when this attempt may run a function `web_search`. */
  readonly searchLoop?: {
    readonly run: (request: CanonicalRequest, events: readonly CanonicalEvent[]) => Promise<{ events: readonly CanonicalEvent[]; served: boolean }>;
  };
  /** Hands lease ownership to the returned `Response`'s async lifetime. */
  retainLeases: () => void;
  /** First-token latency in the spread shape `completeAttempt` accepts. */
  readonly ttfbFields: (
    firstByteAt: number | undefined,
    firstContentDeltaAtMs: number | undefined,
    startedAtMs: number | undefined,
  ) => { ttfbMs?: number };
}

/** How often the SSE keepalive comment frame is sent while the stream is idle. */
const CLIENT_SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Settles a pending provider read when the owning request is aborted. */
function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("request aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
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
    servedSearch,
    searchLoop,
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
  const streamOptions = {
    created: Date.now() / 1000,
    include_usage: canonicalRequest.generation_controls["extension:include_usage"] === true,
  };
  let iterable = createUpstreamIterable();
  let iterator = iterable[Symbol.asyncIterator]();
  state.upstreamDispatchStartedAtMs = Date.now();
  let first: IteratorResult<CanonicalEvent> = await nextWithAbort(iterator, state.abortController.signal);
  // Function-tool search loop: collect the first attempt, and when it ends
  // in a `web_search` call, run the configured search and dispatch again.
  // This runs before any client byte is sent, so the stream still shows a
  // single coherent answer; it only delays the first byte when the model
  // actually asked for search.
  let searchLoopEvents: CanonicalEvent[] | undefined;
  if (searchLoop !== undefined && !first.done) {
    let collected: CanonicalEvent[] = [first.value];
    for (;;) {
      const result = await nextWithAbort(iterator, state.abortController.signal);
      if (result.done) break;
      collected.push(result.value);
    }
    for (let round = 0; round < 4; round += 1) {
      const looped = await searchLoop.run(dispatchRequest, collected);
      if (!looped.served) break;
      collected = [...looped.events];
    }
    searchLoopEvents = collected;
    // The final loop pass is fully buffered; the stream just replays it.
    first = { done: true, value: undefined };
  }

  const candidateIdentity: StreamCandidateIdentity = {
    providerId: candidate.provider_id,
    modelId: candidate.model_id,
    accountId: candidate.provider_account_id,
    accountLabel: candidate.provider_account_label,
    networkPoolId,
  };
  // Any upstream event (even surface-invisible) proves liveness for
  // watchdog bound selection.
  let sawUpstreamActivity = false;
  // A Responses-family wire may deliver a prelude with no client-renderable
  // content; the retry guard below keys on this flag.
  const recoverableResponsesPrelude = candidate.wire_family === "responses";
  const pipeline = new StreamEventPipeline(
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
    recoverableResponsesPrelude,
  );
  const finalizer = new StreamFinalizer(
    {
      state,
      deps: {
        db: deps.db,
        poolSelector: deps.poolSelector,
        telemetryBuffer: deps.telemetryBuffer,
        snapshotService: deps.snapshotService,
      },
      prepared,
      candidate: candidateIdentity,
      lease,
      reservation,
      proxySlot,
      providerCapture,
      getIterator: () => iterator,
      ttfbFields,
    },
    pipeline,
    {
      stallTimeoutMs: resolveStreamStallTimeoutMs(),
      firstChunkTimeoutMs: resolveStreamFirstChunkTimeoutMs(),
    },
  );

  let preContentRetryCount = 0;
  const retryUncommittedResponsesPrelude = async (): Promise<boolean> => {
    if (
      !recoverableResponsesPrelude ||
      pipeline.hasClientVisibleEvent ||
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
    pipeline.resetUncommittedPrelude();
    sawUpstreamActivity = false;
    iterable = createUpstreamIterable();
    iterator = iterable[Symbol.asyncIterator]();
    state.upstreamDispatchStartedAtMs = Date.now();
    return true;
  };

  const failureForAbort = (): GatewayError | undefined =>
    finalizer.abortFailure(state.abortController.signal.reason);

  const finishAbortedPull = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    const failure = failureForAbort();
    if (!failure) {
      await finalizer.releaseStreamResources();
      try {
        controller.close();
      } catch {
        // The client may have cancelled the body while the abort was handled.
      }
      return;
    }
    try {
      await finalizer.emitStreamErrorAndClose(failure, controller);
    } finally {
      void finalizer.releaseStreamResources();
    }
  };

  // The client may already be gone before the stream is even constructed.
  if (state.abortController.signal.aborted) finalizer.onStreamAbort();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      finalizer.attachController(controller);
      if (state.abortController.signal.aborted) return;
      finalizer.startClientKeepalive(controller, CLIENT_SSE_KEEPALIVE_INTERVAL_MS);
      for (const event of servedSearch ?? []) pipeline.enqueueEvent(event, controller);
      if (searchLoopEvents !== undefined) {
        for (const event of searchLoopEvents) pipeline.enqueueEvent(event, controller);
        // The loop already buffered the full answer, so this stream is done
        // after replay. Await it here: `pull` never runs for a stream whose
        // `start` closes it, and awaiting keeps completion bookkeeping out of
        // a fire-and-forget race with the reader.
        await finalizer.finalizeStream(controller);
        return;
      }
      if (!first.done) pipeline.enqueueEvent(first.value, controller);
    },
    async pull(controller) {
      finalizer.pullActive = true;
      try {
        if (state.abortController.signal.aborted) {
          await finishAbortedPull(controller);
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
            finalizer.armStallWatchdog(sawUpstreamActivity);
            let result: IteratorResult<CanonicalEvent>;
            try {
              result = await nextWithAbort(iterator, state.abortController.signal);
            } catch (err) {
              finalizer.clearStallWatchdog();
              if (await retryUncommittedResponsesPrelude()) continue;
              throw err;
            }
            finalizer.clearStallWatchdog();
            if (state.abortController.signal.aborted) {
              await finishAbortedPull(controller);
              return;
            }
            if (result.done) {
              if (await retryUncommittedResponsesPrelude()) continue;
              await finalizer.finalizeStream(controller);
              return;
            }
            sawUpstreamActivity = true;
            if (pipeline.enqueueEvent(result.value, controller)) return;
          }
        } catch (err) {
          finalizer.clearStallWatchdog();
          const abortFailure = failureForAbort();
          if (state.abortController.signal.aborted && !abortFailure) {
            await finishAbortedPull(controller);
            return;
          }
          // A drain or deadline that landed mid-read aborts the pending
          // `next()`. Preserve that typed reason instead of reporting a
          // generic upstream failure.
          const drain = drainAbortReason(state.abortController.signal.reason);
          try {
            await finalizer.emitStreamErrorAndClose(drain ?? abortFailure ?? err, controller);
          } finally {
            // The release must not depend on the error path completing:
            // anything that throws above it (a bookkeeping call, a dead
            // controller) would otherwise skip it, and `afterResponse`
            // cannot rescue a request whose `state.streaming` is set. The
            // `streamReleased` guard makes this safe to reach twice.
            void finalizer.releaseStreamResources();
          }
        }
      } finally {
        // The watchdog abort and the abort handler coordinate through
        // this flag: while a pull is pending it owns the release; once
        // pull returns, an abort with no reader must release itself.
        finalizer.pullActive = false;
      }
    },
    cancel() {
      if (state.completed) return;
      // A cancelled stream may never see another pull(), so abort alone
      // would leak the quota lease, routing reservation, and pool slot.
      // Request upstream iterator cleanup, but do not await a generator's
      // return(): async generators can queue it behind a permanently pending
      // read. The request signal has already cancelled the underlying fetch.
      state.abortController.abort(new DOMException("client disconnect", "AbortError"));
      finalizer.settleUpstreamIterator();
      return finalizer.releaseStreamResources();
    },
  });

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
      state.startedAtMs + resolveUpstreamTimeoutMs() + finalizer.streamStallTimeoutMs - Date.now(),
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

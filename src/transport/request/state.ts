import { GatewayError } from "../gateway-error";
import type { CanonicalRequest, UsageRecord } from "../canonical-model";
import type { ClientIdentity } from "../../security/abuse";
import type { ResolvedApiKey } from "../../security/api-key-auth";
import type { PreparedProxyRequest } from "./preparer";
import { decrementInFlight, incrementInFlight } from "./inflight";
import { fastPathname } from "./pathname";

export interface ProxyRequestOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "truncated";
  /**
   * HTTP status the client received. The outcome `status` is the internal
   * terminal state; this is its wire projection, so a 400 stays a 400 in
   * Console Log / telemetry instead of collapsing to 500.
   */
  readonly httpStatus?: number;
  readonly providerId?: string;
  readonly accountId?: string;
  /** Operator-facing account label, when known — Console Log shows this
   * instead of the opaque `accountId`. */
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly errorCategory?: string;
  /**
   * Layer that produced the failure (`cartethyia` | `upstream` | `network`).
   * Recorded beside `errorCategory` because a code alone cannot say whether the
   * gateway rejected the request or the provider did.
   */
  readonly errorOrigin?: string;
  readonly usage?: UsageRecord;
  readonly ttfbMs?: number;
  readonly tokensPerSec?: number;
  /** First meaningful content delta timestamp (for TTFT calculation). */
  readonly firstContentDeltaAtMs?: number;
  /** Last event timestamp (for generation duration calculation). */
  readonly lastEventAtMs?: number;
}
export interface ProxyRequestState {
  readonly requestId: string;
  readonly startedAtMs: number;
  /** Timestamp set when the adapter's upstream fetch / streaming iterator begins. */
  upstreamDispatchStartedAtMs?: number;
  readonly deadlineMs: number;
  readonly abortController: AbortController;
  /** Body decoded by the single ingress reader, when this is a proxy request. */
  ingressBody?: unknown;
  /** Inbound method/path are retained for structured Console Log events. */
  ingressMethod?: string;
  ingressPath?: string;
  /** Inbound `user-agent` header (capped) stashed for telemetry. */
  clientUserAgent?: string;
  clientIdentity?: ClientIdentity;
  authorization?: ResolvedApiKey;
  canonicalRequest?: CanonicalRequest;
  preparedRequest?: PreparedProxyRequest;
  outcome?: ProxyRequestOutcome;
  /**
   * Set by the dispatch handler synchronously before returning a streaming
   * response. `afterResponse` lifecycle hooks read it to skip finalization
   * (telemetry + cleanup), deferring both to stream completion/cancel —
   * cleanup aborts the controller, which would tear down an in-flight stream.
   */
  streaming?: boolean;
  /**
   * Set by `completeAttempt` (dispatch/attempt-finalize) once the *terminal*
   * attempt has run its completion bookkeeping (usage commit, health report,
   * payload capture, telemetry finalization). The `afterResponse` telemetry
   * hook no-ops its finalize step when this is set (its Elysia registration
   * is untouched) so a request finalizes exactly once; cleanup still runs in
   * that hook's `finally` for every non-streaming request. Intermediate
   * failover attempts leave it clear.
   */
  completed?: boolean;
  /**
   * Re-arms the request deadline timer to `ms` from now. A streaming response
   * calls this once its body is established so the stream watchdogs (first
   * chunk + inter-event stall) govern body duration instead of the shorter
   * pre-stream deadline, while still keeping a hard ceiling over the whole
   * request. Idempotent and a no-op after cleanup.
   */
  extendDeadline(ms: number): void;
  cleanup(): void;
  addCleanup(cleanup: () => void): void;
}

export interface RequestTracker {
  track(id: string): void;
  untrack(id: string): void;
}

/**
 * Per-request state registry keyed on the immutable `Request` object.
 *
 * Storage strategy: the canonical state map is a `WeakMap<Request, …>`, so a
 * request object that escapes any handler's scope becomes garbage along with
 * its state — there is no registry-wide sweep to leak or forget. The
 * companion `liveControllers` map, however, is a strong `Map` keyed by
 * request id: the shutdown coordinator needs to enumerate and abort *all*
 * in-flight requests (`abortAll`) regardless of whether any handler still
 * holds the `Request`, so those entries must be reachable. `cleanup()` is the
 * single idempotent teardown point — it untracks the request, releases the
 * deadline timer, runs registered cleanups LIFO, aborts the controller (which
 * tears down any in-flight upstream fetch), and drops the WeakMap entry.
 *
 * Lifecycle tracking: `tracker` (optional `RequestTracker`) feeds
 * shutdown coordination, which waits on tracked requests (or aborts them
 * past the grace window) instead of relying on connection close events.
 */
export class ProxyRequestStateStore {
  private readonly states = new WeakMap<Request, ProxyRequestState>();
  private readonly liveControllers = new Map<string, AbortController>();

  constructor(private readonly tracker?: RequestTracker) {}

  activeCount(): number {
    return this.liveControllers.size;
  }

  abortAll(reason?: unknown): void {
    const controllers = [...this.liveControllers.values()];
    if (controllers.length === 0) return;
    const abortReason =
      reason instanceof Error || reason instanceof DOMException
        ? reason
        : new DOMException("server shutting down", "AbortError");
    for (const controller of controllers) {
      try {
        if (!controller.signal.aborted) controller.abort(abortReason);
      } catch {
      }
    }
  }

  /**
   * Creates per-request state with deadline enforcement: the deadline is
   * *enforced by an unref'd timer* that aborts the controller with a
   * `TimeoutError` at `deadlineMs` — unref'd so an idle deadline never keeps
   * the event loop alive during graceful shutdown. The inbound client signal
   * is bridged (abort propagation in both directions), so a client
   * disconnect aborts the upstream fetch immediately. Everything the timer
   * and signal listener allocated is torn down by `state.cleanup()`.
   */
  initialize(request: Request, now: number, deadlineDurationMs: number): ProxyRequestState {
    const abortController = new AbortController();
    const deadlineMs = now + Math.max(0, deadlineDurationMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => abortController.abort(request.signal.reason);
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    let cleaned = false;
    const cleanups: Array<() => void> = [];
    const armDeadline = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        abortController.abort(new DOMException("request deadline exceeded", "TimeoutError"));
      }, Math.max(0, ms));
      // Do not keep event loop alive for idle deadline timers (graceful shutdown)
      (timer as unknown as { unref?: () => void })?.unref?.();
    };
    armDeadline(Math.max(0, deadlineMs - Date.now()));
    const state: ProxyRequestState = {
      requestId: crypto.randomUUID(),
      startedAtMs: now,
      deadlineMs,
      abortController,
      ingressMethod: request.method,
      ingressPath: fastPathname(request.url),
      extendDeadline: (ms: number) => {
        if (cleaned) return;
        armDeadline(ms);
      },
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        decrementInFlight();
        this.tracker?.untrack(state.requestId);
        this.liveControllers.delete(state.requestId);
        clearTimeout(timer);
        timer = undefined;
        request.signal.removeEventListener("abort", onAbort);
        for (const cleanup of cleanups.splice(0)) cleanup();
        abortController.abort(new DOMException("request complete", "AbortError"));
        this.states.delete(request);
      },
      addCleanup: (cleanup) => {
        if (cleaned) cleanup();
        else cleanups.push(cleanup);
      },
    };
    this.liveControllers.set(state.requestId, abortController);
    this.tracker?.track(state.requestId);
    this.states.set(request, state);
    incrementInFlight();
    return state;
  }
  require(request: Request): ProxyRequestState {
    const state = this.states.get(request);
    if (!state)
      throw new GatewayError("admission_unavailable", 503, "proxy request context unavailable");
    return state;
  }

  get(request: Request): ProxyRequestState | undefined {
    return this.states.get(request);
  }
}

// ---------------------------------------------------------------- abort coordination

export type AbortCause = "caller" | "connect_timeout" | "total_timeout" | "idle_timeout";

export interface AbortCoordinatorOptions {
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/**
 * Combines a caller AbortSignal with optional connect/total/idle timers.
 * Every abort is attributed to a cause so callers can map it to a typed
 * error (client_aborted vs network_unavailable vs stream_timeout).
 */
export class AbortCoordinator {
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private cause: AbortCause = "caller";
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(caller: AbortSignal, options: AbortCoordinatorOptions = {}) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    const onCallerAbort = () => this.fail("caller");
    if (caller.aborted) {
      onCallerAbort();
    } else {
      caller.addEventListener("abort", onCallerAbort, { once: true });
      this.cleanups.push(() => caller.removeEventListener("abort", onCallerAbort));
    }
    if ((options.connectTimeoutMs ?? 0) > 0) {
      this.connectTimer = setTimeout(() => this.fail("connect_timeout"), options.connectTimeoutMs);
    }
    if ((options.totalTimeoutMs ?? 0) > 0) {
      this.totalTimer = setTimeout(() => this.fail("total_timeout"), options.totalTimeoutMs);
    }
  }

  /** Call once the response headers arrived; stops the connect timer. */
  markHeadersReceived(): void {
    this.clearTimer("connect");
  }

  /** Re-arms the idle timer (call once per received stream chunk). */
  resetIdle(): void {
    this.clearTimer("idle");
    if (this.idleTimeoutMs > 0 && !this.controller.signal.aborted && !this.disposed) {
      this.idleTimer = setTimeout(() => this.fail("idle_timeout"), this.idleTimeoutMs);
    }
  }

  /** Invoke `callback` when the coordinator aborts; returns an unsubscribe. */
  onAbort(callback: () => void): () => void {
    if (this.controller.signal.aborted) {
      callback();
      return () => {};
    }
    this.controller.signal.addEventListener("abort", callback, { once: true });
    return () => this.controller.signal.removeEventListener("abort", callback);
  }

  causeOf(): AbortCause {
    return this.cause;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAllTimers();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }

  private fail(cause: AbortCause): void {
    if (this.disposed || this.controller.signal.aborted) return;
    this.cause = cause;
    this.clearAllTimers();
    this.controller.abort();
  }

  private clearAllTimers(): void {
    this.clearTimer("connect");
    this.clearTimer("total");
    this.clearTimer("idle");
  }

  private clearTimer(which: "connect" | "total" | "idle"): void {
    const key = which === "connect" ? "connectTimer" : which === "total" ? "totalTimer" : "idleTimer";
    const timer = this[key];
    if (timer !== null) {
      clearTimeout(timer);
      this[key] = null;
    }
  }
}
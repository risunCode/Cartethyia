// ---------------------------------------------------------------- abort coordination

export type AbortCause = "caller" | "connect_timeout" | "first_byte_timeout" | "total_timeout" | "idle_timeout";

export interface AbortCoordinatorOptions {
  readonly connectTimeoutMs?: number;
  readonly firstByteTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/**
 * Combines a caller AbortSignal with optional connect/first-byte/total/idle
 * timers. Every abort is attributed to a cause so callers can map it to a
 * typed error (client_aborted vs network_unavailable vs stream_timeout).
 */
export class AbortCoordinator {
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private cause: AbortCause = "caller";
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly firstByteTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(caller: AbortSignal, options: AbortCoordinatorOptions = {}) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? 0;
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

  /** Arms the pre-response timer immediately before a provider fetch. */
  armFirstByteTimeout(timeoutMs = this.firstByteTimeoutMs, onTimeout?: () => void): void {
    this.clearTimer("firstByte");
    if (timeoutMs > 0 && !this.controller.signal.aborted && !this.disposed) {
      this.firstByteTimer = setTimeout(() => {
        this.fail("first_byte_timeout");
        onTimeout?.();
      }, timeoutMs);
    }
  }

  /** Call once response headers arrive; stops pre-response timers only. */
  markResponseHeadersReceived(): void {
    this.clearTimer("connect");
    this.clearTimer("firstByte");
  }

  /** Backward-compatible alias for the existing header marker. */
  markHeadersReceived(): void {
    this.markResponseHeadersReceived();
  }

  /** Re-arms the idle timer (call once per received stream chunk). */
  resetIdle(): void {
    this.clearTimer("idle");
    if (this.idleTimeoutMs > 0 && !this.controller.signal.aborted && !this.disposed) {
      this.idleTimer = setTimeout(() => this.fail("idle_timeout"), this.idleTimeoutMs);
    }
  }

  /** Abort with an explicit cause, preserving the first cause that wins. */
  abort(cause: AbortCause): void {
    this.fail(cause);
  }

  /** Invoke `callback` when the coordinator aborts; returns an unsubscribe. */
  onAbort(callback: () => void): () => void {
    if (this.controller.signal.aborted) {
      callback();
      return () => {};
    }
    if (this.disposed) return () => {};
    let unsubscribed = false;
    const unsubscribe = (): void => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.controller.signal.removeEventListener("abort", callback);
    };
    this.controller.signal.addEventListener("abort", callback, { once: true });
    this.cleanups.push(unsubscribe);
    return unsubscribe;
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
    this.clearTimer("firstByte");
    this.clearTimer("total");
    this.clearTimer("idle");
  }

  private clearTimer(which: "connect" | "firstByte" | "total" | "idle"): void {
    const key = which === "connect"
      ? "connectTimer"
      : which === "firstByte"
        ? "firstByteTimer"
        : which === "total"
          ? "totalTimer"
          : "idleTimer";
    const timer = this[key];
    if (timer !== null) {
      clearTimeout(timer);
      this[key] = null;
    }
  }
}

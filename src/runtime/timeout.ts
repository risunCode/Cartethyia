/**
 * Shared timeout helper with proper cleanup (clear + unref).
 * Prevents timer leaks and keeps the process from hanging on timeout.
 */

/**
 * Creates a promise that rejects after the specified timeout.
 * The timer is unref'd to prevent keeping the event loop alive.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `Operation timed out after ${ms}ms`,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Creates a standalone timeout promise that rejects after the specified duration.
 * The timer is unref'd to prevent keeping the event loop alive.
 */
export function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Retry with exponential backoff and jitter for idempotent outbound calls.
 *
 * Used for best-effort metadata lookups (registry version discovery) where a
 * transient network failure should not permanently pin a stale fallback.
 * Callers that must not retry (non-idempotent requests) simply don't use it.
 */

import { exponentialBackoff, type BackoffOptions } from "../runtime/backoff";

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injectable sleep for tests; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Returns true to retry; defaults to retrying every error. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on failure with exponential backoff (100 ms, 200 ms,
 * 400 ms, …) capped at `maxDelayMs` and jittered by up to 25% to avoid a
 * thundering herd when many instances retry the same endpoint. Re-throws the
 * last error once attempts are exhausted.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? (() => true);

  const backoffOptions: BackoffOptions = { baseDelayMs, maxDelayMs, jitter: true };

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !shouldRetry(error, attempt)) break;
      const delay = exponentialBackoff(attempt, backoffOptions);
      await sleep(delay);
    }
  }
  throw lastError;
}

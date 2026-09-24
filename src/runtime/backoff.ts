/**
 * Exponential backoff utilities for retry logic and scheduling.
 */

export interface BackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter?: boolean;
}

/**
 * Calculate exponential backoff delay for a given attempt.
 * 
 * @param attempt - The attempt number (0-indexed for first retry)
 * @param options - Backoff configuration
 * @returns The delay in milliseconds
 * 
 * Formula: min(maxDelayMs, baseDelayMs * 2^attempt)
 * With jitter enabled: adds ±25% random jitter to avoid thundering herd
 */
export function exponentialBackoff(attempt: number, options: BackoffOptions): number {
  const { baseDelayMs, maxDelayMs, jitter = false } = options;
  const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  
  if (jitter) {
    const jitterAmount = backoff * 0.25 * Math.random();
    return Math.round(backoff + jitterAmount);
  }
  
  return backoff;
}

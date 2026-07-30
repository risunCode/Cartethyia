/**
 * Retry wrapper for upstream provider dispatch (C2+M4).
 *
 * Wraps an async operation with configurable retry logic:
 * - Per-status retry rules (502/503/504 → retry, 400/401 → don't)
 * - Exponential backoff with jitter
 * - Fetch error code mapping (ECONNRESET, ETIMEDOUT → retry)
 * - Text-based error classification (rate limit, capacity → retry)
 */

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: Set<number>;
  retryableErrorCodes: Set<string>;
}

const DEFAULT_RETRYABLE_STATUSES = new Set([408, 502, 503, 504]);
const DEFAULT_RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** Text patterns in upstream error messages that indicate retryable conditions. */
const RETRYABLE_TEXT_PATTERNS = [
  /rate.?limit/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /capacity/i,
  /overloaded/i,
  /try again/i,
  /temporarily unavailable/i,
  /internal.?error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
];

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
  retryableErrorCodes: DEFAULT_RETRYABLE_ERROR_CODES,
};

/**
 * Determines if an error is retryable based on status code, error code, or message text.
 * Note: 429 is NOT retryable here — it's handled by account rotation (C5).
 */
export function isRetryableError(error: unknown, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  // 429 is handled by account rotation, not retry wrapper
  const status = extractStatus(error);
  if (status === 429) return false;

  if (error instanceof Error) {
    // Check error code (Node/Bun fetch errors)
    const code = (error as NodeJS.ErrnoException).code;
    if (code && config.retryableErrorCodes.has(code)) return true;

    // Check error message text patterns
    for (const pattern of RETRYABLE_TEXT_PATTERNS) {
      if (pattern.test(error.message)) return true;
    }
  }

  // Check status code (UpstreamError or HTTP error)
  if (status !== null && config.retryableStatuses.has(status)) return true;

  return false;
}

/**
 * Extracts HTTP status from an error object.
 * Supports UpstreamError, ProviderCallError, and plain Error with status.
 */
export function extractStatus(error: unknown): number | null {
  if (error !== null && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.status === "number") return obj.status;
    if (typeof obj.statusCode === "number") return obj.statusCode;
  }
  return null;
}

/**
 * Calculates delay with exponential backoff + jitter.
 * Formula: min(base * 2^attempt + random jitter, max)
 */
export function calculateBackoff(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs * 0.5; // 0–50% of base
  return Math.min(exponential + jitter, config.maxDelayMs);
}

/**
 * Wraps an async operation with retry logic.
 * Calls `operation()` up to `maxRetries + 1` times (initial + retries).
 *
 * @param operation - The async function to retry
 * @param config - Retry configuration
 * @param onRetry - Optional callback before each retry (for logging)
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt
      if (attempt >= config.maxRetries) break;

      // Only retry if error is retryable
      if (!isRetryableError(error, config)) break;

      const delayMs = calculateBackoff(attempt, config);
      onRetry?.(attempt, delayMs, error);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Creates a combined AbortSignal that fires when either:
 * - The timeout elapses
 * - The parent signal is aborted
 *
 * Used to add connect/total timeout to fetch calls while preserving
 * client abort propagation.
 */
export function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal | null): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, parentSignal]);
}

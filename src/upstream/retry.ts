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
 * @param shouldRetry - Optional override for the retry decision, called
 *   instead of `isRetryableError`. Defaults to the status/error-shape based
 *   check; pass an override when a caller has extra context a bare status
 *   check can't express (e.g. how many equivalent candidates remain to try).
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
  shouldRetry: (error: unknown, attempt: number) => boolean = (error) => isRetryableError(error, config),
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt
      if (attempt >= config.maxRetries) break;

      // Only retry if the error (or the caller's override) says to
      if (!shouldRetry(error, attempt)) break;

      const delayMs = calculateBackoff(attempt, config);
      onRetry?.(attempt, delayMs, error);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export interface TimeoutSignal {
  /** Combined signal: fires on timeout OR when `parentSignal` aborts. Pass this straight to `fetch()`. */
  signal: AbortSignal;
  /**
   * Disarms the timeout half of `signal` without touching `parentSignal`.
   * MUST be called once the caller has what it needs from a bounded phase
   * (e.g. response headers arrived) - otherwise the deadline keeps ticking
   * for the signal's entire remaining lifetime, including a streaming
   * response body read long after connection was established. A real
   * 60s+ tool-call generation streamed from a genuinely slow-but-healthy
   * upstream would otherwise get its connection killed mid-generation at
   * the timeout mark - confirmed in production via a request trace showing
   * `durationMs: 60006` (i.e. `AbortSignal.timeout`'s deadline, not an
   * upstream error) cutting off an in-progress, successfully streaming
   * `create_file` tool call.
   */
  clear: () => void;
}

/**
 * Creates a disarmable timeout bound to `parentSignal`'s own abort. Unlike
 * `AbortSignal.timeout()`, the timeout can be cancelled via `clear()` once
 * whatever bounded phase it was guarding (e.g. connect/TTFB) has completed,
 * so it never fires against unrelated later activity on the same signal
 * (e.g. reading a long-lived streaming response body).
 */
export function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal | null): TimeoutSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  const clear = () => clearTimeout(timer);
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  return { signal, clear };
}

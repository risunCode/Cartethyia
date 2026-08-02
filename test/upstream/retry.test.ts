/** Retry wrapper tests — backoff, retryable errors, timeout signals. */

import { describe, expect, test, mock } from "bun:test";
import {
  withRetry,
  isRetryableError,
  calculateBackoff,
  createTimeoutSignal,
  DEFAULT_RETRY_CONFIG,
} from "../../src/upstream/retry";
import { UpstreamError } from "../../src/upstream/error";

describe("isRetryableError", () => {
  test("retries on 502/503/504", () => {
    expect(isRetryableError(new UpstreamError("bad gateway", 502, ""))).toBe(true);
    expect(isRetryableError(new UpstreamError("unavailable", 503, ""))).toBe(true);
    expect(isRetryableError(new UpstreamError("timeout", 504, ""))).toBe(true);
  });

  test("does NOT retry on 429 (handled by account rotation)", () => {
    expect(isRetryableError(new UpstreamError("rate limited", 429, ""))).toBe(false);
  });

  test("retries on 408", () => {
    expect(isRetryableError(new UpstreamError("request timeout", 408, ""))).toBe(true);
  });

  test("does NOT retry on 400/401/403/404", () => {
    expect(isRetryableError(new UpstreamError("bad request", 400, ""))).toBe(false);
    expect(isRetryableError(new UpstreamError("unauthorized", 401, ""))).toBe(false);
    expect(isRetryableError(new UpstreamError("forbidden", 403, ""))).toBe(false);
    expect(isRetryableError(new UpstreamError("not found", 404, ""))).toBe(false);
  });

  test("does NOT retry on 500 (non-retryable server error)", () => {
    expect(isRetryableError(new UpstreamError("internal", 500, ""))).toBe(false);
  });

  test("retries on ECONNRESET", () => {
    const err = new Error("socket hang up");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    expect(isRetryableError(err)).toBe(true);
  });

  test("retries on ETIMEDOUT", () => {
    const err = new Error("connect ETIMEDOUT");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    expect(isRetryableError(err)).toBe(true);
  });

  test("retries on error text patterns", () => {
    expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRetryableError(new Error("too many requests"))).toBe(true);
    expect(isRetryableError(new Error("overloaded, try again later"))).toBe(true);
    expect(isRetryableError(new Error("capacity exceeded"))).toBe(true);
    expect(isRetryableError(new Error("temporarily unavailable"))).toBe(true);
    expect(isRetryableError(new Error("The connection was closed."))).toBe(true);
    expect(isRetryableError(new Error("The operation timed out."))).toBe(true);
  });

  test("does NOT retry on generic errors", () => {
    expect(isRetryableError(new Error("something went wrong"))).toBe(false);
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(false);
  });
});

describe("calculateBackoff", () => {
  test("increases exponentially", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000, maxDelayMs: 60000 };
    const d0 = calculateBackoff(0, config);
    const d1 = calculateBackoff(1, config);
    const d2 = calculateBackoff(2, config);

    // Base * 2^attempt + jitter (0–50% of base)
    expect(d0).toBeGreaterThanOrEqual(1000);
    expect(d0).toBeLessThan(1500);
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d1).toBeLessThan(2500);
    expect(d2).toBeGreaterThanOrEqual(4000);
    expect(d2).toBeLessThan(4500);
  });

  test("caps at maxDelayMs", () => {
    const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 10000, maxDelayMs: 15000 };
    const delay = calculateBackoff(5, config);
    expect(delay).toBeLessThanOrEqual(15000);
  });
});

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const op = mock(() => Promise.resolve("ok"));
    const result = await withRetry(op, { ...DEFAULT_RETRY_CONFIG, maxRetries: 3 });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries on retryable error and succeeds", async () => {
    let call = 0;
    const op = mock(() => {
      call++;
      if (call === 1) return Promise.reject(new UpstreamError("bad gateway", 502, ""));
      return Promise.resolve("recovered");
    });
    const result = await withRetry(op, { ...DEFAULT_RETRY_CONFIG, maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(2);
  });

  test("throws on non-retryable error without retrying", async () => {
    const op = mock(() => Promise.reject(new UpstreamError("bad request", 400, "")));
    await expect(withRetry(op, { ...DEFAULT_RETRY_CONFIG, maxRetries: 3, baseDelayMs: 10 })).rejects.toThrow("bad request");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("throws last error after max retries exhausted", async () => {
    const op = mock(() => Promise.reject(new UpstreamError("unavailable", 503, "")));
    await expect(withRetry(op, { ...DEFAULT_RETRY_CONFIG, maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow("unavailable");
    expect(op).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test("calls onRetry callback before each retry", async () => {
    const onRetry = mock(() => {});
    const op = mock(() => Promise.reject(new UpstreamError("bad gateway", 502, "")));
    await expect(
      withRetry(op, { ...DEFAULT_RETRY_CONFIG, maxRetries: 2, baseDelayMs: 10 }, onRetry)
    ).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

describe("createTimeoutSignal", () => {
  test("fires on timeout", async () => {
    const { signal } = createTimeoutSignal(50);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(signal.aborted).toBe(true);
  });

  test("fires on parent abort", async () => {
    const controller = new AbortController();
    const { signal } = createTimeoutSignal(10000, controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  test("fires on whichever comes first", async () => {
    const controller = new AbortController();
    const { signal } = createTimeoutSignal(50, controller.signal);
    await new Promise((r) => setTimeout(r, 100));
    expect(signal.aborted).toBe(true);
    // Parent not aborted — timeout fired first
    expect(controller.signal.aborted).toBe(false);
  });

  // Regression: a fetch that resolved headers (e.g. an active, healthy
  // streaming response) must not have its connection killed later by the
  // SAME timeout deadline that only ever should have bounded connect/TTFB.
  // Confirmed in production: a request trace showed durationMs: 60006 -
  // AbortSignal.timeout(60_000) killing a successfully-streaming create_file
  // tool call mid-generation, not an upstream error.
  test("clear() disarms the timeout so it never fires afterward", async () => {
    const { signal, clear } = createTimeoutSignal(50);
    clear();
    await new Promise((r) => setTimeout(r, 100));
    expect(signal.aborted).toBe(false);
  });

  test("clear() does not disarm the parent's own abort", async () => {
    const controller = new AbortController();
    const { signal, clear } = createTimeoutSignal(10000, controller.signal);
    clear();
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

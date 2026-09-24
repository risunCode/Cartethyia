import { describe, expect, test } from "bun:test";
import { retryWithBackoff } from "../../src/network/retry";

describe("retryWithBackoff", () => {
  test("returns the first successful result without sleeping", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  test("retries until success and applies exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(`fail ${calls}`);
        return calls;
      },
      { baseDelayMs: 100, maxRetries: 3, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    // Backoff doubles per attempt; jitter adds at most 25%.
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(125);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThanOrEqual(250);
  });

  test("rethrows the last error once attempts are exhausted", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls}`);
        },
        { maxRetries: 2, sleep: async () => {} },
      ),
    ).rejects.toThrow("attempt 3");
    expect(calls).toBe(3);
  });

  test("stops early when shouldRetry returns false", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new Error("nope");
        },
        { maxRetries: 5, shouldRetry: () => false, sleep: async () => {} },
      ),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });

  test("caps the backoff at maxDelayMs", async () => {
    const delays: number[] = [];
    await expect(
      retryWithBackoff(
        async () => {
          throw new Error("always");
        },
        { baseDelayMs: 1_000, maxRetries: 4, maxDelayMs: 1_200, sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toThrow("always");
    // 1000, then 1200 (capped) for every subsequent attempt, +≤25% jitter.
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeGreaterThanOrEqual(1_200);
    expect(delays[1]).toBeLessThanOrEqual(1_500);
    expect(delays[2]).toBeLessThanOrEqual(1_500);
  });
});

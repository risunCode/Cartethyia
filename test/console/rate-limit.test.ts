/**
 * Unit tests for src/console/rate-limit.ts \u2014 per-session sliding-window
 * mutation rate limiter for sensitive console endpoints.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { MutationLimiter } from "../../src/console/rate-limit";

let limiter: MutationLimiter;

beforeEach(() => {
  limiter = new MutationLimiter();
});

describe("MutationLimiter \u2014 basic sliding window", () => {
  test("allows the first mutation", () => {
    expect(limiter.record("session-a").allowed).toBe(true);
  });

  test("allows up to MAX_MUTATIONS (5) within the window", () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.record("session-a", 1000 + i).allowed).toBe(true);
    }
  });

  test("rejects the 6th mutation within the window", () => {
    for (let i = 0; i < 5; i++) limiter.record("session-a", 1000 + i);
    const result = limiter.record("session-a", 1500);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  test("window slides forward \u2014 old entries expire and new ones are accepted", () => {
    const base = 1000;
    for (let i = 0; i < 5; i++) limiter.record("session-a", base + i);
    // 10 seconds later the window has fully rotated.
    expect(limiter.record("session-a", base + 10_001).allowed).toBe(true);
  });

  test("different sessions have independent limits", () => {
    for (let i = 0; i < 5; i++) limiter.record("session-a", 1000 + i);
    expect(limiter.record("session-b", 1500).allowed).toBe(true);
  });
});

describe("MutationLimiter \u2014 check (read-only) vs record (write)", () => {
  test("check does not consume a mutation slot", () => {
    for (let i = 0; i < 5; i++) limiter.record("session-a", 1000 + i);
    // check says blocked:
    expect(limiter.check("session-a", 1500).allowed).toBe(false);
    // but it did not add a timestamp, so the next record should also be blocked
    // (still 5 in the window).
    expect(limiter.record("session-a", 1600).allowed).toBe(false);
  });

  test("check returns allowed when the window is empty", () => {
    expect(limiter.check("session-x", 5000).allowed).toBe(true);
  });
});

describe("MutationLimiter \u2014 retryAfterMs calculation", () => {
  test("retryAfterMs equals the time until the oldest entry in the window expires", () => {
    // Record 5 mutations starting at t=1000, each 1 second apart.
    for (let i = 0; i < 5; i++) limiter.record("session-a", 1000 + i * 1000);
    // At t=4500 the oldest entry (t=1000) expires at t=11000 (10s window).
    const result = limiter.record("session-a", 4500);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // retryAfterMs = (1000 + 10000) - 4500 = 6500
      expect(result.retryAfterMs).toBe(6500);
    }
  });
});

describe("MutationLimiter \u2014 reset / resetAll / size", () => {
  test("reset clears a single session's bucket", () => {
    for (let i = 0; i < 5; i++) limiter.record("session-a", 1000 + i);
    limiter.reset("session-a");
    expect(limiter.record("session-a", 2000).allowed).toBe(true);
  });

  test("resetAll clears every bucket", () => {
    limiter.record("session-a", 1000);
    limiter.record("session-b", 1000);
    limiter.resetAll();
    expect(limiter.size()).toBe(0);
  });

  test("size reports the current bucket count", () => {
    limiter.record("session-a", 1000);
    limiter.record("session-b", 1000);
    expect(limiter.size()).toBe(2);
  });
});

describe("MutationLimiter \u2014 stale sweep", () => {
  test("sweep removes buckets whose last timestamp is older than the sweep threshold", () => {
    // Record once at t=0.
    limiter.record("session-old", 0);
    expect(limiter.size()).toBe(1);
    // At t > SWEEP_INTERVAL_MS (60s) + WINDOW_MS (10s), a new check triggers sweep.
    limiter.check("session-other", 71_000);
    // session-old was swept (last timestamp at t=0, nowMs=71000 > 0+10s);
    // session-other never had a bucket (check is read-only), so size drops to 0.
    expect(limiter.size()).toBe(0);
  });
});

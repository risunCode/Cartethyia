import { describe, expect, test } from "bun:test";
import { LoginLimiter } from "../../src/console/auth/limiter";

describe("login limiter", () => {
  test("allows up to 4 failures, locks at 5 for 30s", () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) {
      const result = limiter.recordFailure("ip", t0);
      expect(result.allowed).toBe(true);
    }
    const fifth = limiter.recordFailure("ip", t0);
    expect(fifth.allowed).toBe(false);
    if (!fifth.allowed) expect(fifth.retryAfterSec).toBe(30);
    const during = limiter.check("ip", t0 + 10_000);
    expect(during.allowed).toBe(false);
    const after = limiter.check("ip", t0 + 31_000);
    expect(after.allowed).toBe(true);
  });

  test("escalates the lock ladder on repeated thresholds", () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) limiter.recordFailure("ip", t0 + i);
    expect(limiter.status("ip", t0 + 20).retryAfterSec).toBe(120);
    for (let i = 6; i < 10; i++) limiter.recordFailure("ip", t0 + i);
    const status = limiter.status("ip", t0 + 20);
    expect(status.locked).toBe(true);
    expect(status.retryAfterSec).toBe(1800);
  });

  test("success clears the bucket", () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure("ip");
    limiter.recordSuccess("ip");
    expect(limiter.status("ip").failures).toBe(0);
  });

  test("resets escalation after an hour without failures", () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) limiter.recordFailure("ip", t0 + i);
    const much = 3_700_000;
    const result = limiter.recordFailure("ip", t0 + much);
    expect(result.allowed).toBe(true);
  });

  test("sweeps stale unlocked buckets so scanner traffic can't grow the map forever", () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    // 200 distinct source IPs each fail once (below FAILURE_THRESHOLD, so
    // never locked) - previously these buckets lived forever.
    for (let i = 0; i < 200; i++) limiter.recordFailure(`ip-${i}`, t0);
    expect(limiter.size()).toBe(200);

    // Past both the reset window (1h) and the sweep interval (10min); the
    // next lookup should trigger a sweep and drop every stale bucket.
    const later = t0 + 3_700_000;
    limiter.check("ip-0", later);
    expect(limiter.size()).toBeLessThan(200);
  });

  test("does not sweep a bucket that is unlocked but still inside the 1h reset window", () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("locked-ip", t0 + i);
    expect(limiter.status("locked-ip", t0 + 5).locked).toBe(true);

    // Past the sweep interval (10min) and the 30s lock, but well inside the
    // 1h reset window - the bucket's escalation history must survive.
    const later = t0 + 700_000;
    limiter.check("other-ip", later);
    expect(limiter.status("locked-ip", later).failures).toBe(5);
  });
});

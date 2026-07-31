/**
 * Login rate limiter — per-IP, in-memory. Escalating locks after consecutive
 * failures; a full hour without failures resets the escalation ladder.
 */

const FAILURE_THRESHOLD = 5;
const LOCK_STEPS_SECONDS = [30, 120, 600, 1800];
const RESET_AFTER_MS = 3_600_000;
/** How often a bucket lookup triggers a stale-entry sweep - bounds the map's size against internet-scanner traffic (one distinct source IP per failed attempt, never otherwise cleaned) without paying an O(n) sweep cost on every request. */
const SWEEP_INTERVAL_MS = 600_000;

interface Bucket {
  failures: number;
  lockUntilMs: number;
  lastFailureMs: number;
}

export type LimitCheck = { allowed: true } | { allowed: false; retryAfterSec: number };

export class LoginLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepMs = 0;

  /** Drops buckets that are both unlocked and past the reset window - a bucket that never crosses FAILURE_THRESHOLD (the overwhelming majority from scanner traffic) was never deleted otherwise, growing the map by one entry per distinct source IP forever. */
  private sweepStale(nowMs: number): void {
    if (nowMs - this.lastSweepMs < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lockUntilMs <= nowMs && nowMs - bucket.lastFailureMs > RESET_AFTER_MS) this.buckets.delete(key);
    }
  }

  check(key: string, nowMs: number = Date.now()): LimitCheck {
    this.sweepStale(nowMs);
    const bucket = this.buckets.get(key);
    if (!bucket) return { allowed: true };
    if (bucket.lockUntilMs > nowMs) {
      return { allowed: false, retryAfterSec: Math.ceil((bucket.lockUntilMs - nowMs) / 1000) };
    }
    return { allowed: true };
  }

  recordFailure(key: string, nowMs: number = Date.now()): LimitCheck {
    this.sweepStale(nowMs);
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs - bucket.lastFailureMs > RESET_AFTER_MS) {
      bucket = { failures: 0, lockUntilMs: 0, lastFailureMs: 0 };
    }
    bucket.failures += 1;
    bucket.lastFailureMs = nowMs;
    if (bucket.failures >= FAILURE_THRESHOLD) {
      const step = Math.min(bucket.failures - FAILURE_THRESHOLD, LOCK_STEPS_SECONDS.length - 1);
      bucket.lockUntilMs = nowMs + LOCK_STEPS_SECONDS[step]! * 1000;
    }
    this.buckets.set(key, bucket);
    return this.check(key, nowMs);
  }

  recordSuccess(key: string): void {
    this.buckets.delete(key);
  }

  status(key: string, nowMs: number = Date.now()): { failures: number; locked: boolean; retryAfterSec: number } {
    const bucket = this.buckets.get(key);
    if (!bucket) return { failures: 0, locked: false, retryAfterSec: 0 };
    const locked = bucket.lockUntilMs > nowMs;
    return {
      failures: bucket.failures,
      locked,
      retryAfterSec: locked ? Math.ceil((bucket.lockUntilMs - nowMs) / 1000) : 0,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  resetAll(): void {
    this.buckets.clear();
    this.lastSweepMs = 0;
  }

  /** Current bucket count - exposed for tests to assert the sweep actually bounds growth. */
  size(): number {
    return this.buckets.size;
  }
}

export const loginLimiter = new LoginLimiter();

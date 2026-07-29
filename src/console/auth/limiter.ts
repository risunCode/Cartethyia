/**
 * Login rate limiter — per-IP, in-memory. Escalating locks after consecutive
 * failures; a full hour without failures resets the escalation ladder.
 */

const FAILURE_THRESHOLD = 5;
const LOCK_STEPS_SECONDS = [30, 120, 600, 1800];
const RESET_AFTER_MS = 3_600_000;

interface Bucket {
  failures: number;
  lockUntilMs: number;
  lastFailureMs: number;
}

export type LimitCheck = { allowed: true } | { allowed: false; retryAfterSec: number };

export class LoginLimiter {
  private readonly buckets = new Map<string, Bucket>();

  check(key: string, nowMs: number = Date.now()): LimitCheck {
    const bucket = this.buckets.get(key);
    if (!bucket) return { allowed: true };
    if (bucket.lockUntilMs > nowMs) {
      return { allowed: false, retryAfterSec: Math.ceil((bucket.lockUntilMs - nowMs) / 1000) };
    }
    return { allowed: true };
  }

  recordFailure(key: string, nowMs: number = Date.now()): LimitCheck {
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
  }
}

export const loginLimiter = new LoginLimiter();

/**
 * Per-session mutation rate limiter for sensitive console endpoints.
 *
 * Covers POST/PATCH/DELETE operations that an attacker with a stolen JWT
 * could abuse rapidly (password change, settings rewrite, logout-all).
 * Bulk operations (provider imports, key CRUD during setup) are intentionally
 * excluded so operators are not blocked by normal workflow.
 *
 * Design: sliding window with a fixed 10-second bucket. If a session exceeds
 * 5 mutations within one bucket the next request receives a 429 with a
 * `retry_after` hint. Buckets self-clean on access.
 */

import { readCookie, SESSION_COOKIE } from "./auth/http";

const WINDOW_MS = 10_000;
const MAX_MUTATIONS = 5;
const SWEEP_INTERVAL_MS = 60_000;

interface Bucket {
  timestamps: number[];
}

export type MutationLimitCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

export class MutationLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepMs = 0;

  private sweepStale(nowMs: number): void {
    if (nowMs - this.lastSweepMs < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.timestamps.length === 0 || nowMs - bucket.timestamps[bucket.timestamps.length - 1]! > WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
  }

  check(sessionId: string, nowMs: number = Date.now()): MutationLimitCheck {
    this.sweepStale(nowMs);
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return { allowed: true };

    // Drop timestamps outside the window.
    const cutoff = nowMs - WINDOW_MS;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) bucket.timestamps.shift();

    if (bucket.timestamps.length >= MAX_MUTATIONS) {
      const oldestInWindow = bucket.timestamps[0]!;
      return { allowed: false, retryAfterMs: oldestInWindow + WINDOW_MS - nowMs };
    }
    return { allowed: true };
  }

  record(sessionId: string, nowMs: number = Date.now()): MutationLimitCheck {
    this.sweepStale(nowMs);
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(sessionId, bucket);
    }

    // Prune before recording.
    const cutoff = nowMs - WINDOW_MS;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= cutoff) bucket.timestamps.shift();

    bucket.timestamps.push(nowMs);
    if (bucket.timestamps.length > MAX_MUTATIONS) {
      const oldestInWindow = bucket.timestamps[0]!;
      return { allowed: false, retryAfterMs: oldestInWindow + WINDOW_MS - nowMs };
    }
    return { allowed: true };
  }

  reset(sessionId: string): void {
    this.buckets.delete(sessionId);
  }

  resetAll(): void {
    this.buckets.clear();
    this.lastSweepMs = 0;
  }

  size(): number {
    return this.buckets.size;
  }
}

export const mutationLimiter = new MutationLimiter();

/**
 * Extracts a session key from the request cookie. Returns `undefined` when
 * the cookie is absent (the guard will reject the request anyway).
 */
export function sessionKey(request: Request): string | undefined {
  return readCookie(request, SESSION_COOKIE);
}

/**
 * Checks the per-session mutation limit for `request`. Returns a 429
 * Response if the limit is hit, otherwise `undefined` to let the handler
 * continue. Call this at the top of every sensitive mutation handler.
 */
export function checkMutationLimit(request: Request): Response | undefined {
  const key = sessionKey(request);
  if (!key) return undefined; // no cookie = guard will reject first
  const result = mutationLimiter.record(key);
  if (result.allowed) return undefined;
  return new Response(
    JSON.stringify({ error: { type: "rate_limit_error", message: "Too many requests. Slow down.", retry_after_ms: result.retryAfterMs } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.ceil(result.retryAfterMs / 1000)),
      },
    },
  );
}

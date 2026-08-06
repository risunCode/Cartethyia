import { runtimeMemoryLimits } from "./limits";

/**
 * Sliding-window per-IP rate limiter for the external API surface.
 *
 * Each IP owns a sorted timestamp list of accepted requests within the rolling
 * window. On every `tryAcquire`, entries older than the window are pruned from
 * the head (O(amortized) since pruned entries are never revisited), and if the
 * surviving count has reached the cap the request is rejected with the time
 * until the oldest entry falls out of the window as `retryAfterMs`.
 *
 * Stale, zero-entry IPs are swept periodically (every ~10% of `maxRequests`
 * acquisitions) so scanner traffic that hits an IP once and never returns
 * cannot grow the map forever. The sweep reuses the cutoff already computed
 * for the current request, so it adds no extra `Date.now()` calls.
 *
 * The map is also bounded by `maxTrackedIps` (env-tunable via
 * `CARTETHYIA_MAX_TRACKED_IPS`, 0 = adaptive) as a last line of defense against
 * pathological IP diversity — mirroring {@link PerIpFlightTracker}. When the
 * cap is reached on a new-IP insertion, the oldest-inserted entry is dropped in
 * O(1) via V8 Map insertion order rather than scanning for least-recently-seen.
 *
 * Unlike {@link PerIpFlightTracker} this bounds request *rate* (requests per
 * interval), not concurrency; the two compose — rate limiting runs first and
 * only admitted requests proceed to the flight/concurrency check.
 */
function resolveMaxTrackedIps(): number {
  if (runtimeMemoryLimits.maxTrackedIps > 0) return runtimeMemoryLimits.maxTrackedIps;
  // Adaptive: ~1 entry per 1KB of RSS, clamped to a sane range (mirrors per-ip.ts).
  const rssBytes = process.memoryUsage?.().rss ?? 256 * 1024 * 1024;
  return Math.min(Math.max(Math.floor(rssBytes / 1_024), 5_000), 500_000);
}

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedIps: number;
  private cleanupCounter = 0;
  private readonly cleanupEvery: number;

  constructor(maxRequests: number, windowMs: number, maxTrackedIps?: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxTrackedIps = maxTrackedIps ?? resolveMaxTrackedIps();
    this.cleanupEvery = Math.max(1, Math.floor(maxRequests * 0.1));
  }

  /** Evicts the oldest-inserted entry — V8 Map preserves insertion order, so O(1). */
  private evictOldest(): void {
    const oldest = this.windows.keys().next();
    if (!oldest.done) this.windows.delete(oldest.value as string);
  }

  /**
   * Attempts to record a request for `ip`. Returns `{ allowed: true }` when
   * the IP is within its quota, or `{ allowed: false, retryAfterMs }` with the
   * milliseconds until the oldest in-window request expires otherwise.
   */
  tryAcquire(ip: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    let timestamps = this.windows.get(ip);
    if (timestamps === undefined) {
      // Bound the map against pathological IP diversity (mirrors PerIpFlightTracker).
      if (this.windows.size >= this.maxTrackedIps) this.evictOldest();
      timestamps = [];
      this.windows.set(ip, timestamps);
    }
    // Prune entries that have fallen outside the window, from the head.
    const cutoff = now - this.windowMs;
    let firstValid = 0;
    while (firstValid < timestamps.length) {
      const ts = timestamps[firstValid];
      if (ts === undefined || ts > cutoff) break;
      firstValid++;
    }
    if (firstValid > 0) timestamps.splice(0, firstValid);
    if (timestamps.length >= this.maxRequests) {
      const oldest = timestamps[0] ?? now;
      return { allowed: false, retryAfterMs: Math.ceil(this.windowMs - (now - oldest)) };
    }
    timestamps.push(now);
    // Periodic cleanup of stale IPs (every ~10% of maxRequests acquisitions).
    if (++this.cleanupCounter >= this.cleanupEvery) {
      this.cleanupCounter = 0;
      for (const [key, ts] of this.windows) {
        if (ts.length === 0 || (ts[0] ?? 0) <= cutoff) this.windows.delete(key);
      }
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Number of distinct IPs currently tracked. */
  size(): number {
    return this.windows.size;
  }

  /** Test-only: drop all tracked windows. */
  clear(): void {
    this.windows.clear();
    this.cleanupCounter = 0;
  }
}

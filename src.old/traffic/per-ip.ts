import { runtimeMemoryLimits } from "./limits";

/**
 * Bounded per-IP concurrent-flight tracker for the proxy request path.
 *
 * Each acquire reserves one slot for an IP up to its configured max; release
 * is idempotent so disconnects or early returns cannot leak a slot. Stale,
 * zero-flight IPs are swept on access so scanner traffic that touches an IP
 * once and never returns cannot grow the map forever. The map is also bounded
 * by a configurable cap (env-tunable via `CARTETHYIA_MAX_TRACKED_IPS`, 0 = adaptive
 * based on available memory) as a last line of defense against pathological
 * IP diversity. Eviction uses V8 Map insertion order — the oldest-inserted
 * entry is dropped in O(1) instead of scanning for the least-recently-seen.
 */

const SWEEP_INTERVAL_MS = 60_000;

/** Derives the effective max tracked IPs: env override, or adaptive from RSS. */
function resolveMaxTrackedIps(): number {
  if (runtimeMemoryLimits.maxTrackedIps > 0) return runtimeMemoryLimits.maxTrackedIps;
  // Adaptive: ~1 entry per 1KB of RSS, clamped to a sane range.
  const rssBytes = process.memoryUsage?.().rss ?? 256 * 1024 * 1024;
  return Math.min(Math.max(Math.floor(rssBytes / 1_024), 5_000), 500_000);
}

interface IpFlight {
  count: number;
  lastSeenMs: number;
}

export interface PerIpFlightHandle {
  readonly ip: string;
  /** Releases the acquired slot exactly once; repeated calls are no-ops. */
  release(): void;
}

export class PerIpFlightTracker {
  private readonly active = new Map<string, IpFlight>();
  private lastSweepMs = 0;

  activeCount(ip: string): number {
    return this.active.get(ip)?.count ?? 0;
  }

  tryAcquire(ip: string, max: number, nowMs: number = Date.now()): PerIpFlightHandle | null {
    if (max < 1) return null;
    this.sweepStale(nowMs);
    const entry = this.active.get(ip);
    const current = entry?.count ?? 0;
    if (current >= max) return null;
    if (entry === undefined) {
      if (this.active.size >= resolveMaxTrackedIps()) this.evictOldest();
      this.active.set(ip, { count: 1, lastSeenMs: nowMs });
    } else {
      entry.count += 1;
      entry.lastSeenMs = nowMs;
    }
    let released = false;
    return {
      ip,
      release: () => {
        if (released) return;
        released = true;
        const row = this.active.get(ip);
        if (row === undefined) return;
        row.count -= 1;
        if (row.count <= 0) this.active.delete(ip);
      },
    };
  }

  private sweepStale(nowMs: number): void {
    if (nowMs - this.lastSweepMs < SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = nowMs;
    const cutoff = nowMs - SWEEP_INTERVAL_MS;
    for (const [ip, entry] of this.active) {
      if (entry.count <= 0 || entry.lastSeenMs < cutoff) this.active.delete(ip);
    }
  }

  /** Evicts the oldest-inserted entry — V8 Map preserves insertion order, so O(1). */
  private evictOldest(): void {
    const oldest = this.active.keys().next();
    if (!oldest.done) this.active.delete(oldest.value as string);
  }

  snapshot(): Array<{ readonly ip: string; readonly active: number }> {
    return [...this.active.entries()]
      .filter(([, entry]) => entry.count > 0)
      .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
      .map(([ip, entry]) => ({ ip, active: entry.count }));
  }

  size(): number {
    return this.active.size;
  }

  /** Test-only: drop all tracked IPs. */
  clear(): void {
    this.active.clear();
    this.lastSweepMs = 0;
  }
}

/** Process-wide tracker shared by the proxy server and console diagnostics. */
export const activePerIpFlights = new PerIpFlightTracker();

/**
 * Periodic runtime gauges: process memory plus bounded-collection sizes.
 *
 * Sampling is driven by `ScheduledTaskRegistry` (unref'd interval) rather than
 * a dedicated timer so it shares the process's existing maintenance lifecycle
 * and stops with it. Map/collection sizes are read through closures supplied at
 * composition time; this module owns no references to the routing or pool
 * layers, keeping the observability boundary one-directional.
 */
import { readFileSync } from "node:fs";
import { metrics } from "./metrics";
import { trackMemoryUsage } from "./performance-metrics";
import { log } from "./logger";
import { resolveMemoryLimitOverrideBytes } from "../config";

/** Live collection sizes sampled alongside process memory. */
export interface RuntimeMetricSources {
  readonly routingRoundRobinEntries: () => { readonly combo: number; readonly provider: number };
  readonly poolAgentEntries: () => number;
  /**
   * Tracked keys in the in-memory IP abuse store, or 0 when the store is
   * Redis-backed. Unlike the routing maps this one is fed by client-supplied
   * identities, so its size is the leak signal to watch.
   */
  readonly ipAbuseKeys: () => number;
  /** Tracked keys in the in-process quota cache tier (0 when Redis-only paths are idle). */
  readonly quotaCacheEntries: () => number;
}

/** Cooldown between memory-pressure warnings so a sustained high-water mark does not flood logs. */
const PRESSURE_LOG_WINDOW_MS = 60_000;
/** Cooldown between proactive garbage collections while pressure persists. */
const PRESSURE_GC_WINDOW_MS = 60_000;
/** Fraction of the resolved limit at which memory pressure is reported. */
const PRESSURE_THRESHOLD = 0.8;

/**
 * Resolves the effective memory limit for the process.
 *
 * Precedence: an explicit `CARTETHYIA_MEMORY_LIMIT_BYTES` override, then the
 * cgroup v2/v1 limit when running in a container. Returns `undefined` when no
 * limit is discoverable (native development, macOS, Windows).
 */
export function resolveMemoryLimitBytes(): number | undefined {
  const override = resolveMemoryLimitOverrideBytes();
  if (override !== undefined) return override;
  if (process.platform !== "linux") return undefined;
  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content === "max") continue;
      const value = Number(content);
      // The v1 unlimited sentinel is a huge finite number; treat it as unknown.
      if (Number.isInteger(value) && value > 0 && value < 2 ** 53) return value;
    } catch {
      // File absent (cgroup v1 vs v2) or unreadable — try the next source.
    }
  }
  return undefined;
}

/** Samples process memory and bounded-collection sizes into the metric registry. */
export class RuntimeMetricsSampler {
  private readonly limitBytes: number | undefined;
  private readonly gcOnPressure: boolean;
  private lastPressureLogAt = 0;
  private lastGcAt = 0;

  constructor(
    private readonly sources: RuntimeMetricSources,
    limitBytes: number | undefined = resolveMemoryLimitBytes(),
    gcOnPressure = true,
  ) {
    this.limitBytes = limitBytes;
    this.gcOnPressure = gcOnPressure;
  }

  sample(): void {
    const memory = process.memoryUsage();
    metrics.cartethyia_memory_rss_bytes.set(memory.rss);
    metrics.cartethyia_memory_heap_used_bytes.set(memory.heapUsed);
    metrics.cartethyia_memory_heap_total_bytes.set(memory.heapTotal);
    metrics.cartethyia_memory_limit_bytes.set(this.limitBytes ?? 0);
    trackMemoryUsage("rss", memory.rss);
    trackMemoryUsage("heap_used", memory.heapUsed);
    trackMemoryUsage("heap_total", memory.heapTotal);
    trackMemoryUsage("external", memory.external);

    const roundRobin = this.sources.routingRoundRobinEntries();
    metrics.cartethyia_routing_roundrobin_entries.set(roundRobin.combo, { scope: "combo" });
    metrics.cartethyia_routing_roundrobin_entries.set(roundRobin.provider, { scope: "provider" });
    metrics.cartethyia_ip_abuse_keys.set(this.sources.ipAbuseKeys());
    metrics.cartethyia_quota_cache_entries.set(this.sources.quotaCacheEntries());

    this.checkPressure(memory.rss);
  }

  private checkPressure(rss: number): void {
    if (this.limitBytes === undefined || rss <= this.limitBytes * PRESSURE_THRESHOLD) return;
    const now = Date.now();
    if (this.gcOnPressure && now - this.lastGcAt >= PRESSURE_GC_WINDOW_MS) {
      this.lastGcAt = now;
      // Asynchronous GC: reclaims before the limit is reached without stalling
      // in-flight requests on the shared event loop. A synchronous full
      // collection here would add a latency spike to every concurrent request.
      Bun.gc(false);
    }
    if (now - this.lastPressureLogAt < PRESSURE_LOG_WINDOW_MS) return;
    this.lastPressureLogAt = now;
    log.warn(
      `[memory] RSS ${(rss / 1024 / 1024).toFixed(1)}MiB exceeds 80% of the ` +
        `${(this.limitBytes / 1024 / 1024).toFixed(1)}MiB limit`,
    );
  }
}

/**
 * Lightweight, bounded performance counters for the console.
 *
 * These complement the Prometheus registry (`metrics.ts`) with a small,
 * directly-inspectable snapshot (adapter load time, catalog load time,
 * outbound latency, sampled memory) surfaced through the console API. Every
 * series is capped so untrusted keys (e.g. upstream hostnames) cannot grow the
 * maps without bound; once full, new keys are dropped rather than evicting.
 */

/** Cardinality cap per series. */
export const MAX_PERFORMANCE_ENTRIES = 256;

/** JSON-serializable performance snapshot. */
export interface PerformanceMetricsSnapshot {
  adapter_load_ms: Record<string, number>;
  model_catalog_load_ms: Record<string, number>;
  network_call_latency_ms: Record<string, number>;
  memory_bytes: Record<string, number>;
}

class BoundedSeries {
  private readonly values = new Map<string, number>();

  record(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    if (!this.values.has(key) && this.values.size >= MAX_PERFORMANCE_ENTRIES) return;
    this.values.set(key, value);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  clear(): void {
    this.values.clear();
  }
}

const adapterLoadTime = new BoundedSeries();
const modelCatalogLoadTime = new BoundedSeries();
const networkCallLatency = new BoundedSeries();
const memoryUsage = new BoundedSeries();

/** Records the time to load one provider adapter on first use. */
export function trackAdapterLoad(providerId: string, durationMs: number): void {
  adapterLoadTime.record(providerId, durationMs);
}

/** Records the time to load one provider's model catalog. */
export function trackModelCatalogLoad(providerId: string, durationMs: number): void {
  modelCatalogLoadTime.record(providerId, durationMs);
}

/** Records outbound request latency keyed by upstream host. */
export function trackNetworkCall(host: string, durationMs: number): void {
  networkCallLatency.record(host, durationMs);
}

/** Records a sampled memory figure keyed by component name. */
export function trackMemoryUsage(component: string, bytes: number): void {
  memoryUsage.record(component, bytes);
}

/** Returns the current snapshot for the console performance endpoint. */
export function performanceMetricsSnapshot(): PerformanceMetricsSnapshot {
  return {
    adapter_load_ms: adapterLoadTime.snapshot(),
    model_catalog_load_ms: modelCatalogLoadTime.snapshot(),
    network_call_latency_ms: networkCallLatency.snapshot(),
    memory_bytes: memoryUsage.snapshot(),
  };
}

/** Clears all series. Test-only. */
export function resetPerformanceMetricsForTesting(): void {
  adapterLoadTime.clear();
  modelCatalogLoadTime.clear();
  networkCallLatency.clear();
  memoryUsage.clear();
}

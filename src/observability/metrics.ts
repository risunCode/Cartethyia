import { createCleanupStack } from "../application/contracts";

/**
 * Minimal OpenTelemetry-compatible metrics collector with Prometheus exposition.
 * No external dependencies - uses in-memory counters and histograms.
 */

export type MetricLabels = Record<string, string>;

interface Counter {
  value: number;
  labels: MetricLabels;
}

interface Histogram {
  buckets: Map<number, number>;
  sum: number;
  count: number;
  labels: MetricLabels;
}

interface Gauge {
  value: number;
  labels: MetricLabels;
}

export class MetricsCollector {
  private counters = new Map<string, Counter[]>();
  private histograms = new Map<string, Histogram[]>();
  private gauges = new Map<string, Gauge[]>();
  private readonly defaultLabels: MetricLabels;

  constructor(defaultLabels: MetricLabels = {}) {
    this.defaultLabels = defaultLabels;
  }

  /** Increment a counter by 1 (or by `value`). */
  incrementCounter(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = this.makeKey(name, labels);
    const mergedLabels = { ...this.defaultLabels, ...labels };
    const existing = this.counters.get(key);
    if (existing) {
      const found = existing.find((c) => this.labelsEqual(c.labels, mergedLabels));
      if (found) {
        found.value += value;
      } else {
        existing.push({ value, labels: mergedLabels });
      }
    } else {
      this.counters.set(key, [{ value, labels: mergedLabels }]);
    }
  }

  /** Record a value in a histogram (latency in ms, size in bytes, etc.). */
  recordHistogram(name: string, value: number, labels: MetricLabels = {}): void {
    const key = this.makeKey(name, labels);
    const mergedLabels = { ...this.defaultLabels, ...labels };
    const existing = this.histograms.get(key);
    const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
    if (existing) {
      const found = existing.find((h) => this.labelsEqual(h.labels, mergedLabels));
      if (found) {
        found.count++;
        found.sum += value;
        for (const bucket of buckets) {
          if (value <= bucket) {
            found.buckets.set(bucket, (found.buckets.get(bucket) ?? 0) + 1);
          }
        }
      } else {
        const newHist = this.createHistogram(value, buckets, mergedLabels);
        existing.push(newHist);
      }
    } else {
      this.histograms.set(key, [this.createHistogram(value, buckets, mergedLabels)]);
    }
  }

  /** Set a gauge value. */
  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const key = this.makeKey(name, labels);
    const mergedLabels = { ...this.defaultLabels, ...labels };
    const existing = this.gauges.get(key);
    if (existing) {
      const found = existing.find((g) => this.labelsEqual(g.labels, mergedLabels));
      if (found) {
        found.value = value;
      } else {
        existing.push({ value, labels: mergedLabels });
      }
    } else {
      this.gauges.set(key, [{ value, labels: mergedLabels }]);
    }
  }

  /** Get Prometheus-format metrics text. */
  toPrometheus(): string {
    const lines: string[] = [];
    lines.push("# HELP cartethyia_build_info Build information");
    lines.push("# TYPE cartethyia_build_info gauge");
    lines.push(`cartethyia_build_info{version="${this.getVersion()}"} 1`);

    for (const [name, counters] of this.counters) {
      lines.push(`# HELP ${name} Counter`);
      lines.push(`# TYPE ${name} counter`);
      for (const c of counters) {
        const labelStr = this.formatLabels(c.labels);
        lines.push(`${name}${labelStr} ${c.value}`);
      }
    }

    for (const [name, histograms] of this.histograms) {
      lines.push(`# HELP ${name} Histogram`);
      lines.push(`# TYPE ${name} histogram`);
      for (const h of histograms) {
        const labelStr = this.formatLabels(h.labels);
        let cumCount = 0;
        const buckets = Array.from(h.buckets.entries()).sort((a, b) => a[0] - b[0]);
        for (const [le, count] of buckets) {
          cumCount += count;
          lines.push(`${name}_bucket${labelStr}${labelStr ? "," : ""}le="${le}" ${cumCount}`);
        }
        lines.push(`${name}_bucket${labelStr}${labelStr ? "," : ""}le="+Inf" ${h.count}`);
        lines.push(`${name}_sum${labelStr} ${h.sum}`);
        lines.push(`${name}_count${labelStr} ${h.count}`);
      }
    }

    for (const [name, gauges] of this.gauges) {
      lines.push(`# HELP ${name} Gauge`);
      lines.push(`# TYPE ${name} gauge`);
      for (const g of gauges) {
        const labelStr = this.formatLabels(g.labels);
        lines.push(`${name}${labelStr} ${g.value}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  /** Reset all metrics. */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  private createHistogram(value: number, buckets: number[], labels: MetricLabels): Histogram {
    const bucketMap = new Map<number, number>();
    for (const bucket of buckets) {
      if (value <= bucket) bucketMap.set(bucket, 1);
    }
    return { buckets: bucketMap, sum: value, count: 1, labels };
  }

  private makeKey(name: string, labels: MetricLabels): string {
    const labelKeys = Object.keys(labels).sort();
    return name + "|" + labelKeys.map((k) => `${k}=${labels[k]}`).join(",");
  }

  private labelsEqual(a: MetricLabels, b: MetricLabels): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  private formatLabels(labels: MetricLabels): string {
    const entries = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) return "";
    return "{" + entries.map(([k, v]) => `${k}="${v}"`).join(",") + "}";
  }

  private getVersion(): string {
    try {
      const pkg = require("../../package.json");
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }
}

/** Global metrics instance. */
export const metrics = new MetricsCollector({ service: "cartethyia" });

/** Standard metric names. */
export const MetricNames = {
  HTTP_REQUESTS_TOTAL: "http_requests_total",
  HTTP_REQUEST_DURATION_MS: "http_request_duration_ms",
  HTTP_REQUEST_SIZE_BYTES: "http_request_size_bytes",
  HTTP_RESPONSE_SIZE_BYTES: "http_response_size_bytes",
  PROXY_REQUESTS_TOTAL: "proxy_requests_total",
  PROXY_REQUEST_DURATION_MS: "proxy_request_duration_ms",
  PROXY_UPSTREAM_DURATION_MS: "proxy_upstream_duration_ms",
  PROXY_RETRIES_TOTAL: "proxy_retries_total",
  PROXY_FAILOVERS_TOTAL: "proxy_failovers_total",
  PROXY_ERRORS_TOTAL: "proxy_errors_total",
  PROVIDER_CALLS_TOTAL: "provider_calls_total",
  PROVIDER_CALL_DURATION_MS: "provider_call_duration_ms",
  PROVIDER_ERRORS_TOTAL: "provider_errors_total",
  ACCOUNT_HEALTH: "account_health",
  PROXY_POOL_SIZE: "proxy_pool_size",
  IN_FLIGHT_REQUESTS: "in_flight_requests",
  TOKEN_USAGE_TOTAL: "token_usage_total",
} as const;

/** Standard label keys. */
export const MetricLabels = {
  METHOD: "method",
  ENDPOINT: "endpoint",
  STATUS: "status",
  PROVIDER: "provider",
  MODEL: "model",
  SURFACE: "surface",
  ROUTE_STRATEGY: "route_strategy",
  ERROR_KIND: "error_kind",
  ACCOUNT_ID: "account_id",
  PROXY_ID: "proxy_id",
} as const;

/** Export the global metrics instance's Prometheus formatter. */
export function toPrometheus(): string {
  return metrics.toPrometheus();
}
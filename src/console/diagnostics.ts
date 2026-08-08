/**
 * Read-only console diagnostics.
 *
 * Everything in this module is a query: runtime metadata, process health,
 * bounded account/proxy health with failed/replacement route payloads,
 * model-route simulation and provider health checks. No function here writes
 * configuration or telemetry state, and
 * none of them read provider credentials. Request-history rows expose only
 * compact scalar metadata (`clientName`/`clientSource` labels included);
 * raw headers, user-agent strings, prompt markers, and request content are
 * never available through the console.
 */

import { cpus, freemem, networkInterfaces, totalmem } from "node:os";
import { platform } from "node:os";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import packageJson from "../../package.json";
import type { ProviderRegistry } from "../providers/registry";
import { scheduleGlobalGc, type GcScheduleResult } from "../traffic/memory";
import { resolveModelChain, type ChainResult, type ModelReferenceConfig } from "../application/routing";
import type {
  ConsoleLogLine,
  ConsoleRepositories,
  ConsoleServices,
  ConsoleRuntimeSettings,
  IpSummaryView,
  ProviderTodayView,
  RequestHistoryRow,
  UsageDimension,
  UsagePeriod,
  UsageSummaryView,
} from "./services";

const SERVER_STARTED_AT = Date.now();
const CPU_INFO = cpus();

let lastCpuUsage: NodeJS.CpuUsage | undefined;
let lastSampleAt: number | undefined;

/** CPU% since the previous sample (0 on the first call after cold start). */
function sampleCpuPercent(): number {
  const now = performance.now();
  const usage = process.cpuUsage();
  if (lastCpuUsage === undefined || lastSampleAt === undefined) {
    lastCpuUsage = usage;
    lastSampleAt = now;
    return 0;
  }
  const elapsedMs = now - lastSampleAt;
  const deltaCpuUs = usage.user - lastCpuUsage.user + (usage.system - lastCpuUsage.system);
  lastCpuUsage = usage;
  lastSampleAt = now;
  if (elapsedMs <= 0) return 0;
  const coreCount = Math.max(1, CPU_INFO.length);
  const percent = ((deltaCpuUs / 1000) / elapsedMs) * 100 / coreCount;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

// ── Network bandwidth tracking ──────────────────────────────────────────
// Samples cumulative bytes received/sent across all network interfaces.
// Returns null on platforms/contexts where the counters are unavailable
// (e.g. permission errors), so the UI can gracefully show "—".

interface NetSample { receivedBytes: number; sentBytes: number; }
interface NetState { last: NetSample | null; lastAt: number | undefined; }

const netState: NetState = { last: null, lastAt: undefined };

// Bandwidth sampling is expensive (execSync powershell on Windows,
// readFileSync /proc/net/dev on Linux) and runs on every metrics() call.
// Cache the result for 5s so the console dashboard poll doesn't fork a
// shell or read a file on every request. The rate computation still uses
// the previous raw sample, so deltas stay accurate across the TTL window.
const BANDWIDTH_TTL_MS = 5_000;
type BandwidthResult = { receivedKb: number; sentKb: number; totalKb: number; rateKbps: number };
let cachedBandwidth: { value: BandwidthResult | null; at: number } = { value: null, at: 0 };

/** Read cumulative network I/O bytes from the OS. Returns null if unavailable. */
function readNetBytes(): NetSample | null {
  try {
    if (platform() === "linux") {
      // /proc/net/dev — line format: "interface: rx_bytes rx_packets ... tx_bytes ..."
      const data = readFileSync("/proc/net/dev", "utf8");
      let received = 0, sent = 0;
      for (const line of data.split("\n").slice(2)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 17) continue;
        const rx = Number(parts[1]);
        const tx = Number(parts[9]);
        if (Number.isFinite(rx)) received += rx;
        if (Number.isFinite(tx)) sent += tx;
      }
      if (received === 0 && sent === 0) return null;
      return { receivedBytes: received, sentBytes: sent };
    }
    if (platform() === "win32") {
      // Sum ReceivedBytes/SentBytes across all physical adapters.
      // Use Select-Object with explicit property names to get clean CSV output
      // that survives shell escaping layers.
      const out = execSync(
        'powershell -NoProfile -Command "Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Csv -NoTypeInformation"',
        { encoding: "utf8", timeout: 5_000 },
      );
      let received = 0, sent = 0;
      for (const line of out.trim().split("\n").slice(1)) {
        const cols = line.replace(/"/g, "").split(",");
        if (cols.length < 2) continue;
        const rx = Number(cols[0]);
        const tx = Number(cols[1]);
        if (Number.isFinite(rx)) received += rx;
        if (Number.isFinite(tx)) sent += tx;
      }
      if (received === 0 && sent === 0) return null;
      return { receivedBytes: received, sentBytes: sent };
    }
  } catch {
    // Silently fall back to null — UI shows "—"
  }
  return null;
}

/** Samples network I/O and computes cumulative + rate stats, cached for 5s. */
function sampleNetworkBandwidth(): BandwidthResult | null {
  const now = performance.now();
  // Return the cached value while it is both present and within the TTL window.
  // Only recompute (and thus spawn powershell / read /proc/net/dev) when the
  // cache is null OR expired — never on every poll. The previous condition was
  // inverted (`!== null` recomputed whenever a value EXISTED), forcing a
  // synchronous powershell spawn on every /health/metrics request.
  if (cachedBandwidth.value !== null && now - cachedBandwidth.at < BANDWIDTH_TTL_MS) return cachedBandwidth.value;
  cachedBandwidth = { value: computeBandwidth(now), at: now };
  return cachedBandwidth.value;
}

/** Raw bandwidth computation — uncached, called at most once per TTL window. */
function computeBandwidth(now: number): BandwidthResult | null {
  const current = readNetBytes();
  if (current === null) return null;
  if (netState.last === null || netState.lastAt === undefined) {
    netState.last = current;
    netState.lastAt = now;
    return { receivedKb: Math.round(current.receivedBytes / 1024), sentKb: Math.round(current.sentBytes / 1024), totalKb: Math.round((current.receivedBytes + current.sentBytes) / 1024), rateKbps: 0 };
  }
  const elapsedMs = now - netState.lastAt;
  const deltaRx = current.receivedBytes - netState.last.receivedBytes;
  const deltaTx = current.sentBytes - netState.last.sentBytes;
  // Clamp negative deltas (counter reset / adapter change)
  const safeDeltaRx = Math.max(0, deltaRx);
  const safeDeltaTx = Math.max(0, deltaTx);
  const rateKbps = elapsedMs > 0 ? Math.round(((safeDeltaRx + safeDeltaTx) / 1024) / (elapsedMs / 1000)) : 0;
  netState.last = current;
  netState.lastAt = now;
  return { receivedKb: Math.round(current.receivedBytes / 1024), sentKb: Math.round(current.sentBytes / 1024), totalKb: Math.round((current.receivedBytes + current.sentBytes) / 1024), rateKbps };
}

function memorySnapshot(): MetricsView {
  const mem = process.memoryUsage();
  const total = totalmem();
  const free = freemem();
  const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const net = sampleNetworkBandwidth();
  return {
    memoryUsedMb: toMb(mem.rss),
    memorySystemUsedMb: toMb(total - free),
    memoryTotalMb: Math.round(total / 1024 / 1024),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
    cpuPercent: sampleCpuPercent(),
    coreCount: CPU_INFO.length,
    pid: process.pid,
    netReceivedKb: net?.receivedKb ?? null,
    netSentKb: net?.sentKb ?? null,
    netTotalKb: net?.totalKb ?? null,
    netRateKbps: net?.rateKbps ?? null,
  };
}

export interface StatusView {
  readonly version: string;
  readonly startedAt: number;
  readonly uptimeSeconds: number;
  readonly now: number;
  readonly timezoneOffsetMinutes: number;
}

export interface MetricsView {
  readonly memoryUsedMb: number;
  readonly memorySystemUsedMb: number;
  readonly memoryTotalMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly cpuPercent: number;
  readonly coreCount: number;
  readonly pid: number;
  readonly netReceivedKb: number | null;
  readonly netSentKb: number | null;
  readonly netTotalKb: number | null;
  readonly netRateKbps: number | null;
}

export interface ResolvePreviewView {
  readonly ok: boolean;
  readonly trace: readonly string[];
  readonly resolved: ChainResult;
}

export interface OverviewView {
  readonly totals: UsageSummaryView;
  readonly inFlight: number;
  readonly providers: readonly ProviderTodayView[];
  readonly proxyAuthMode: ConsoleRuntimeSettings["proxyAuthMode"];
  readonly registered: readonly string[];
}

export interface ConsoleDiagnosticsOptions {
  readonly services: ConsoleServices;
  readonly repositories: ConsoleRepositories;
  readonly registry: ProviderRegistry;
  /** Provider prefix â†’ provider id map used for model reference parsing (lead-wired). */
  readonly prefixes?: ReadonlyMap<string, string>;
  /** Optional live counters supplied by the composition layer. */
  readonly runtimeCounters?: { readonly inFlight: () => number };
}

const MAX_REQUEST_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), maximum) : fallback;
}

function boundedPeriod(value: unknown): UsagePeriod {
  return value === "1h" || value === "7d" || value === "30d" || value === "24h" || value === "all" ? value : "24h";
}

export class ConsoleDiagnostics {
  private readonly services: ConsoleServices;
  private readonly repositories: ConsoleRepositories;
  private readonly registry: ProviderRegistry;
  private readonly prefixes: ReadonlyMap<string, string>;
  private readonly runtimeCounters: { readonly inFlight: () => number } | null;
  private overviewCache: { value: OverviewView; expiresAt: number } | null = null;
  private overviewPending: Promise<OverviewView> | null = null;

  constructor(options: ConsoleDiagnosticsOptions) {
    this.services = options.services;
    this.repositories = options.repositories;
    this.registry = options.registry;
    this.prefixes = options.prefixes ?? new Map<string, string>();
    this.runtimeCounters = options.runtimeCounters ?? null;
  }

  status(): StatusView {
    const now = Date.now();
    return {
      version: typeof packageJson.version === "string" ? packageJson.version : "unknown",
      startedAt: SERVER_STARTED_AT,
      uptimeSeconds: Math.floor((now - SERVER_STARTED_AT) / 1000),
      now,
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    };
  }

  metrics(): MetricsView {
    return memorySnapshot();
  }

  gc(): { before: MetricsView; after: MetricsView; gc: GcScheduleResult } {
    const before = memorySnapshot();
    const gc = scheduleGlobalGc();
    const after = memorySnapshot();
    return { before, after, gc };
  }

  localIps(): readonly string[] {
    const nets = networkInterfaces();
    const ips: string[] = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (!net.internal && net.family === "IPv4") ips.push(net.address);
      }
    }
    return ips;
  }

  // -------------------------------------------------------------------------
  // Runtime metadata (read-only)
  // -------------------------------------------------------------------------

  async requestHistory(rawFilters: unknown): Promise<{ readonly items: readonly RequestHistoryRow[]; readonly nextCursor: string | null }> {
    const filters: {
      period: UsagePeriod;
      limit: number;
      providerId?: string;
      model?: string;
      apiKeyId?: string;
      status?: "ok" | "error";
      cursor?: string;
      clientIp?: string;
    } = { period: "24h", limit: 50 };
    if (typeof rawFilters === "object" && rawFilters !== null) {
      const value = rawFilters as Record<string, unknown>;
      filters.period = boundedPeriod(value.period);
      if (typeof value.providerId === "string") filters.providerId = value.providerId;
      if (typeof value.model === "string") filters.model = value.model;
      if (typeof value.apiKeyId === "string") filters.apiKeyId = value.apiKeyId;
      if (value.status === "ok" || value.status === "error") filters.status = value.status;
      if (typeof value.cursor === "string") filters.cursor = value.cursor;
      if (typeof value.clientIp === "string") filters.clientIp = value.clientIp;
      filters.limit = boundedLimit(value.limit, 50, MAX_REQUEST_LIMIT);
    }
    return this.repositories.runtimeMetadata.queryRequests(filters);
  }

  async requestDetail(requestId: string): Promise<RequestHistoryRow | null> {
    return this.repositories.runtimeMetadata.getRequest(requestId);
  }

  async usageSummary(period: unknown): Promise<UsageSummaryView> {
    return this.repositories.runtimeMetadata.queryUsageSummary(boundedPeriod(period));
  }

  async providerToday(): Promise<readonly ProviderTodayView[]> {
    return this.repositories.runtimeMetadata.queryProviderToday();
  }

  async queryIpSummary(limit: number): Promise<readonly IpSummaryView[]> {
    return this.repositories.runtimeMetadata.queryIpSummary(limit);
  }

  async usageCache(period: unknown) {
    return this.repositories.runtimeMetadata.queryUsageCache(boundedPeriod(period));
  }

  async usageChart(period: unknown) {
    return this.repositories.runtimeMetadata.queryUsageChart(boundedPeriod(period));
  }

  async usageBy(dimension: UsageDimension, period: unknown) {
    return this.repositories.runtimeMetadata.queryUsageBy(dimension, boundedPeriod(period));
  }

  async logs(limit: unknown): Promise<readonly ConsoleLogLine[]> {
    return this.repositories.runtimeMetadata.queryLogs(boundedLimit(limit, 200, MAX_LOG_LIMIT));
  }

  async overview(): Promise<OverviewView> {
    const now = Date.now();
    const cached = this.overviewCache;
    if (cached !== null && cached.expiresAt > now) {
      return { ...cached.value, inFlight: this.runtimeCounters?.inFlight() ?? 0 };
    }
    if (this.overviewPending !== null) {
      const snapshot = await this.overviewPending;
      return { ...snapshot, inFlight: this.runtimeCounters?.inFlight() ?? 0 };
    }
    const pending = (async (): Promise<OverviewView> => {
      const [totals, providers, settings] = await Promise.all([
        this.repositories.runtimeMetadata.queryUsageSummary("24h"),
        this.repositories.runtimeMetadata.queryProviderToday(),
        this.services.settings.get(),
      ]);
      return {
        totals,
        inFlight: this.runtimeCounters?.inFlight() ?? 0,
        providers,
        proxyAuthMode: settings.runtime.proxyAuthMode,
        registered: this.registry.list().map((adapter) => adapter.metadata.id),
      };
    })();
    this.overviewPending = pending;
    try {
      const snapshot = await pending;
      this.overviewCache = { value: snapshot, expiresAt: Date.now() + 2_000 };
      return snapshot;
    } finally {
      if (this.overviewPending === pending) this.overviewPending = null;
    }
  }

  // -------------------------------------------------------------------------
  // Route simulation and provider health (read-only)
  // -------------------------------------------------------------------------

  /**
   * Resolves a model reference through the same pure chain used by the data
   * plane. Read-only: no credentials are read and no state is written.
   */
  async resolvePreview(model: unknown): Promise<ResolvePreviewView> {
    if (typeof model !== "string" || model.trim().length === 0) {
      return { ok: false, trace: ["model name is required"], resolved: { kind: "unresolved" } };
    }
    const [aliases, combos] = await Promise.all([
      this.repositories.routing.listAliases(),
      this.repositories.routing.listCombos(),
    ]);
    const config: ModelReferenceConfig = {
      prefixes: this.prefixes,
      aliases: new Map(aliases.map((alias) => [alias.alias, alias.model])),
      combos: new Map(
        combos.map((combo) => [
          combo.name,
          { id: combo.id, models: [...combo.models], strategy: combo.strategy, stickyLimit: combo.stickyLimit },
        ]),
      ),
    };
    const resolved = resolveModelChain(model.trim(), config);
    const trace = buildResolveTrace(model.trim(), resolved);
    return { ok: resolved.kind !== "unresolved", trace, resolved };
  }

}

/** Bounded human-readable trace of a model chain resolution. */
function buildResolveTrace(rawModel: string, resolved: ChainResult): readonly string[] {
  if (resolved.kind === "qualified") {
    return [
      `parsed "${rawModel}" as provider-qualified`,
      `resolved to ${resolved.model.providerId}/${resolved.model.modelId}`,
    ];
  }
  if (resolved.kind === "combo") {
    return [
      `"${rawModel}" is a combo with ${resolved.candidates.length} candidate(s)`,
      ...resolved.candidates.map((candidate) => `- ${candidate.providerId}/${candidate.modelId}`),
    ];
  }
  return [`"${rawModel}" did not resolve to a configured provider, alias, or combo`];
}

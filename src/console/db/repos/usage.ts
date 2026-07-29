import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConsoleEnv } from "../../env";

const MAX_HISTORY = 10_000;
let nextId = 1;
let hydratedDataDir: string | null = null;
const records: Array<UsageInsert & { id: number }> = [];

export interface UsageInsert {
  traceId: string;
  endpoint: string;
  surface: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  provider: string | null;
  model: string | null;
  status: number;
  errorKind: string | null;
  stream: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  usageSource: string;
  meta: Record<string, unknown>;
}

export function utcNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export function utcDateOf(ts: string): string {
  return ts.slice(0, 10);
}

function trimHistory(): void {
  if (records.length > MAX_HISTORY) records.splice(0, records.length - MAX_HISTORY);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hydrateHistory(): void {
  const env = getConsoleEnv();
  if (hydratedDataDir === env.dataDir) return;
  records.length = 0;
  nextId = 1;
  hydratedDataDir = env.dataDir;
  if (!existsSync(env.logDir)) return;

  const files = readdirSync(env.logDir).filter((file) => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
  for (const file of files) {
    for (const line of readFileSync(join(env.logDir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const item: unknown = JSON.parse(line);
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.traceId !== "string" || typeof record.endpoint !== "string" || typeof record.startedAt !== "string") continue;
        const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
          ? record.usage as Record<string, unknown>
          : {};
        records.push({
          id: nextId++, traceId: record.traceId, endpoint: record.endpoint,
          surface: typeof record.surface === "string" ? record.surface : "chat",
          apiKeyId: typeof record.apiKeyId === "string" ? record.apiKeyId : null,
          apiKeyPrefix: typeof record.keyPrefix === "string" ? record.keyPrefix : null,
          provider: typeof record.provider === "string" ? record.provider : null,
          model: typeof record.model === "string" ? record.model : null,
          status: typeof record.status === "number" ? record.status : 0,
          errorKind: typeof record.errorKind === "string" ? record.errorKind : null,
          stream: record.stream === true, startedAt: record.startedAt,
          finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : record.startedAt,
          durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
          inputTokens: nullableNumber(usage.inputTokens), outputTokens: nullableNumber(usage.outputTokens),
          cachedTokens: nullableNumber(usage.cachedTokens), cacheWriteTokens: nullableNumber(usage.cacheWriteTokens),
          reasoningTokens: nullableNumber(usage.reasoningTokens), totalTokens: nullableNumber(usage.totalTokens),
          usageSource: typeof usage.source === "string" ? usage.source : "missing",
          meta: record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta as Record<string, unknown> : {},
        });
      } catch {
        // A malformed line must not hide subsequent valid history.
      }
    }
  }
  trimHistory();
}

export function insertUsageHistory(row: UsageInsert): number {
  hydrateHistory();
  const id = nextId++;
  records.push({ ...row, id });
  trimHistory();
  return id;
}

export function upsertUsageDaily(_input: {
  date: string;
  apiKeyId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  error: boolean;
  durationMs: number;
}): void {}

/** Append one runtime record to data/logs/<kind>-YYYY-MM-DD.jsonl. */
export function appendJsonl(kind: "requests" | "errors", record: Record<string, unknown>): void {
  const env = getConsoleEnv();
  mkdirSync(env.logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(env.logDir, `${kind}-${day}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

/** Return the persisted request-log event for a trace, newest files and entries first. */
export function getRequestTraceEvent(traceId: string): Record<string, unknown> | null {
  const env = getConsoleEnv();
  if (!existsSync(env.logDir)) return null;
  try {
    const files = readdirSync(env.logDir)
      .filter((file) => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort()
      .reverse();
    for (const file of files) {
      const rows = readFileSync(join(env.logDir, file), "utf8").split("\n");
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (!row?.trim()) continue;
        try {
          const value: unknown = JSON.parse(row);
          if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).traceId === traceId) {
            return value as Record<string, unknown>;
          }
        } catch {
          // A malformed log row must not hide a valid trace in the same file.
        }
      }
    }
  } catch {
    // Runtime logs are best-effort; the in-memory detail remains available.
  }
  return null;
}

export type UsagePeriod = "1h" | "24h" | "7d" | "30d";

export function periodStartUtc(period: UsagePeriod): string {
  const ms = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[period];
  return new Date(Date.now() - ms).toISOString().replace("T", " ").replace("Z", "");
}

function afterPeriod(record: UsageInsert, period: UsagePeriod): boolean {
  return record.startedAt >= periodStartUtc(period);
}

function numberOrZero(value: number | null): number {
  return value ?? 0;
}

export interface UsageSummary {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errors: number;
  avgDurationMs: number;
}

export function queryUsageSummary(period: UsagePeriod): UsageSummary {
  hydrateHistory();
  const items = records.filter((record) => afterPeriod(record, period));
  const duration = items.reduce((total, record) => total + record.durationMs, 0);
  return {
    requests: items.length,
    inputTokens: items.reduce((total, record) => total + numberOrZero(record.inputTokens), 0),
    cachedTokens: items.reduce((total, record) => total + numberOrZero(record.cachedTokens), 0),
    outputTokens: items.reduce((total, record) => total + numberOrZero(record.outputTokens), 0),
    errors: items.filter((record) => record.status >= 400).length,
    avgDurationMs: items.length ? Math.round(duration / items.length) : 0,
  };
}

export type ChartMetric = "requests" | "tokens" | "cached";

export interface ChartBucket {
  t: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
}

function bucketOf(timestamp: string, period: UsagePeriod): string {
  if (period === "1h") return timestamp.slice(0, 16);
  if (period === "24h") return `${timestamp.slice(0, 13)}:00`;
  if (period === "30d") return timestamp.slice(0, 10);
  const hour = Number(timestamp.slice(11, 13));
  return `${timestamp.slice(0, 11)}${String(Math.floor(hour / 3) * 3).padStart(2, "0")}:00`;
}

export function queryUsageChart(period: UsagePeriod): ChartBucket[] {
  hydrateHistory();
  const buckets = new Map<string, ChartBucket>();
  for (const record of records) {
    if (!afterPeriod(record, period)) continue;
    const key = bucketOf(record.startedAt, period);
    const bucket = buckets.get(key) ?? { t: key, requests: 0, input: 0, cached: 0, output: 0 };
    bucket.requests += 1;
    bucket.input += numberOrZero(record.inputTokens);
    bucket.cached += numberOrZero(record.cachedTokens);
    bucket.output += numberOrZero(record.outputTokens);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
}

export type UsageDimension = "model" | "provider" | "key";

export interface UsageByRow {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  total: number;
}

export function queryUsageBy(dimension: UsageDimension, period: UsagePeriod): UsageByRow[] {
  hydrateHistory();
  const map = new Map<string, UsageByRow>();
  for (const record of records) {
    if (!afterPeriod(record, period)) continue;
    const name = dimension === "model" ? record.model ?? "unknown" : dimension === "provider" ? record.provider ?? "unknown" : record.apiKeyPrefix ?? "anonymous";
    const row = map.get(name) ?? { name, requests: 0, input: 0, output: 0, cached: 0, total: 0 };
    row.requests += 1;
    row.input += numberOrZero(record.inputTokens);
    row.output += numberOrZero(record.outputTokens);
    row.cached += numberOrZero(record.cachedTokens);
    row.total += numberOrZero(record.totalTokens);
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, 20);
}

export interface UsageRequestFilters {
  cursor?: number;
  limit: number;
  provider?: string;
  model?: string;
  key?: string;
  status?: number;
  stream?: boolean;
  q?: string;
}

export interface UsageRequestRow {
  id: number;
  trace_id: string;
  endpoint: string;
  surface: string;
  api_key_prefix: string | null;
  api_key_id: string | null;
  provider: string | null;
  model: string | null;
  status: number | null;
  error_kind: string | null;
  stream: number;
  started_at: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  total_tokens: number | null;
  usage_source: string;
}

function toUsageRequestRow(record: UsageInsert & { id: number }): UsageRequestRow {
  return {
    id: record.id,
    trace_id: record.traceId,
    endpoint: record.endpoint,
    surface: record.surface,
    api_key_prefix: record.apiKeyPrefix,
    api_key_id: record.apiKeyId,
    provider: record.provider,
    model: record.model,
    status: record.status,
    error_kind: record.errorKind,
    stream: record.stream ? 1 : 0,
    started_at: record.startedAt,
    duration_ms: record.durationMs,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    cached_tokens: record.cachedTokens,
    total_tokens: record.totalTokens,
    usage_source: record.usageSource,
  };
}

export function queryUsageRequests(filters: UsageRequestFilters): { items: UsageRequestRow[]; nextCursor: number | null } {
  hydrateHistory();
  const items = records
    .filter((record) => filters.cursor === undefined || record.id < filters.cursor)
    .filter((record) => !filters.provider || record.provider === filters.provider)
    .filter((record) => !filters.model || record.model === filters.model)
    .filter((record) => !filters.key || record.apiKeyPrefix === filters.key)
    .filter((record) => filters.status === undefined || record.status === filters.status)
    .filter((record) => filters.stream === undefined || record.stream === filters.stream)
    .filter((record) => !filters.q || record.traceId.includes(filters.q))
    .sort((a, b) => b.id - a.id);
  const page = items.slice(0, filters.limit + 1);
  const hasMore = page.length > filters.limit;
  const visible = hasMore ? page.slice(0, filters.limit) : page;
  return { items: visible.map(toUsageRequestRow), nextCursor: hasMore ? visible.at(-1)!.id : null };
}

export function getUsageRequestById(id: number): Record<string, unknown> | null {
  hydrateHistory();
  const record = records.find((item) => item.id === id);
  return record ? { ...toUsageRequestRow(record), finished_at: record.finishedAt, api_key_id: record.apiKeyId, usage_source: record.usageSource, meta_json: JSON.stringify(record.meta) } : null;
}

export interface ProviderTodayRow {
  provider: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
}

export function queryProviderToday(): ProviderTodayRow[] {
  hydrateHistory();
  const today = new Date().toISOString().slice(0, 10);
  const rows = new Map<string, ProviderTodayRow>();
  for (const record of records) {
    if (!record.provider || utcDateOf(record.startedAt) !== today) continue;
    const row = rows.get(record.provider) ?? { provider: record.provider, requests: 0, input: 0, cached: 0, output: 0, errors: 0 };
    row.requests += 1;
    row.input += numberOrZero(record.inputTokens);
    row.cached += numberOrZero(record.cachedTokens);
    row.output += numberOrZero(record.outputTokens);
    row.errors += record.status >= 400 ? 1 : 0;
    rows.set(record.provider, row);
  }
  return [...rows.values()];
}

export function queryLastProviderError(provider: string): string | null {
  hydrateHistory();
  const record = [...records].reverse().find((item) => item.provider === provider && item.status >= 400);
  return record?.errorKind ?? null;
}

/** Test seam for isolating process-local runtime logs between cases. */
export function clearRuntimeUsageForTests(): void {
  records.length = 0;
  nextId = 1;
  hydratedDataDir = null;
}

export function sumDailyTokensForKey(apiKeyId: string): number {
  hydrateHistory();
  const today = new Date().toISOString().slice(0, 10);
  return records
    .filter((record) => record.apiKeyId === apiKeyId && utcDateOf(record.startedAt) === today)
    .reduce((total, record) => total + numberOrZero(record.inputTokens) + numberOrZero(record.outputTokens), 0);
}

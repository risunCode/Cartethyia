import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-request telemetry lives in hourly JSONL files, not in Postgres. The
 * database keeps only the durable aggregate. Every reader that used to query
 * `telemetry_events` reads through here, so the file is the single source for
 * recent requests and the table is no longer written.
 */
export const TELEMETRY_EVENT_DIR = "./data/telemetry-events";

export interface TelemetryEventRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly tenantId?: string;
  readonly requestId: string;
  readonly sourceSurface: string | null;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly providerId: string | null;
  readonly accountId: string | null;
  readonly networkPoolId: string | null;
  readonly endpoint: string | null;
  readonly apiKeyId: string | null;
  readonly userAgent: string | null;
  readonly clientIp: string | null;
  readonly latencyMs: number | null;
  readonly ttfbMs: number | null;
  readonly stream: boolean | null;
  readonly status: string | null;
  readonly httpStatus: number | null;
  readonly errorOrigin: string | null;
  readonly errorCategory: string | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly creditUsed: number | null;
  readonly resolveMs: number | null;
  readonly tokensPerSec: number | null;
  readonly firstContentDeltaAtMs: number | null;
  readonly lastEventAtMs: number | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalize(raw: Record<string, unknown>): TelemetryEventRecord | undefined {
  const tenantId = asString(raw["tenantId"]);
  const requestId = asString(raw["requestId"]);
  const createdAt = asString(raw["createdAt"]) ?? new Date().toISOString();
  if (!tenantId || !requestId) return undefined;
  return {
    id: asString(raw["id"]) ?? requestId,
    createdAt,
    tenantId,
    requestId,
    sourceSurface: asString(raw["sourceSurface"]),
    requestedModel: asString(raw["requestedModel"]),
    requestedEffort: asString(raw["requestedEffort"]),
    providerId: asString(raw["providerId"]),
    accountId: asString(raw["accountId"]),
    networkPoolId: asString(raw["networkPoolId"]),
    endpoint: asString(raw["endpoint"]),
    apiKeyId: asString(raw["apiKeyId"]),
    userAgent: asString(raw["userAgent"]),
    clientIp: asString(raw["clientIp"]),
    latencyMs: asNumber(raw["latencyMs"]),
    ttfbMs: asNumber(raw["ttfbMs"]),
    stream: typeof raw["stream"] === "boolean" ? raw["stream"] : null,
    status: asString(raw["status"]),
    httpStatus: asNumber(raw["httpStatus"]),
    errorOrigin: asString(raw["errorOrigin"]),
    errorCategory: asString(raw["errorCategory"]),
    inputTokens: asNumber(raw["inputTokens"]),
    cachedInputTokens: asNumber(raw["cachedInputTokens"]),
    outputTokens: asNumber(raw["outputTokens"]),
    reasoningTokens: asNumber(raw["reasoningTokens"]),
    estimatedCostUsd: asNumber(raw["estimatedCostUsd"]),
    creditUsed: asNumber(raw["creditUsed"]),
    resolveMs: asNumber(raw["resolveMs"]),
    tokensPerSec: asNumber(raw["tokensPerSec"]),
    firstContentDeltaAtMs: asNumber(raw["firstContentDeltaAtMs"]),
    lastEventAtMs: asNumber(raw["lastEventAtMs"]),
  };
}

/** Reads every retained event, newest first. A missing directory is an empty log. */
export async function readTelemetryEvents(): Promise<TelemetryEventRecord[]> {
  const files = await readdir(TELEMETRY_EVENT_DIR).catch(() => [] as string[]);
  const events: TelemetryEventRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await readFile(join(TELEMETRY_EVENT_DIR, file), "utf8").catch(() => "");
    for (const line of text.split(String.fromCharCode(10))) {
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const event = normalize(raw);
        if (event) events.push(event);
      } catch {
        // A torn tail from a crash is skipped, not fatal. The next line stands alone.
      }
    }
  }
  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return events;
}

export interface EventQuery {
  readonly tenantId?: string;
  readonly since?: Date;
  readonly apiKeyIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly requestId?: string;
  readonly httpStatus?: number;
}

/** The events matching a query, already newest first. */
export async function queryTelemetryEvents(query: EventQuery): Promise<TelemetryEventRecord[]> {
  const since = query.since?.getTime();
  const keys = query.apiKeyIds ? new Set(query.apiKeyIds) : undefined;
  const accounts = query.accountIds ? new Set(query.accountIds) : undefined;
  const events = await readTelemetryEvents();
  return events.filter((event) => {
    if (query.tenantId !== undefined && event.tenantId !== query.tenantId) return false;
    if (since !== undefined && new Date(event.createdAt).getTime() < since) return false;
    if (keys && (event.apiKeyId === null || !keys.has(event.apiKeyId))) return false;
    if (accounts && (event.accountId === null || !accounts.has(event.accountId))) return false;
    if (query.requestId !== undefined && event.requestId !== query.requestId) return false;
    if (query.httpStatus !== undefined && event.httpStatus !== query.httpStatus) return false;
    return true;
  });
}

export interface EventTotals {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  truncated: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  estimatedCost: number;
  unpriced: number;
  latencySum: number;
  latencyCount: number;
  tokensPerSecSum: number;
  tokensPerSecCount: number;
}

export function emptyTotals(): EventTotals {
  return { requests: 0, succeeded: 0, failed: 0, cancelled: 0, truncated: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimatedCost: 0, unpriced: 0, latencySum: 0, latencyCount: 0, tokensPerSecSum: 0, tokensPerSecCount: 0 };
}

/** Folds one event into a totals bucket. `failed` counts any non-completed terminal status. */
export function accumulate(totals: EventTotals, event: TelemetryEventRecord): void {
  totals.requests += 1;
  if (event.status === "completed") totals.succeeded += 1;
  else if (event.status === "cancelled") totals.cancelled += 1;
  else if (event.status === "truncated") totals.truncated += 1;
  else if (event.status !== null) totals.failed += 1;
  totals.inputTokens += event.inputTokens ?? 0;
  totals.cachedTokens += event.cachedInputTokens ?? 0;
  totals.outputTokens += event.outputTokens ?? 0;
  if (event.estimatedCostUsd !== null) totals.estimatedCost += event.estimatedCostUsd;
  else if (event.status === "completed") totals.unpriced += 1;
  if (event.latencyMs !== null) { totals.latencySum += event.latencyMs; totals.latencyCount += 1; }
  if (event.tokensPerSec !== null) { totals.tokensPerSecSum += event.tokensPerSec; totals.tokensPerSecCount += 1; }
}

/** Groups events by a key the caller derives, largest group first. */
export function groupEvents(
  events: readonly TelemetryEventRecord[],
  keyOf: (event: TelemetryEventRecord) => string | null,
): Array<{ key: string; totals: EventTotals }> {
  const groups = new Map<string, EventTotals>();
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    const totals = groups.get(key) ?? emptyTotals();
    accumulate(totals, event);
    groups.set(key, totals);
  }
  return [...groups].map(([key, totals]) => ({ key, totals })).sort((a, b) => b.totals.requests - a.totals.requests);
}

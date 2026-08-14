import type { ApiKeyPublic, ApiKeyRepository } from "../storage";
import { runtimeMemoryLimits } from "./limits";

export interface AdmissionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AdmissionLease {
  commit(usage: AdmissionUsage | null): void;
  release(): void;
}

export interface ApiKeyAdmissionErrorShape {
  readonly statusCode: 429;
  readonly kind: "quota_exceeded" | "concurrency_exceeded";
  readonly retryable: false;
  readonly routeScope: null;
  readonly sanitizedMessage: string;
  readonly retryAt: null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MONTH_MS = 31 * DAY_MS;

/** Effective max tracked keys: env override, or adaptive from RSS. */
function resolveMaxTrackedKeys(): number {
  if (runtimeMemoryLimits.maxTrackedKeys > 0) return runtimeMemoryLimits.maxTrackedKeys;
  const rssBytes = process.memoryUsage?.().rss ?? 256 * 1024 * 1024;
  return Math.min(Math.max(Math.floor(rssBytes / 1_024), 5_000), 500_000);
}

interface UsageWindow {
  readonly day: string;
  readonly month: string;
  dayUsed: number;
  monthUsed: number;
}

function nowDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nowMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function boundedLimit(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function admissionError(kind: ApiKeyAdmissionErrorShape["kind"], message: string): ApiKeyAdmissionErrorShape {
  return { statusCode: 429, kind, retryable: false, routeScope: null, sanitizedMessage: message, retryAt: null };
}

/**
 * Process-local admission guard. Reservations happen before upstream work and
 * are committed only after the provider reports usage; every lease is
 * idempotent so disconnects cannot leak concurrency or token budget.
 */
export class ApiKeyAdmission {
  private readonly rpmBuckets = new Map<string, { readonly startedAt: number; count: number }>();
  private readonly inFlight = new Map<string, number>();
  private readonly reservedTokens = new Map<string, number>();
  private readonly usage = new Map<string, UsageWindow>();

  public constructor(private readonly apiKeys: ApiKeyRepository) {}

  public acquire(key: ApiKeyPublic, estimatedTokens: number, now = Date.now()): AdmissionLease {
    this.evict(now);
    const estimate = Math.max(1, Math.min(10_000_000, Math.floor(estimatedTokens)));
    const rpm = boundedLimit(key.rateLimitRpm);
    const bucket = this.rpmBuckets.get(key.id);
    if (rpm !== null && bucket !== undefined && bucket.startedAt > now - 60_000 && bucket.count >= rpm) {
      throw admissionError("quota_exceeded", "API key requests-per-minute limit exceeded");
    }
    const currentConcurrency = this.inFlight.get(key.id) ?? 0;
    const maxConcurrency = boundedLimit(key.maxConcurrentRequests);
    if (maxConcurrency !== null && currentConcurrency >= maxConcurrency) {
      throw admissionError("concurrency_exceeded", "API key concurrent request limit exceeded");
    }

    const window = this.windowFor(key.id, now);
    const reserved = this.reservedTokens.get(key.id) ?? 0;
    const oneTimeLimit = boundedLimit(key.oneTimeTokenLimit);
    if (oneTimeLimit !== null && key.oneTimeTokensUsed + reserved + estimate > oneTimeLimit) {
      throw admissionError("quota_exceeded", "API key one-time token limit exceeded");
    }
    const dailyLimit = boundedLimit(key.dailyTokenLimit);
    if (dailyLimit !== null && window.dayUsed + estimate > dailyLimit) {
      throw admissionError("quota_exceeded", "API key daily token limit exceeded");
    }
    const monthlyLimit = boundedLimit(key.monthlyTokenLimit);
    if (monthlyLimit !== null && window.monthUsed + estimate > monthlyLimit) {
      throw admissionError("quota_exceeded", "API key monthly token limit exceeded");
    }

    if (bucket === undefined || bucket.startedAt <= now - 60_000) this.rpmBuckets.set(key.id, { startedAt: now, count: 1 });
    else bucket.count += 1;
    this.inFlight.set(key.id, currentConcurrency + 1);
    this.reservedTokens.set(key.id, reserved + estimate);
    window.dayUsed += estimate;
    window.monthUsed += estimate;

    let settled = false;
    const finish = (actual: AdmissionUsage | null): void => {
      if (settled) return;
      settled = true;
      const active = this.inFlight.get(key.id) ?? 1;
      if (active <= 1) this.inFlight.delete(key.id);
      else this.inFlight.set(key.id, active - 1);
      const currentReserved = this.reservedTokens.get(key.id) ?? estimate;
      if (currentReserved <= estimate) this.reservedTokens.delete(key.id);
      else this.reservedTokens.set(key.id, currentReserved - estimate);
      const actualTokens = actual === null ? null : Math.max(0, Math.floor(actual.inputTokens) + Math.floor(actual.outputTokens));
      if (actualTokens === null) {
        window.dayUsed = Math.max(0, window.dayUsed - estimate);
        window.monthUsed = Math.max(0, window.monthUsed - estimate);
        return;
      }
      const delta = actualTokens - estimate;
      window.dayUsed = Math.max(0, window.dayUsed + delta);
      window.monthUsed = Math.max(0, window.monthUsed + delta);
      if (actualTokens > 0 && boundedLimit(key.oneTimeTokenLimit) !== null) this.apiKeys.consumeOneTimeTokens(key.id, actualTokens);
    };
    return {
      commit: (actual) => finish(actual),
      release: () => finish(null),
    };
  }

  private windowFor(keyId: string, now: number): UsageWindow {
    const day = nowDay(now);
    const month = nowMonth(now);
    const previous = this.usage.get(keyId);
    if (previous !== undefined && previous.day === day && previous.month === month) return previous;
    const next = { day, month, dayUsed: 0, monthUsed: previous?.month === month ? previous.monthUsed : 0 };
    this.usage.set(keyId, next);
    return next;
  }

  private evict(now: number): void {
    const cap = resolveMaxTrackedKeys();
    if (this.rpmBuckets.size <= cap && this.usage.size <= cap) return;
    const staleBefore = now - MONTH_MS;
    for (const [keyId, bucket] of this.rpmBuckets) if (bucket.startedAt < staleBefore && (this.inFlight.get(keyId) ?? 0) === 0) this.rpmBuckets.delete(keyId);
    for (const [keyId, window] of this.usage) {
      const monthTime = Date.parse(`${window.month}-01T00:00:00.000Z`);
      if (Number.isFinite(monthTime) && monthTime < staleBefore && (this.inFlight.get(keyId) ?? 0) === 0) this.usage.delete(keyId);
    }
  }
}

export function estimateRequestTokens(body: Record<string, unknown>): number {
  try {
    return Math.max(1, Math.min(10_000_000, Math.ceil(approximateByteLength(body) / 4)));
  } catch {
    return 1;
  }
}

/**
 * Lightweight byte-length approximation without a full `JSON.stringify`.
 * Walks the object's own enumerable properties, summing string lengths and
 * fixed-size estimates for numbers/booleans. Avoids the allocation cost of
 * serializing the entire body on every request.
 */
function approximateByteLength(value: unknown, depth = 0): number {
  if (depth > 32) return 0;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value === null || value === undefined) return 4;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) total += approximateByteLength(item, depth + 1) + 1;
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    for (const [k, v] of Object.entries(value)) total += k.length + 4 + approximateByteLength(v, depth + 1) + 1;
    return total;
  }
  return 0;
}

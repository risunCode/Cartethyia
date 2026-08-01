/**
 * API key repo — keys are stored as plaintext; the full key is
 * returned exactly once at creation time.
 */

import { getDb } from "../client";
import { purgeRateLimitState } from "../../proxy-auth";
import { parseJsonArray, serializeJsonArray } from "../json-helpers";
import { TtlCache } from "../ttl-cache";

export interface ApiKeyRow {
  id: string;
  name: string;
  key: string;
  key_prefix: string;
  active: number;
  rate_limit_rpm: number | null;
  daily_token_limit: number | null;
  monthly_token_limit: number | null;
  max_concurrent_requests: number | null;
  provider_allowlist: string | null;
  model_allowlist: string | null;
  model_denylist: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ApiKeyPublic {
  id: string;
  name: string;
  keyPrefix: string;
  active: boolean;
  rateLimitRpm: number | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  maxConcurrentRequests: number | null;
  providerAllowlist: string[] | null;
  modelAllowlist: string[] | null;
  modelDenylist: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeyCreateInput {
  name: string;
  /** Custom secret prefix (e.g. "sk-carte") in place of the default "ctk". Sanitized by `sanitizeKeyPrefix` before use. */
  prefix?: string;
  rateLimitRpm?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  maxConcurrentRequests?: number;
  providerAllowlist?: string[];
  modelAllowlist?: string[];
  modelDenylist?: string[];
}

export interface ApiKeyUpdateInput {
  rateLimitRpm?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  maxConcurrentRequests?: number | null;
  providerAllowlist?: string[] | null;
  modelAllowlist?: string[] | null;
  modelDenylist?: string[] | null;
}

function toPublic(row: ApiKeyRow): ApiKeyPublic {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    active: row.active === 1 && !row.revoked_at,
    rateLimitRpm: row.rate_limit_rpm,
    dailyTokenLimit: row.daily_token_limit,
    monthlyTokenLimit: row.monthly_token_limit,
    maxConcurrentRequests: row.max_concurrent_requests,
    providerAllowlist: parseJsonArray(row.provider_allowlist),
    modelAllowlist: parseJsonArray(row.model_allowlist),
    modelDenylist: parseJsonArray(row.model_denylist),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function serializeList(value: string[] | null | undefined): string | null {
  return serializeJsonArray(value);
}

const DEFAULT_KEY_PREFIX = "ctk";

/**
 * Keeps a custom prefix safe to embed in an `Authorization: Bearer <key>`
 * header: only token68-safe characters, capped to a sane length so one
 * request can't blow up the secret. Anything left empty after stripping
 * falls back to the default - no rejection, no validation error surfaced
 * to the caller, per product decision (any non-empty result is accepted).
 */
function sanitizeKeyPrefix(raw: string | undefined): string {
  if (!raw) return DEFAULT_KEY_PREFIX;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return cleaned || DEFAULT_KEY_PREFIX;
}

/** Returns the full key exactly once; caller must show it immediately. */
export function createApiKey(input: ApiKeyCreateInput): { key: string; record: ApiKeyPublic } | { error: "duplicate" } {
  const db = getDb();
  const raw = crypto.getRandomValues(new Uint8Array(24));
  let suffix = "";
  for (const byte of raw) suffix += byte.toString(16).padStart(2, "0");
  const key = `${sanitizeKeyPrefix(input.prefix)}_${suffix}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.query(
      `INSERT INTO api_keys (
        id, name, key, key_prefix, active, rate_limit_rpm, daily_token_limit, monthly_token_limit,
        max_concurrent_requests, provider_allowlist, model_allowlist, model_denylist, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      key,
      key.slice(0, 12),
      input.rateLimitRpm ?? null,
      input.dailyTokenLimit ?? null,
      input.monthlyTokenLimit ?? null,
      input.maxConcurrentRequests ?? null,
      serializeList(input.providerAllowlist),
      serializeList(input.modelAllowlist),
      serializeList(input.modelDenylist),
      now
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed: api_keys.name")) return { error: "duplicate" };
    throw error;
  }
  const row = db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow;
  secretCache.clear();
  return { key, record: toPublic(row) };
}

export function updateApiKey(id: string, patch: ApiKeyUpdateInput): ApiKeyPublic | null {
  const db = getDb();
  const existing = db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
  if (!existing) return null;

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  const setNullableInt = (column: string, value: number | null | undefined) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(value);
  };
  const setNullableList = (column: string, value: string[] | null | undefined) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(serializeList(value));
  };

  setNullableInt("rate_limit_rpm", patch.rateLimitRpm);
  setNullableInt("daily_token_limit", patch.dailyTokenLimit);
  setNullableInt("monthly_token_limit", patch.monthlyTokenLimit);
  setNullableInt("max_concurrent_requests", patch.maxConcurrentRequests);
  setNullableList("provider_allowlist", patch.providerAllowlist);
  setNullableList("model_allowlist", patch.modelAllowlist);
  setNullableList("model_denylist", patch.modelDenylist);

  if (fields.length === 0) return toPublic(existing);

  values.push(id);
  db.query(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  secretCache.clear();
  const row = db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow;
  return toPublic(row);
}

export function listApiKeys(): ApiKeyPublic[] {
  const rows = getDb().query("SELECT * FROM api_keys ORDER BY created_at DESC").all() as ApiKeyRow[];
  return rows.map(toPublic);
}

export function revokeApiKey(id: string): boolean {
  secretCache.clear();
  const result = getDb()
    .query("UPDATE api_keys SET active = 0, revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function deleteApiKey(id: string): boolean {
  secretCache.clear();
  const result = getDb().query("DELETE FROM api_keys WHERE id = ?").run(id);
  if (result.changes > 0) purgeRateLimitState(id);
  return result.changes > 0;
}

export function getApiKeyById(id: string): { key: string } | undefined {
  const row = getDb().query("SELECT key FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
  return row ? { key: row.key } : undefined;
}

// Every proxied request calls findApiKeyBySecret to authenticate its Bearer
// token - a 5s TTL cache (matches getRuntimeSettings' pattern) turns that
// into a SQLite read only once every 5s per distinct key instead of once per
// request. secretCache.clear() below runs on every mutation so revoking or
// editing a key takes effect immediately rather than waiting out the TTL.
const secretCache = new TtlCache<string, ApiKeyPublic | null>(5_000);

export function findApiKeyBySecret(key: string): ApiKeyPublic | null {
  return secretCache.get(key, () => {
    const row = getDb().query("SELECT * FROM api_keys WHERE key = ?").get(key) as ApiKeyRow | null;
    return row ? toPublic(row) : null;
  });
}

// last_used_at is a low-precision "last used X ago" display field, not an
// audit trail - coalescing writes in memory and flushing them in one batched
// transaction avoids one UPDATE (with its own commit/fsync) per proxied
// request, which was the single largest per-request DB cost on the hot path.
const pendingTouches = new Map<string, string>();
let touchFlushTimer: Timer | null = null;
const TOUCH_FLUSH_MS = 10_000;

export function touchApiKey(id: string): void {
  pendingTouches.set(id, new Date().toISOString());
  if (!touchFlushTimer) {
    touchFlushTimer = setTimeout(flushApiKeyTouches, TOUCH_FLUSH_MS);
    touchFlushTimer.unref?.();
  }
}

/** Flushes coalesced last_used_at writes in one transaction. Called periodically and on graceful shutdown. */
export function flushApiKeyTouches(): void {
  if (touchFlushTimer) {
    clearTimeout(touchFlushTimer);
    touchFlushTimer = null;
  }
  if (pendingTouches.size === 0) return;
  const entries = [...pendingTouches.entries()];
  pendingTouches.clear();
  const db = getDb();
  const applyBatch = db.transaction((rows: [string, string][]) => {
    for (const [id, ts] of rows) db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(ts, id);
  });
  applyBatch(entries);
}

/** Test-only: drop cached/pending state so isolated test databases don't leak into each other. */
export function resetApiKeyCachesForTests(): void {
  secretCache.clear();
  pendingTouches.clear();
  if (touchFlushTimer) {
    clearTimeout(touchFlushTimer);
    touchFlushTimer = null;
  }
}

/**
 * API key repo — keys are stored as SHA-256 hashes only; the full key is
 * returned exactly once at creation time.
 */

import { getDb } from "../client";

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  active: number;
  rate_limit_rpm: number | null;
  daily_token_limit: number | null;
  provider_allowlist: string | null;
  model_allowlist: string | null;
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
  providerAllowlist: string[] | null;
  modelAllowlist: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiKeyCreateInput {
  name: string;
  rateLimitRpm?: number;
  dailyTokenLimit?: number;
  providerAllowlist?: string[];
  modelAllowlist?: string[];
}

function hashKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}

export function hashApiKey(key: string): string {
  return hashKey(key);
}

function toPublic(row: ApiKeyRow): ApiKeyPublic {
  const parseList = (raw: string | null): string[] | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    active: row.active === 1 && !row.revoked_at,
    rateLimitRpm: row.rate_limit_rpm,
    dailyTokenLimit: row.daily_token_limit,
    providerAllowlist: parseList(row.provider_allowlist),
    modelAllowlist: parseList(row.model_allowlist),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** Returns the full key exactly once; caller must show it immediately. */
export function createApiKey(input: ApiKeyCreateInput): { key: string; record: ApiKeyPublic } | { error: "duplicate" } {
  const db = getDb();
  const existing = db.query("SELECT id FROM api_keys WHERE name = ?").get(input.name);
  if (existing) return { error: "duplicate" };
  const raw = crypto.getRandomValues(new Uint8Array(24));
  let suffix = "";
  for (const byte of raw) suffix += byte.toString(16).padStart(2, "0");
  const key = `ctk_${suffix}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, active, rate_limit_rpm, daily_token_limit, provider_allowlist, model_allowlist, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    hashKey(key),
    key.slice(0, 12),
    input.rateLimitRpm ?? null,
    input.dailyTokenLimit ?? null,
    input.providerAllowlist ? JSON.stringify(input.providerAllowlist) : null,
    input.modelAllowlist ? JSON.stringify(input.modelAllowlist) : null,
    now
  );
  const row = db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow;
  return { key, record: toPublic(row) };
}

export function listApiKeys(): ApiKeyPublic[] {
  const rows = getDb().query("SELECT * FROM api_keys ORDER BY created_at DESC").all() as ApiKeyRow[];
  return rows.map(toPublic);
}

export function revokeApiKey(id: string): boolean {
  const result = getDb()
    .query("UPDATE api_keys SET active = 0, revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function deleteApiKey(id: string): boolean {
  const result = getDb().query("DELETE FROM api_keys WHERE id = ?").run(id);
  return result.changes > 0;
}

export function findApiKeyBySecret(key: string): ApiKeyPublic | null {
  const row = getDb().query("SELECT * FROM api_keys WHERE key_hash = ?").get(hashKey(key)) as ApiKeyRow | null;
  return row ? toPublic(row) : null;
}

export function touchApiKey(id: string): void {
  getDb().query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

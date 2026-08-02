/**
 * Provider accounts — CRUD. Credentials are stored as plaintext in
 * `credential`; only the console login password is hashed. `credential_hint`
 * keeps the masked tail for display so the UI never has to echo the full key.
 */

import { getDb } from "../client";

/** Masked display hint: last 4 chars only. */
function credentialHint(value: string): string {
  return `…${value.slice(-4)}`;
}
import type { ResolvedCredential } from "../../../upstream/providers";
import type { AccountQuota, AccountQuotaWindowKind } from "../../quota";
import { createRotationStore, pickRotationIndex } from "../../../upstream/rotation";

export type CredentialKind = "bearer" | "pat" | "session-token" | "oauth";

export type AccountHealthStatus = "healthy" | "refreshing" | "error" | "disabled" | "reauthentication-required";

export interface AccountHealth {
  status: AccountHealthStatus;
  errorKind: string | null;
  statusCode: number | null;
  sanitizedMessage: string | null;
  occurredAt: string | null;
  retryAt: string | null;
  lastRefreshAt: string | null;
  updatedAt: string;
}

/** Account credential_kind (DB) → ResolvedCredential kind (upstream dispatch). */
export const RESOLVED_KIND_BY_ACCOUNT_KIND: Record<CredentialKind, ResolvedCredential["kind"]> = {
  bearer: "provider-bearer",
  pat: "qoder-pat",
  "session-token": "devin-session",
  oauth: "oauth",
};

export interface ProviderAccountRow {
  id: string;
  provider: string;
  name: string;
  credential_kind: string; // stored lowercase
  credential: string;
  credential_hint: string;
  priority: number;
  active: number;
  created_at: string;
  updated_at: string;
  health_status?: string | null;
  health_error_kind?: string | null;
  health_status_code?: number | null;
  health_sanitized_message?: string | null;
  health_occurred_at?: string | null;
  health_retry_at?: string | null;
  health_last_refresh_at?: string | null;
  health_quota_json?: string | null;
  health_quota_error?: string | null;
  health_quota_fetched_at?: string | null;
  health_updated_at?: string | null;
}

export interface ProviderAccount {
  id: string;
  provider: string;
  name: string;
  credentialKind: CredentialKind;
  credentialHint: string;
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  health: AccountHealth | null;
  quota: AccountQuota | null;
}

function isQuotaWindowKind(value: unknown): value is AccountQuotaWindowKind {
  return value === "session" || value === "daily" || value === "weekly" || value === "monthly" || value === "other";
}

function quotaFromRow(row: ProviderAccountRow): AccountQuota | null {
  if (!row.health_quota_json && !row.health_quota_fetched_at) return null;
  try {
    const parsed: unknown = row.health_quota_json ? JSON.parse(row.health_quota_json) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const rawWindows = Array.isArray(value.windows) ? value.windows : [];
    const windows = rawWindows.flatMap((window): AccountQuota["windows"] => {
      if (typeof window !== "object" || window === null || Array.isArray(window)) return [];
      const item = window as Record<string, unknown>;
      if (!isQuotaWindowKind(item.kind) || typeof item.label !== "string") return [];
      return [{
        kind: item.kind,
        label: item.label,
        usedPercent: typeof item.usedPercent === "number" ? item.usedPercent : null,
        remainingPercent: typeof item.remainingPercent === "number" ? item.remainingPercent : null,
        resetsAt: typeof item.resetsAt === "string" ? item.resetsAt : null,
      }];
    });
    return {
      plan: typeof value.plan === "string" ? value.plan : null,
      windows,
      fetchedAt: row.health_quota_fetched_at ?? (typeof value.fetchedAt === "string" ? value.fetchedAt : new Date(0).toISOString()),
      error: row.health_quota_error ?? (typeof value.error === "string" ? value.error : null),
    };
  } catch {
    return null;
  }
}

function fromRow(row: ProviderAccountRow): ProviderAccount {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    credentialKind: row.credential_kind as CredentialKind,
    credentialHint: row.credential_hint,
    priority: row.priority,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    health: row.health_status && row.health_updated_at ? {
      status: row.health_status as AccountHealthStatus,
      errorKind: row.health_error_kind ?? null,
      statusCode: row.health_status_code ?? null,
      sanitizedMessage: row.health_sanitized_message ?? null,
      occurredAt: row.health_occurred_at ?? null,
      retryAt: row.health_retry_at ?? null,
      lastRefreshAt: row.health_last_refresh_at ?? null,
      updatedAt: row.health_updated_at,
    } : null,
    quota: quotaFromRow(row),
  };
}

const ACCOUNT_ROWS_CACHE_TTL_MS = 1_000;
const MAX_ACCOUNT_ROWS_CACHE_ENTRIES = 256;
const accountRowsCache = new Map<string, { rows: ProviderAccountRow[]; expiresAt: number }>();

function clearAccountRowsCache(): void {
  accountRowsCache.clear();
}

export function listAccounts(provider?: string): ProviderAccount[] {
  return listAccountRows(provider).map(fromRow);
}

/**
 * Unredacted rows (credential included) for internal hot-path use, e.g.
 * `pickAccountForRotation` - which used to call `listAccounts` (redacted)
 * and then re-fetch every candidate individually via `getAccount` just to
 * get the credential back. One query instead of 1+N per request.
 */
function listAccountRows(provider?: string): ProviderAccountRow[] {
  const key = provider ?? "*";
  const now = Date.now();
  const cached = accountRowsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.rows;
  if (cached) accountRowsCache.delete(key);

  const db = getDb();
  const select = `SELECT pa.*, h.status AS health_status, h.error_kind AS health_error_kind,
    h.status_code AS health_status_code, h.sanitized_message AS health_sanitized_message,
    h.occurred_at AS health_occurred_at, h.retry_at AS health_retry_at,
    h.last_refresh_at AS health_last_refresh_at, h.quota_json AS health_quota_json,
    h.quota_error AS health_quota_error, h.quota_fetched_at AS health_quota_fetched_at,
    h.updated_at AS health_updated_at
    FROM provider_accounts pa LEFT JOIN provider_account_health h ON h.account_id = pa.id`;
  const rows = (
    provider === undefined
      ? db.query(`${select} ORDER BY pa.priority ASC, pa.name ASC`).all()
      : db.query(`${select} WHERE pa.provider = ? ORDER BY pa.priority ASC, pa.name ASC`).all(provider)
  ) as ProviderAccountRow[];
  accountRowsCache.set(key, { rows, expiresAt: now + ACCOUNT_ROWS_CACHE_TTL_MS });
  while (accountRowsCache.size > MAX_ACCOUNT_ROWS_CACHE_ENTRIES) {
    const oldest = accountRowsCache.keys().next();
    if (oldest.done) break;
    accountRowsCache.delete(oldest.value);
  }
  return rows;
}

interface AccountCursor { priority: number; name: string; id: string; }

function decodeAccountCursor(cursor: string | undefined): AccountCursor | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (parsed && typeof parsed === "object" && "priority" in parsed && "name" in parsed && "id" in parsed) {
      const value = parsed as Record<string, unknown>;
      if (typeof value.priority === "number" && typeof value.name === "string" && typeof value.id === "string") return { priority: value.priority, name: value.name, id: value.id };
    }
  } catch {
    // Invalid cursors behave as the first page.
  }
  return null;
}

function encodeAccountCursor(row: ProviderAccountRow): string {
  return btoa(JSON.stringify({ priority: row.priority, name: row.name, id: row.id }));
}

export interface AccountPage { items: ProviderAccount[]; nextCursor: string | null; version: string; }

/** Version token changes whenever a provider's account collection changes. */
export function accountsVersion(provider: string): string {
  const state = getDb().query("SELECT COUNT(*) AS count, COALESCE(MAX(pa.updated_at), '') AS updated_at, COALESCE(MAX(h.updated_at), '') AS health_updated_at FROM provider_accounts pa LEFT JOIN provider_account_health h ON h.account_id = pa.id WHERE pa.provider = ?").get(provider) as { count: number; updated_at: string; health_updated_at: string };
  return `${state.count}:${state.updated_at}:${state.health_updated_at}`;
}

/** Returns provider accounts using a stable, index-backed priority/name/id keyset. */
export function listAccountsPage(provider: string, limit: number, cursor?: string): AccountPage {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const after = decodeAccountCursor(cursor);
  const select = `SELECT pa.*, h.status AS health_status, h.error_kind AS health_error_kind,
    h.status_code AS health_status_code, h.sanitized_message AS health_sanitized_message,
    h.occurred_at AS health_occurred_at, h.retry_at AS health_retry_at,
    h.last_refresh_at AS health_last_refresh_at, h.quota_json AS health_quota_json,
    h.quota_error AS health_quota_error, h.quota_fetched_at AS health_quota_fetched_at,
    h.updated_at AS health_updated_at
    FROM provider_accounts pa LEFT JOIN provider_account_health h ON h.account_id = pa.id`;
  const rows = (after
    ? db.query(`${select} WHERE pa.provider = ? AND (pa.priority > ? OR (pa.priority = ? AND (pa.name > ? OR (pa.name = ? AND pa.id > ?)))) ORDER BY pa.priority ASC, pa.name ASC, pa.id ASC LIMIT ?`).all(provider, after.priority, after.priority, after.name, after.name, after.id, boundedLimit + 1)
    : db.query(`${select} WHERE pa.provider = ? ORDER BY pa.priority ASC, pa.name ASC, pa.id ASC LIMIT ?`).all(provider, boundedLimit + 1)
  ) as ProviderAccountRow[];
  const hasNext = rows.length > boundedLimit;
  const pageRows = hasNext ? rows.slice(0, boundedLimit) : rows;
  return { items: pageRows.map(fromRow), nextCursor: hasNext ? encodeAccountCursor(pageRows.at(-1)!) : null, version: accountsVersion(provider) };
}

export function getAccount(id: string): ProviderAccountRow | null {
  const row = getDb().query(`SELECT pa.*, h.status AS health_status, h.error_kind AS health_error_kind,
    h.status_code AS health_status_code, h.sanitized_message AS health_sanitized_message,
    h.occurred_at AS health_occurred_at, h.retry_at AS health_retry_at,
    h.last_refresh_at AS health_last_refresh_at, h.quota_json AS health_quota_json,
    h.quota_error AS health_quota_error, h.quota_fetched_at AS health_quota_fetched_at,
    h.updated_at AS health_updated_at
    FROM provider_accounts pa LEFT JOIN provider_account_health h ON h.account_id = pa.id WHERE pa.id = ?`).get(id) as ProviderAccountRow | null;
  return row;
}

/** Active credentials in routing order for server-side model discovery. */
export function listOAuthAccountRows(): ProviderAccountRow[] {
  return listAccountRows().filter((row) => row.credential_kind === "oauth");
}

export function listActiveAccountCredentials(provider: string): string[] {
  return (
    getDb()
      .query("SELECT credential FROM provider_accounts WHERE provider = ? AND active = 1 ORDER BY priority ASC, name ASC")
      .all(provider) as Array<Pick<ProviderAccountRow, "credential">>
  ).map((row) => row.credential);
}

interface NextAccountPriorityRow {
  priority: number;
}

/** Create a new account; returns only public fields (+ hint). */
export function createAccount(input: {
  provider: string;
  name: string;
  credentialKind: CredentialKind;
  credential: string;
  credentialHint?: string;
  priority?: number;
  active?: boolean;
}): { id: string; credentialHint: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const hint = input.credentialHint ?? credentialHint(input.credential);
  const id = crypto.randomUUID();
  const active = input.active ?? true;
  const nextPriority = db.query("SELECT COALESCE(MAX(priority), 90) + 10 AS priority FROM provider_accounts WHERE provider = ?").get(input.provider) as NextAccountPriorityRow;
  const priority = typeof input.priority === "number" && Number.isFinite(input.priority) ? input.priority : nextPriority.priority;

  db.query(
    "INSERT INTO provider_accounts (id, provider, name, credential_kind, credential, credential_hint, priority, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.provider, input.name, input.credentialKind.toLowerCase(), input.credential, hint, priority, active ? 1 : 0, now, now);
  clearAccountRowsCache();

  return { id, credentialHint: hint };
}

export function patchAccount(id: string, patch: {
  provider?: string;
  name?: string;
  credentialKind?: CredentialKind;
  credential?: string;
  priority?: number;
  active?: boolean;
}): void {
  const current = getAccount(id);
  if (!current) throw new Error("account not found");

  const updateFields: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.provider !== undefined) {
    updateFields.push("provider = ?");
    values.push(patch.provider);
  }
  if (patch.name !== undefined) {
    updateFields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.credentialKind !== undefined) {
    updateFields.push("credential_kind = ?");
    values.push(patch.credentialKind.toLowerCase());
  }
  if (patch.credential !== undefined) {
    updateFields.push("credential = ?");
    values.push(patch.credential);
    updateFields.push("credential_hint = ?");
    values.push(credentialHint(patch.credential));
  }
  if (patch.priority !== undefined) {
    updateFields.push("priority = ?");
    values.push(patch.priority);
  }
  if (patch.active !== undefined) {
    updateFields.push("active = ?");
    values.push(patch.active ? 1 : 0);
  }

  if (updateFields.length === 0) return;

  updateFields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  getDb().query(`UPDATE provider_accounts SET ${updateFields.join(", ")} WHERE id = ?`).run(...values);
  clearAccountRowsCache();
}

export function updateAccountHealth(accountId: string, health: {
  status: AccountHealthStatus;
  errorKind?: string | null;
  statusCode?: number | null;
  sanitizedMessage?: string | null;
  occurredAt?: string | null;
  retryAt?: string | null;
  lastRefreshAt?: string | null;
}): void {
  const now = new Date().toISOString();
  getDb().query(`INSERT INTO provider_account_health
    (account_id, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, last_refresh_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, error_kind = excluded.error_kind,
      status_code = excluded.status_code, sanitized_message = excluded.sanitized_message,
      occurred_at = excluded.occurred_at, retry_at = excluded.retry_at,
      last_refresh_at = excluded.last_refresh_at, updated_at = excluded.updated_at`).run(
    accountId,
    health.status,
    health.errorKind ?? null,
    health.statusCode ?? null,
    health.sanitizedMessage ?? null,
    health.occurredAt ?? null,
    health.retryAt ?? null,
    health.lastRefreshAt ?? null,
    now,
  );
  clearAccountRowsCache();
}

export function clearAccountHealth(accountId: string): void {
  getDb().query("DELETE FROM provider_account_health WHERE account_id = ?").run(accountId);
  clearAccountRowsCache();
}

export function updateAccountQuota(accountId: string, quota: AccountQuota): void {
  const database = getDb();
  if (!database.query("SELECT 1 FROM provider_accounts WHERE id = ?").get(accountId)) return;
  const now = new Date().toISOString();
  database.query(`INSERT INTO provider_account_health
    (account_id, status, quota_json, quota_error, quota_fetched_at, updated_at)
    VALUES (?, 'healthy', ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET quota_json = excluded.quota_json,
      quota_error = excluded.quota_error, quota_fetched_at = excluded.quota_fetched_at,
      updated_at = excluded.updated_at`).run(accountId, JSON.stringify(quota), quota.error, quota.fetchedAt, now);
  clearAccountRowsCache();
}

export function markAccountQuotaError(accountId: string, error: string, fetchedAt: string): void {
  const database = getDb();
  if (!database.query("SELECT 1 FROM provider_accounts WHERE id = ?").get(accountId)) return;
  const now = new Date().toISOString();
  database.query(`INSERT INTO provider_account_health
    (account_id, status, quota_error, quota_fetched_at, updated_at)
    VALUES (?, 'healthy', ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET quota_error = excluded.quota_error,
      quota_fetched_at = excluded.quota_fetched_at, updated_at = excluded.updated_at`).run(accountId, error.slice(0, 240), fetchedAt, now);
  clearAccountRowsCache();
}

export function deleteAccount(id: string): boolean {
  const current = getAccount(id);
  if (!current) return false;
  const result = getDb().query("DELETE FROM provider_accounts WHERE id = ?").run(id);
  if (result.changes > 0) {
    clearAccountRowsCache();
    purgeAccountRoutingState(id, current.provider);
  }
  return result.changes > 0;
}

const rotationState = createRotationStore<string>();

function purgeAccountRoutingState(accountId: string, provider: string): void {
  rotationState.delete(provider);
  cooldowns.delete(accountId);
  const modelPrefix = `${accountId}:`;
  for (const key of modelLocks.keys()) {
    if (key.startsWith(modelPrefix)) modelLocks.delete(key);
  }
}

// ── Account cooldown (C5) ────────────────────────────────────────────────

interface AccountCooldown {
  unavailableUntil: number;
  backoffLevel: number;
}

const cooldowns = new Map<string, AccountCooldown>();
let cooldownsHydrated = false;

const COOLDOWN_BASE_MS = 2_000;
const COOLDOWN_MAX_MS = 30 * 60_000;
const COOLDOWN_MAX_LEVEL = 15;
const RATE_LIMIT_COOLDOWN_LEVEL = -1;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
const QUOTA_EXHAUSTED_COOLDOWN_LEVEL = -2;
const QUOTA_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60_000;

/** Rebuilds the in-memory cooldown and model-lock indexes from persisted state. */
export function hydrateCooldownCache(): void {
  const db = getDb();
  const now = new Date().toISOString();
  cooldowns.clear();
  modelLocks.clear();

  const cooldownRows = db.query("SELECT id, cooldown_until, cooldown_level FROM provider_accounts WHERE cooldown_until > ?").all(now) as Array<{ id: string; cooldown_until: string; cooldown_level: number }>;
  for (const row of cooldownRows) cooldowns.set(row.id, { unavailableUntil: Date.parse(row.cooldown_until), backoffLevel: row.cooldown_level });

  const lockRows = db.query("SELECT account_id, model_id, locked_until FROM account_model_locks WHERE locked_until > ?").all(now) as Array<{ account_id: string; model_id: string; locked_until: string }>;
  for (const row of lockRows) modelLocks.set(`${row.account_id}:${row.model_id}`, Date.parse(row.locked_until));

  db.query("UPDATE provider_accounts SET cooldown_until = NULL, cooldown_level = 0 WHERE cooldown_until <= ?").run(now);
  db.query("DELETE FROM account_model_locks WHERE locked_until <= ?").run(now);
  cooldownsHydrated = true;
}

function ensureCooldownCache(): void {
  if (!cooldownsHydrated) hydrateCooldownCache();
}

/** Marks an account unavailable; quota exhaustion uses a full day, rate limits 30 minutes, and auth failures use bounded backoff. */
export function markAccountUnavailable(accountId: string, kind: "rate-limit" | "auth" | "quota-exhausted" = "rate-limit"): void {
  const existing = cooldowns.get(accountId);
  const backoffLevel = kind === "quota-exhausted"
    ? QUOTA_EXHAUSTED_COOLDOWN_LEVEL
    : kind === "rate-limit"
      ? RATE_LIMIT_COOLDOWN_LEVEL
      : Math.min((existing?.backoffLevel ?? -1) + 1, COOLDOWN_MAX_LEVEL);
  const unavailableUntil = Date.now() + (kind === "quota-exhausted"
    ? QUOTA_EXHAUSTED_COOLDOWN_MS
    : kind === "rate-limit"
      ? RATE_LIMIT_COOLDOWN_MS
      : Math.min(COOLDOWN_BASE_MS * Math.pow(2, backoffLevel), COOLDOWN_MAX_MS));
  cooldowns.set(accountId, { unavailableUntil, backoffLevel });
  getDb().query("UPDATE provider_accounts SET cooldown_until = ?, cooldown_level = ? WHERE id = ?").run(new Date(unavailableUntil).toISOString(), backoffLevel, accountId);
}

/** Clears an account cooldown after a verified successful test or request retry. */
export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId);
  getDb().query("UPDATE provider_accounts SET cooldown_until = NULL, cooldown_level = 0 WHERE id = ?").run(accountId);
}

/** Disables every account for a provider for one day after a quota-exhausted response. */
export function disableProviderForQuota(provider: string, statusCode: number, message: string): void {
  const accounts = listAccounts(provider);
  const retryAt = new Date(Date.now() + QUOTA_EXHAUSTED_COOLDOWN_MS).toISOString();
  for (const account of accounts) {
    markAccountUnavailable(account.id, "quota-exhausted");
    updateAccountHealth(account.id, {
      status: "disabled",
      errorKind: "quota_exhausted",
      statusCode,
      sanitizedMessage: message.slice(0, 500),
      occurredAt: new Date().toISOString(),
      retryAt,
    });
  }
}

/** Clears a cooldown and its persisted health snapshot after a successful manual test. */
export function markAccountHealthy(accountId: string): void {
  clearAccountCooldown(accountId);
  clearAccountHealth(accountId);
}

/** Check if an account is currently in cooldown. */
function isAccountCooledDown(accountId: string): boolean {
  const cd = cooldowns.get(accountId);
  if (!cd) return false;
  if (Date.now() >= cd.unavailableUntil) {
    cooldowns.delete(accountId);
    return false;
  }
  return true;
}

/** Get the shortest Retry-After seconds across all cooled-down accounts for a provider. */
export function getRetryAfterSeconds(provider: string): number | null {
  const accounts = listAccounts(provider);
  let minRemaining = Infinity;
  for (const a of accounts) {
    const cd = cooldowns.get(a.id);
    if (!cd) continue;
    const remaining = Math.ceil((cd.unavailableUntil - Date.now()) / 1000);
    if (remaining > 0 && remaining < minRemaining) minRemaining = remaining;
  }
  return minRemaining === Infinity ? null : minRemaining;
}

// ── Per-provider mutex (M5) ─────────────────────────────────────────────

/** Simple per-provider mutex to prevent concurrent account selection races. */
const providerLocks = new Map<string, Promise<void>>();

async function withProviderLock<T>(provider: string, fn: () => T): Promise<T> {
  const prev = providerLocks.get(provider) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  providerLocks.set(provider, prev.then(() => next));
  await prev;
  try {
    return fn();
  } finally {
    release!();
  }
}

// ── Per-model error lock (M1) ────────────────────────────────────────────

/** Key: "accountId:modelId", Value: unlock timestamp */
const modelLocks = new Map<string, number>();

const MODEL_LOCK_MS = 5 * 60_000; // 5 min lock per model

/** Lock an account for a specific model (called on repeated errors). */
export function lockAccountModel(accountId: string, modelId: string): void {
  const lockedUntil = Date.now() + MODEL_LOCK_MS;
  modelLocks.set(`${accountId}:${modelId}`, lockedUntil);
  getDb().query(
    "INSERT INTO account_model_locks (account_id, model_id, locked_until) VALUES (?, ?, ?) ON CONFLICT(account_id, model_id) DO UPDATE SET locked_until = excluded.locked_until"
  ).run(accountId, modelId, new Date(lockedUntil).toISOString());
}

/** Check if an account is locked for a specific model. */
function isModelLocked(accountId: string, modelId: string): boolean {
  const key = `${accountId}:${modelId}`;
  const until = modelLocks.get(key);
  if (!until) return false;
  if (Date.now() >= until) {
    modelLocks.delete(key);
    return false;
  }
  return true;
}

/** Test-only: clear all cooldown and lock state. */
export function resetCooldownForTests(): void {
  cooldowns.clear();
  modelLocks.clear();
  cooldownsHydrated = false;
}

/** Test-only: clear account snapshots and routing state between isolated databases. */
export function resetAccountRoutingForTests(): void {
  clearAccountRowsCache();
  rotationState.clear();
  providerLocks.clear();
  resetCooldownForTests();
}

/**
 * Selects an active account for a provider (REQ-20.5), ordered by priority
 * then name (same order as `listAccounts`).
 *
 * `strategy: "priority"` always returns the highest-priority available
 * account (index 0 of the filtered/sorted list) — failover to the next
 * account happens automatically once the top one lands in cooldown (C5) or
 * gets model-locked (M1), since both are already excluded from `active`.
 *
 * `strategy: "round-robin"` rotates via the shared index, advancing on every call.
 *
 * Skips accounts that are in cooldown (C5) or locked for the given model (M1).
 */
export async function pickAccountForRotation(provider: string, strategy: "priority" | "round-robin", modelId?: string, stickyLimit = 1): Promise<ProviderAccountRow | null> {
  ensureCooldownCache();
  return withProviderLock(provider, () => {
    const active = listAccountRows(provider).filter((account) => Boolean(account.active) && !isAccountCooledDown(account.id) && (modelId === undefined || !isModelLocked(account.id, modelId)));
    if (active.length === 0) return null;
    if (strategy !== "round-robin") return active[0]!;
    const index = pickRotationIndex(rotationState, provider, active.length, stickyLimit);
    return active[index]!;
  });
}



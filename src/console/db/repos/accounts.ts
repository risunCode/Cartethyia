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
import { createRotationStore, pickRotationIndex } from "../../../upstream/rotation";

export type CredentialKind = "bearer" | "pat" | "session-token";

/** Account credential_kind (DB) → ResolvedCredential kind (upstream dispatch). */
export const RESOLVED_KIND_BY_ACCOUNT_KIND: Record<CredentialKind, ResolvedCredential["kind"]> = {
  bearer: "provider-bearer",
  pat: "qoder-pat",
  "session-token": "devin-session",
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
  const rows = (
    provider === undefined
      ? db.query("SELECT * FROM provider_accounts ORDER BY priority ASC, name ASC").all()
      : db.query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY priority ASC, name ASC").all(provider)
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
  const state = getDb().query("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated_at FROM provider_accounts WHERE provider = ?").get(provider) as { count: number; updated_at: string };
  return `${state.count}:${state.updated_at}`;
}

/** Returns provider accounts using a stable, index-backed priority/name/id keyset. */
export function listAccountsPage(provider: string, limit: number, cursor?: string): AccountPage {
  const db = getDb();
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const after = decodeAccountCursor(cursor);
  const rows = (after
    ? db.query("SELECT * FROM provider_accounts WHERE provider = ? AND (priority > ? OR (priority = ? AND (name > ? OR (name = ? AND id > ?)))) ORDER BY priority ASC, name ASC, id ASC LIMIT ?").all(provider, after.priority, after.priority, after.name, after.name, after.id, boundedLimit + 1)
    : db.query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY priority ASC, name ASC, id ASC LIMIT ?").all(provider, boundedLimit + 1)
  ) as ProviderAccountRow[];
  const hasNext = rows.length > boundedLimit;
  const pageRows = hasNext ? rows.slice(0, boundedLimit) : rows;
  return { items: pageRows.map(fromRow), nextCursor: hasNext ? encodeAccountCursor(pageRows.at(-1)!) : null, version: accountsVersion(provider) };
}

export function getAccount(id: string): ProviderAccountRow | null {
  const row = getDb().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
  return row;
}

/** Active credentials in routing order for server-side model discovery. */
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
  priority?: number;
  active?: boolean;
}): { id: string; credentialHint: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const hint = credentialHint(input.credential);
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

interface StickyAssignment {
  accountId: string;
  expiresAt: number;
}

interface StickyProviderState {
  assignments: Map<string, StickyAssignment>;
  assignmentCounts: Map<string, number>;
  lastSweepAt: number;
}

const stickyAssignmentsByProvider = new Map<string, StickyProviderState>();
const STICKY_ASSIGNMENT_TTL_MS = 30 * 60_000;
const STICKY_SWEEP_INTERVAL_MS = 1_000;
const MAX_STICKY_ASSIGNMENTS_PER_PROVIDER = 10_000;

function removeStickyAssignment(state: StickyProviderState, clientKey: string, assignment: StickyAssignment): void {
  state.assignments.delete(clientKey);
  const count = (state.assignmentCounts.get(assignment.accountId) ?? 1) - 1;
  if (count > 0) state.assignmentCounts.set(assignment.accountId, count);
  else state.assignmentCounts.delete(assignment.accountId);
}

function purgeAccountRoutingState(accountId: string, provider: string): void {
  rotationState.delete(provider);
  cooldowns.delete(accountId);
  const modelPrefix = `${accountId}:`;
  for (const key of modelLocks.keys()) {
    if (key.startsWith(modelPrefix)) modelLocks.delete(key);
  }
  const state = stickyAssignmentsByProvider.get(provider);
  if (!state) return;
  for (const [clientKey, assignment] of state.assignments) {
    if (assignment.accountId === accountId) removeStickyAssignment(state, clientKey, assignment);
  }
  if (state.assignments.size === 0) stickyAssignmentsByProvider.delete(provider);
}

function pickStickyAccount(provider: string, active: ProviderAccountRow[], clientKey: string, stickyLimit: number): ProviderAccountRow | null {
  if (stickyLimit < 1 || stickyLimit > 3) return null;
  const now = Date.now();
  let state = stickyAssignmentsByProvider.get(provider);
  if (!state) {
    state = { assignments: new Map(), assignmentCounts: new Map(), lastSweepAt: 0 };
    stickyAssignmentsByProvider.set(provider, state);
  }

  const accountIds = new Set(active.map((account) => account.id));
  if (now - state.lastSweepAt >= STICKY_SWEEP_INTERVAL_MS) {
    state.lastSweepAt = now;
    for (const [key, assignment] of state.assignments) {
      if (assignment.expiresAt <= now || !accountIds.has(assignment.accountId)) removeStickyAssignment(state, key, assignment);
    }
  }

  const existing = state.assignments.get(clientKey);
  if (existing && existing.expiresAt > now && accountIds.has(existing.accountId)) {
    existing.expiresAt = now + STICKY_ASSIGNMENT_TTL_MS;
    return active.find((account) => account.id === existing.accountId) ?? null;
  }
  if (existing) removeStickyAssignment(state, clientKey, existing);

  const candidates = active.filter((account) => (state!.assignmentCounts.get(account.id) ?? 0) < stickyLimit);
  const pool = candidates.length > 0 ? candidates : active;
  const selected = pool.reduce((best, account) => {
    const accountCount = state!.assignmentCounts.get(account.id) ?? 0;
    const bestCount = state!.assignmentCounts.get(best.id) ?? 0;
    return accountCount < bestCount ? account : best;
  });

  if (state.assignments.size >= MAX_STICKY_ASSIGNMENTS_PER_PROVIDER) {
    const oldest = state.assignments.entries().next();
    if (!oldest.done) removeStickyAssignment(state, oldest.value[0], oldest.value[1]);
  }
  state.assignments.set(clientKey, { accountId: selected.id, expiresAt: now + STICKY_ASSIGNMENT_TTL_MS });
  state.assignmentCounts.set(selected.id, (state.assignmentCounts.get(selected.id) ?? 0) + 1);
  return selected;
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

/** Marks a rate-limited account unavailable for a full 30 minutes; auth failures retain bounded exponential backoff. */
export function markAccountUnavailable(accountId: string, kind: "rate-limit" | "auth" = "rate-limit"): void {
  const existing = cooldowns.get(accountId);
  const backoffLevel = kind === "rate-limit"
    ? RATE_LIMIT_COOLDOWN_LEVEL
    : Math.min((existing?.backoffLevel ?? -1) + 1, COOLDOWN_MAX_LEVEL);
  const unavailableUntil = Date.now() + (kind === "rate-limit"
    ? RATE_LIMIT_COOLDOWN_MS
    : Math.min(COOLDOWN_BASE_MS * Math.pow(2, backoffLevel), COOLDOWN_MAX_MS));
  cooldowns.set(accountId, { unavailableUntil, backoffLevel });
  getDb().query("UPDATE provider_accounts SET cooldown_until = ?, cooldown_level = ? WHERE id = ?").run(new Date(unavailableUntil).toISOString(), backoffLevel, accountId);
}

/** Clears transient cooldown only; a rate-limit cooldown always lasts the full 30 minutes. */
export function clearAccountCooldown(accountId: string): void {
  const cooldown = cooldowns.get(accountId);
  if (cooldown?.backoffLevel === RATE_LIMIT_COOLDOWN_LEVEL) return;
  cooldowns.delete(accountId);
  getDb().query("UPDATE provider_accounts SET cooldown_until = NULL, cooldown_level = 0 WHERE id = ?").run(accountId);
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
  stickyAssignmentsByProvider.clear();
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
 * Bugfix: this used to be encoded as `stickyLimit <= 0` passed into the same
 * rotating index function round-robin uses, but that function treats
 * `stickyLimit <= 0` as "advance every call" — so "priority" mode silently
 * behaved exactly like round-robin instead of pinning to the top account.
 *
 * `strategy: "round-robin"` rotates via the shared index; `stickyLimit <= 0`
 * advances on every call, `stickyLimit > 0` reuses the same account for that
 * many consecutive picks before advancing.
 *
 * Skips accounts that are in cooldown (C5) or locked for the given model (M1).
 */
export async function pickAccountForRotation(provider: string, strategy: "priority" | "round-robin", stickyLimit: number, modelId?: string, clientKey?: string): Promise<ProviderAccountRow | null> {
  ensureCooldownCache();
  return withProviderLock(provider, () => {
    const active = listAccountRows(provider).filter((account) => Boolean(account.active) && !isAccountCooledDown(account.id) && (modelId === undefined || !isModelLocked(account.id, modelId)));
    if (active.length === 0) return null;
    const sticky = clientKey ? pickStickyAccount(provider, active, clientKey, stickyLimit) : null;
    if (sticky) return sticky;
    if (strategy !== "round-robin") return active[0]!;
    const index = pickRotationIndex(rotationState, provider, active.length, 1);
    return active[index]!;
  });
}



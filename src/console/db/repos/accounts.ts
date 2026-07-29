/**
 * Provider accounts — CRUD with AES-GCM encrypted credentials (REQ-3.7, REQ-20).
 * Stores `credential_enc` (encrypted), `credential_hint` (masked display).
 */

import { getDb } from "../client";
import { encryptCredential, decryptCredential, credentialHint } from "../../crypto/credential-key";
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
  credential_enc: string;
  credential_hint: string;
  proxy_pool_id: string | null;
  use_direct: number;
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
  proxyPoolId: string | null;
  useDirect: boolean;
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
    proxyPoolId: row.proxy_pool_id ?? null,
    useDirect: Boolean(row.use_direct),
    priority: row.priority,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(provider?: string): ProviderAccount[] {
  const db = getDb();
  const rows = (
    provider === undefined
      ? db.query("SELECT * FROM provider_accounts ORDER BY priority ASC, name ASC").all()
      : db.query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY priority ASC, name ASC").all(provider)
  ) as ProviderAccountRow[];
  return rows.map(fromRow);
}

export function getAccount(id: string): ProviderAccountRow | null {
  const row = getDb().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
  return row;
}

/** Decrypt active credentials in routing order for server-side model discovery. */
export async function listActiveAccountCredentials(provider: string): Promise<string[]> {
  const rows = getDb()
    .query("SELECT credential_enc FROM provider_accounts WHERE provider = ? AND active = 1 ORDER BY priority ASC, name ASC")
    .all(provider) as Array<Pick<ProviderAccountRow, "credential_enc">>;
  const credentials: string[] = [];
  for (const row of rows) {
    try {
      credentials.push(await decryptCredential(row.credential_enc));
    } catch {
      // A corrupted credential must not prevent a later account from discovery.
    }
  }
  return credentials;
}

/** Create a new account; returns only public fields (+ hint). */
export async function createAccount(input: {
  provider: string;
  name: string;
  credentialKind: CredentialKind;
  credential: string;
  proxyPoolId?: string | null;
  useDirect?: boolean;
  priority?: number;
  active?: boolean;
}): Promise<{ id: string; credentialHint: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const enc = await encryptCredential(input.credential);
  const hint = credentialHint(input.credential);
  const id = crypto.randomUUID();
  const active = input.active ?? true;
  const useDirect = input.useDirect ?? false;
  const priority = typeof input.priority === "number" && Number.isFinite(input.priority) ? input.priority : 100;
  const proxyPoolId = input.proxyPoolId ?? null;

  db.query(
    "INSERT INTO provider_accounts (id, provider, name, credential_kind, credential_enc, credential_hint, proxy_pool_id, use_direct, priority, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.provider, input.name, input.credentialKind.toLowerCase(), enc, hint, proxyPoolId, useDirect ? 1 : 0, priority, active ? 1 : 0, now, now);

  return { id, credentialHint: hint };
}

export async function patchAccount(id: string, patch: {
  provider?: string;
  name?: string;
  credentialKind?: CredentialKind;
  credential?: string;
  proxyPoolId?: string | null;
  useDirect?: boolean;
  priority?: number;
  active?: boolean;
}): Promise<void> {
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
    updateFields.push("credential_enc = ?");
    values.push(await encryptCredential(patch.credential));
    updateFields.push("credential_hint = ?");
    values.push(credentialHint(patch.credential));
  }
  if (patch.proxyPoolId !== undefined) {
    updateFields.push("proxy_pool_id = ?");
    values.push(patch.proxyPoolId ?? null);
  }
  if (patch.useDirect !== undefined) {
    updateFields.push("use_direct = ?");
    values.push(patch.useDirect ? 1 : 0);
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
}

export function deleteAccount(id: string): boolean {
  const result = getDb().query("DELETE FROM provider_accounts WHERE id = ?").run(id);
  return result.changes > 0;
}

const rotationState = createRotationStore<string>();

// ── Account cooldown (C5) ────────────────────────────────────────────────

interface AccountCooldown {
  unavailableUntil: number;
  backoffLevel: number;
}

const cooldowns = new Map<string, AccountCooldown>();

const COOLDOWN_BASE_MS = 2_000;       // 2s base
const COOLDOWN_MAX_MS = 30 * 60_000;  // 30 min hard cap
const COOLDOWN_MAX_LEVEL = 15;

/** Mark an account as unavailable (called on 429/upstream failure). */
export function markAccountUnavailable(accountId: string): void {
  const existing = cooldowns.get(accountId);
  const level = existing ? existing.backoffLevel + 1 : 0;
  const clampedLevel = Math.min(level, COOLDOWN_MAX_LEVEL);
  const delay = Math.min(COOLDOWN_BASE_MS * Math.pow(2, clampedLevel), COOLDOWN_MAX_MS);
  cooldowns.set(accountId, { unavailableUntil: Date.now() + delay, backoffLevel: clampedLevel });
}

/** Clear cooldown for an account (called on successful request). */
export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId);
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
  modelLocks.set(`${accountId}:${modelId}`, Date.now() + MODEL_LOCK_MS);
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
}

/**
 * Round-robin + sticky-limit selection among active accounts for a provider
 * (REQ-20.5), ordered by priority then name (same order as `listAccounts`).
 * `stickyLimit <= 0` rotates on every call; `stickyLimit > 0` reuses the same
 * account for that many consecutive picks before advancing.
 *
 * Skips accounts that are in cooldown (C5) or locked for the given model (M1).
 */
export async function pickAccountForRotation(provider: string, stickyLimit: number, modelId?: string): Promise<ProviderAccountRow | null> {
  return withProviderLock(provider, () => {
    const active = listAccounts(provider).filter((a) => a.active && !isAccountCooledDown(a.id) && (modelId === undefined || !isModelLocked(a.id, modelId)));
    if (active.length === 0) return null;

    const index = pickRotationIndex(rotationState, provider, active.length, stickyLimit);
    return getAccount(active[index]!.id);
  });
}

export interface DecryptedCredential {
  id: string;
  plain: string;
}

/** Phase 1 of key rotation: decrypt every credential with the CURRENT key. */
export async function decryptAllCredentials(): Promise<DecryptedCredential[]> {
  const rows = getDb().query("SELECT id, credential_enc FROM provider_accounts").all() as Pick<ProviderAccountRow, "id" | "credential_enc">[];
  const result: DecryptedCredential[] = [];
  for (const row of rows) {
    result.push({ id: row.id, plain: await decryptCredential(row.credential_enc) });
  }
  return result;
}

/** Phase 2 of key rotation: write credentials back encrypted with the CURRENT (new) key. */
export async function writeEncryptedCredentials(items: DecryptedCredential[]): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const item of items) {
    const enc = await encryptCredential(item.plain);
    db.query("UPDATE provider_accounts SET credential_enc = ?, updated_at = ? WHERE id = ?").run(enc, now, item.id);
  }
  return items.length;
}

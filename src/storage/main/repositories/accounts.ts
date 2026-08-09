import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import { credentialKindOf, toProviderAccount, type ProviderAccountRow } from "../mappers";
import type { AccountCreateInput, AccountListPage, AccountListPagination, AccountRepository, AccountPatchInput, ProviderAccountRecord } from "../records";


export function createAccountRepository(db: () => Database): AccountRepository {
  return {
    list(provider?: string): ProviderAccountRecord[] {
      const rows = provider
        ? (db().query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY priority ASC, name ASC").all(provider) as ProviderAccountRow[])
        : (db().query("SELECT * FROM provider_accounts ORDER BY provider ASC, priority ASC, name ASC").all() as ProviderAccountRow[]);
      return rows.map(toProviderAccount);
    },
    listPaged(provider: string, pagination: AccountListPagination): AccountListPage {
      const limit = Math.max(1, Math.min(500, Math.floor(pagination.limit ?? 50)));
      const cursor = pagination.cursor;
      // Keyset pagination on the primary key id — backed by
      // idx_provider_accounts_provider_id(provider, id). The first page
      // skips the id predicate; subsequent pages resume after the cursor.
      const rows = cursor
        ? (db().query("SELECT * FROM provider_accounts WHERE provider = ? AND id > ? ORDER BY id ASC LIMIT ?").all(provider, cursor, limit) as ProviderAccountRow[])
        : (db().query("SELECT * FROM provider_accounts WHERE provider = ? ORDER BY id ASC LIMIT ?").all(provider, limit) as ProviderAccountRow[]);
      const items = rows.map(toProviderAccount);
      const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
      return { items, nextCursor };
    },
    get(id: string): ProviderAccountRecord | null {
      const row = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      return row ? toProviderAccount(row) : null;
    },
    create(input: AccountCreateInput): ProviderAccountRecord {
      const now = nowIso();
      const priority = input.priority === undefined ? 100 : input.priority;
      const active = input.active === undefined ? true : input.active;
      db().query(
        "INSERT INTO provider_accounts (id, provider, name, credential_kind, credential, credential_hint, priority, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.provider, input.name, input.credentialKind, input.credential, input.credentialHint, priority, active ? 1 : 0, now, now);
      return toProviderAccount(db().query("SELECT * FROM provider_accounts WHERE id = ?").get(input.id) as ProviderAccountRow);
    },
    patch(id: string, patch: AccountPatchInput): ProviderAccountRecord | null {
      const existing = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      if (!existing) return null;
      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.credentialKind !== undefined) {
        fields.push("credential_kind = ?");
        values.push(patch.credentialKind);
      }
      if (patch.credential !== undefined) {
        fields.push("credential = ?");
        values.push(patch.credential);
      }
      if (patch.credentialHint !== undefined) {
        fields.push("credential_hint = ?");
        values.push(patch.credentialHint);
      }
      if (patch.priority !== undefined) {
        fields.push("priority = ?");
        values.push(patch.priority);
      }
      if (patch.active !== undefined) {
        fields.push("active = ?");
        values.push(patch.active ? 1 : 0);
      }
      if (patch.cooldownUntil !== undefined) {
        fields.push("cooldown_until = ?");
        values.push(patch.cooldownUntil);
      }
      if (patch.cooldownLevel !== undefined) {
        fields.push("cooldown_level = ?");
        values.push(patch.cooldownLevel);
      }
      if (patch.consecutiveUseCount !== undefined) {
        fields.push("consecutive_use_count = ?");
        values.push(patch.consecutiveUseCount);
      }
      if (patch.lastUsedAt !== undefined) {
        fields.push("last_used_at = ?");
        values.push(patch.lastUsedAt);
      }
      if (fields.length === 0) return toProviderAccount(existing);
      db().query(`UPDATE provider_accounts SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
      const row = db().query("SELECT * FROM provider_accounts WHERE id = ?").get(id) as ProviderAccountRow | null;
      return row ? toProviderAccount(row) : null;
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM provider_accounts WHERE id = ?").run(id);
      return result.changes > 0;
    },
    deleteBatch(ids: readonly string[]): number {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      const result = db().query(`DELETE FROM provider_accounts WHERE id IN (${placeholders})`).run(...ids);
      return result.changes;
    },
    setActiveBatch(ids: readonly string[], active: boolean): number {
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      const result = db().query(`UPDATE provider_accounts SET active = ?, updated_at = ? WHERE id IN (${placeholders})`).run(active ? 1 : 0, nowIso(), ...ids);
      return result.changes;
    },
    listActiveCredentials(provider: string): string[] {
      const rows = db().query("SELECT credential FROM provider_accounts WHERE provider = ? AND active = 1 ORDER BY priority ASC, name ASC").all(provider) as Array<{ credential: string }>;
      return rows.map((row) => row.credential).filter((value) => value.length > 0);
    },
  };
}

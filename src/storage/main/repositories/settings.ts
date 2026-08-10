import { Database } from "bun:sqlite";
import type { PersistenceEnv } from "../env";
import { configError, nowIso } from "../schema";
import { toSettings, type SettingsRow } from "../mappers";
import type { RuntimeSettings, SettingsRecord, SettingsRepository } from "../records";

export function createConsoleSettingsRepository(db: () => Database, env: PersistenceEnv): SettingsRepository {
  const getRow = (): SettingsRow | null => db().query("SELECT * FROM settings WHERE id = 1").get() as SettingsRow | null;
  // Cache the parsed settings JSON — invalidated on any mutation. This avoids
  // a SQLite read + JSON.parse on every hot-path call (tokenSaver, provider
  // routing, privacy mode) when settings haven't changed.
  let cachedJson: Record<string, unknown> | null = null;

  return {
    ensure(): SettingsRecord {
      const existing = getRow();
      if (existing) { cachedJson = null; return toSettings(existing); }
      const now = nowIso();
      db().query("INSERT INTO settings (id, password_hash, password_version, jwt_secret, settings_json, initialized_at, updated_at) VALUES (1, NULL, 1, NULL, '{}', ?, ?)").run(now, now);
      cachedJson = null;
      return toSettings(db().query("SELECT * FROM settings WHERE id = 1").get() as SettingsRow);
    },
    get(): SettingsRecord | null {
      const row = getRow();
      return row ? toSettings(row) : null;
    },
    getSettingsJson(): Record<string, unknown> {
      if (cachedJson !== null) return cachedJson;
      const json = this.get()?.settingsJson ?? {};
      cachedJson = json;
      return json;
    },
    patchSettingsJson(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
      const row = getRow();
      if (!row) throw configError("settings not initialized");
      // Use the cached parsed JSON (getSettingsJson) instead of re-parsing
      // the row via toSettings(row) — the cache is invalidated on every
      // mutation, so it's always current at this point.
      const current = this.getSettingsJson();
      const next: Record<string, unknown> = { ...current, ...patch };
      db().query("UPDATE settings SET settings_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(next), nowIso());
      cachedJson = next;
      return next;
    },
    getRuntimeSettings(): RuntimeSettings {
      const json = this.getSettingsJson();
      const runtime = json.runtime;
      const patch = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime) ? (runtime as Record<string, unknown>) : {};
      const logRetentionDays = typeof patch.logRetentionDays === "number" && Number.isFinite(patch.logRetentionDays) ? Math.min(Math.max(Math.floor(patch.logRetentionDays), 1), 365) : env.logRetentionDays;
      const assetRetentionDays = typeof patch.assetRetentionDays === "number" && Number.isFinite(patch.assetRetentionDays) ? Math.min(Math.max(Math.floor(patch.assetRetentionDays), 1), 365) : env.assetRetentionDays;
      return { logRetentionDays, assetRetentionDays };
    },
    patchRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
      const json = this.getSettingsJson();
      const runtime = json.runtime;
      const current = typeof runtime === "object" && runtime !== null && !Array.isArray(runtime) ? (runtime as Record<string, unknown>) : {};
      const next: Record<string, unknown> = { ...current };
      if (patch.logRetentionDays !== undefined) next.logRetentionDays = Math.min(Math.max(Math.floor(patch.logRetentionDays), 1), 365);
      if (patch.assetRetentionDays !== undefined) next.assetRetentionDays = Math.min(Math.max(Math.floor(patch.assetRetentionDays), 1), 365);
      this.patchSettingsJson({ runtime: next });
      return { logRetentionDays: Number(next.logRetentionDays) || env.logRetentionDays, assetRetentionDays: Number(next.assetRetentionDays) || env.assetRetentionDays };
    },
    setPasswordHash(hash: string): void {
      db().query("UPDATE settings SET password_hash = ?, password_version = password_version + 1, updated_at = ? WHERE id = 1").run(hash, nowIso());
    },
    bumpPasswordVersion(): void {
      db().query("UPDATE settings SET password_version = password_version + 1, updated_at = ? WHERE id = 1").run(nowIso());
    },
    rotateJwtSecret(secret: string): void {
      db().query("UPDATE settings SET jwt_secret = ?, password_version = password_version + 1, updated_at = ? WHERE id = 1").run(secret, nowIso());
    },
  };
}

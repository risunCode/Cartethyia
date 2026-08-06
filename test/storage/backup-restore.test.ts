import { describe, expect, test, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  applyConfigRestore,
  BACKUP_APP,
  BACKUP_TABLES,
  BACKUP_VERSION,
  exportConfigBackup,
  validateRestorePayload,
  type BackupPayload,
} from "../../src/storage/main/backup";
import { CONFIG_SCHEMA_SQL, ensureConfigSchema, migrateProviderIds } from "../../src/storage/main/schema";
import { resetConfigPersistenceForTests } from "../../src/storage/main/config";
import type { PersistenceEnv } from "../../src/storage/main/env";

function testEnv(): PersistenceEnv {
  const dir = join(tmpdir(), `test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return {
    dataDir: dir,
    dbPath: join(dir, "cartethyia.sqlite"),
    runtimeDbPath: join(dir, "runtime.sqlite"),
    assetDir: join(dir, "assets"),
    logRetentionDays: 14,
    assetRetentionDays: 7,
    maxFlightsPerIp: 15,
  };
}

function freshDb(env: PersistenceEnv): Database {
  mkdirSync(dirname(env.dbPath), { recursive: true });
  const db = new Database(env.dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(CONFIG_SCHEMA_SQL);
  ensureConfigSchema(db);
  migrateProviderIds(db);
  return db;
}

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    password_hash: null,
    password_version: 1,
    jwt_secret: null,
    settings_json: "{}",
    initialized_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...over,
  };
}

function makeProxySettingsRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    enabled: 1,
    excluded_providers_json: "[]",
    smart_dynamic_routing: 0,
    smart_dynamic_proxy_count: 2,
    routing_preset: "auto",
    target_concurrent: 0,
    updated_at: "2026-01-01 00:00:00",
    ...over,
  };
}

beforeEach(() => {
  resetConfigPersistenceForTests();
});

describe("exportConfigBackup", () => {
  test("exports all config tables from a populated database", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      db.query("INSERT INTO settings (id, initialized_at, updated_at) VALUES (1, ?, ?)").run("2026-01-01 00:00:00", "2026-01-01 00:00:00");
      db.query("INSERT INTO api_keys (id, name, key, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)").run("k1", "primary", "sk-secret", "sk-", "2026-01-01 00:00:00");
      db.query("INSERT INTO model_aliases (alias, model, created_at) VALUES (?, ?, ?)").run("fast", "gpt-4o", "2026-01-01 00:00:00");

      const payload = exportConfigBackup(db);

      expect(payload.app).toBe(BACKUP_APP);
      expect(payload.version).toBe(BACKUP_VERSION);
      expect(typeof payload.exportedAt).toBe("string");
      expect(payload.tables).toBeTypeOf("object");

      const settings = payload.tables.settings as Record<string, unknown>;
      expect(settings).toBeTypeOf("object");
      expect(settings.initialized_at).toBe("2026-01-01 00:00:00");

      const keys = payload.tables.api_keys as unknown[];
      expect(keys.length).toBe(1);
      const keyRow = keys[0] as Record<string, unknown>;
      expect(keyRow.id).toBe("k1");
      expect(keyRow.name).toBe("primary");

      const aliases = payload.tables.model_aliases as unknown[];
      expect(aliases.length).toBe(1);
      expect((aliases[0] as Record<string, unknown>).alias).toBe("fast");
    } finally {
      db.close();
    }
  });

  test("settings and proxy_settings are exported as single objects when id=1 row exists", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      db.query("INSERT INTO settings (id, initialized_at, updated_at) VALUES (1, ?, ?)").run("2026-01-01 00:00:00", "2026-01-01 00:00:00");
      db.query("INSERT INTO proxy_settings (id, enabled, updated_at) VALUES (1, ?, ?)").run(1, "2026-01-01 00:00:00");

      const payload = exportConfigBackup(db);

      const settings = payload.tables.settings;
      expect(Array.isArray(settings)).toBe(false);
      expect((settings as Record<string, unknown>).id).toBe(1);

      const proxySettings = payload.tables.proxy_settings;
      expect(Array.isArray(proxySettings)).toBe(false);
      expect((proxySettings as Record<string, unknown>).enabled).toBe(1);
    } finally {
      db.close();
    }
  });

  test("empty database exports empty tables", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      const payload = exportConfigBackup(db);

      expect(payload.app).toBe(BACKUP_APP);
      expect(payload.version).toBe(BACKUP_VERSION);

      const settings = payload.tables.settings as Record<string, unknown>;
      expect(Object.keys(settings).length).toBe(0);

      const keys = payload.tables.api_keys as unknown[];
      expect(keys.length).toBe(0);

      for (const table of BACKUP_TABLES) {
        expect(payload.tables).toHaveProperty(table);
      }
    } finally {
      db.close();
    }
  });

  test("export includes schema version and app identifier", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      const payload = exportConfigBackup(db);
      expect(payload.app).toBe(BACKUP_APP);
      expect(payload.version).toBe(BACKUP_VERSION);
      expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      db.close();
    }
  });
});

describe("validateRestorePayload", () => {
  test("accepts a valid payload with settings and proxy_settings objects", () => {
    const payload: BackupPayload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tables: {
        settings: makeRow(),
        proxy_settings: makeProxySettingsRow(),
      },
    };

    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const settingsRows = result.tables.get("settings");
      expect(settingsRows).toBeDefined();
      expect(settingsRows!.length).toBe(1);
      expect(settingsRows![0]!.id).toBe(1);

      const proxyRows = result.tables.get("proxy_settings");
      expect(proxyRows).toBeDefined();
      expect(proxyRows!.length).toBe(1);
    }
  });

  test("accepts settings/proxy_settings as arrays too", () => {
    const payload: BackupPayload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tables: {
        settings: [makeRow()],
        proxy_settings: [makeProxySettingsRow()],
      },
    };

    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(true);
  });

  test("rejects non-object payload", () => {
    expect(validateRestorePayload(null).ok).toBe(false);
    expect(validateRestorePayload(undefined).ok).toBe(false);
    expect(validateRestorePayload("string").ok).toBe(false);
    expect(validateRestorePayload(42).ok).toBe(false);
    expect(validateRestorePayload([1, 2, 3]).ok).toBe(false);
  });

  test("rejects payload with wrong app identifier", () => {
    const payload = {
      app: "other-app",
      version: BACKUP_VERSION,
      tables: {},
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(BACKUP_APP);
  });

  test("rejects payload with unsupported version", () => {
    const payload = {
      app: BACKUP_APP,
      version: 99,
      tables: {},
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
  });

  test("rejects payload with unknown tables", () => {
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { evil_table: [{ id: 1 }] },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("evil_table");
  });

  test("rejects payload with more table keys than allowlist", () => {
    const tables: Record<string, unknown> = {};
    for (let i = 0; i < BACKUP_TABLES.length + 1; i++) {
      tables[`fake_${i}`] = [];
    }
    const payload = { app: BACKUP_APP, version: BACKUP_VERSION, tables };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
  });

  test("rejects array table entries that are not row objects", () => {
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { api_keys: ["not-a-row", { id: "k1" }] },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("api_keys[0]");
  });

  test("rejects rows with unknown columns", () => {
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { api_keys: [{ id: "k1", evil_column: "hack" }] },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("evil_column");
  });

  test("rejects rows with non-primitive cell values", () => {
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { api_keys: [{ id: "k1", name: { nested: "object" } }] },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be a primitive");
  });

  test("accepts payload with exactly 100_000 rows per table (boundary)", () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 100_000; i++) {
      rows.push({ alias: `a${i}`, model: "m", created_at: "2026-01-01 00:00:00" });
    }
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { model_aliases: rows },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(true);
  });

  test("rejects payload exceeding 100_000 rows per table", () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 100_001; i++) {
      rows.push({ alias: `a${i}`, model: "m", created_at: "2026-01-01 00:00:00" });
    }
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { model_aliases: rows },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("100000");
  });

  test("rejects settings that is not an object or array", () => {
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { settings: "not-an-object" },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(false);
  });

  test("normalizes empty settings object to zero rows", () => {
    const payload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      tables: { settings: {} },
    };
    const result = validateRestorePayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows = result.tables.get("settings");
      expect(rows).toBeDefined();
      expect(rows!.length).toBe(0);
    }
  });
});

describe("applyConfigRestore", () => {
  test("restores settings and proxy_settings into a fresh database", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      const validation = validateRestorePayload({
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: {
          settings: makeRow({ settings_json: '{"theme":"dark"}', jwt_secret: "jwt-123" }),
          proxy_settings: makeProxySettingsRow({ enabled: 1, routing_preset: "round_robin" }),
        },
      });
      if (!validation.ok) throw new Error("validation failed");

      const result = applyConfigRestore(db, validation);
      expect(result.restored.settings).toBe(1);
      expect(result.restored.proxy_settings).toBe(1);

      const settingsRow = db.query("SELECT settings_json, jwt_secret FROM settings WHERE id = 1").get() as { settings_json: string; jwt_secret: string };
      expect(settingsRow.settings_json).toBe('{"theme":"dark"}');
      expect(settingsRow.jwt_secret).toBe("jwt-123");

      const proxyRow = db.query("SELECT enabled, routing_preset FROM proxy_settings WHERE id = 1").get() as { enabled: number; routing_preset: string };
      expect(proxyRow.enabled).toBe(1);
      expect(proxyRow.routing_preset).toBe("round_robin");
    } finally {
      db.close();
    }
  });

  test("coerces boolean true to integer 1 and false to 0 on restore", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      const validation = validateRestorePayload({
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: {
          proxy_settings: makeProxySettingsRow({ enabled: true, smart_dynamic_routing: false }),
          api_keys: [
            {
              id: "k1",
              name: "primary",
              key: "sk-secret",
              key_prefix: "sk-",
              active: true,
              created_at: "2026-01-01 00:00:00",
            },
          ],
        },
      });
      if (!validation.ok) throw new Error("validation failed");

      applyConfigRestore(db, validation);

      const proxyRow = db.query("SELECT enabled, smart_dynamic_routing FROM proxy_settings WHERE id = 1").get() as { enabled: number; smart_dynamic_routing: number };
      expect(proxyRow.enabled).toBe(1);
      expect(proxyRow.smart_dynamic_routing).toBe(0);

      const keyRow = db.query("SELECT active FROM api_keys WHERE id = 'k1'").get() as { active: number };
      expect(keyRow.active).toBe(1);
    } finally {
      db.close();
    }
  });

  test("handles empty row arrays (restores zero rows)", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      const validation = validateRestorePayload({
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: {
          settings: {},
          api_keys: [],
          model_aliases: [],
        },
      });
      if (!validation.ok) throw new Error("validation failed");

      const result = applyConfigRestore(db, validation);
      expect(result.restored.settings).toBe(0);
      expect(result.restored.api_keys).toBe(0);

      const keyCount = db.query("SELECT COUNT(*) AS c FROM api_keys").get() as { c: number };
      expect(keyCount.c).toBe(0);
    } finally {
      db.close();
    }
  });

  test("rolls back the entire restore on SQL constraint failure", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      db.query("INSERT INTO settings (id, initialized_at, updated_at) VALUES (1, ?, ?)").run("2026-01-01 00:00:00", "2026-01-01 00:00:00");

      const validation = validateRestorePayload({
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: {
          settings: makeRow(),
          model_aliases: [
            { alias: "dup", model: "m1", created_at: "2026-01-01 00:00:00" },
            { alias: "dup", model: "m2", created_at: "2026-01-01 00:00:00" },
          ],
        },
      });
      if (!validation.ok) throw new Error("validation failed");

      expect(() => applyConfigRestore(db, validation)).toThrow();

      const aliasCount = db.query("SELECT COUNT(*) AS c FROM model_aliases").get() as { c: number };
      expect(aliasCount.c).toBe(0);

      const settingsCount = db.query("SELECT COUNT(*) AS c FROM settings").get() as { c: number };
      expect(settingsCount.c).toBe(1);
    } finally {
      db.close();
    }
  });

  test("restore is idempotent — applying twice yields the same state", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      const validation = validateRestorePayload({
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: {
          settings: makeRow({ jwt_secret: "jwt-abc" }),
          proxy_settings: makeProxySettingsRow({ enabled: 1 }),
          api_keys: [
            { id: "k1", name: "primary", key: "sk-secret", key_prefix: "sk-", active: 1, created_at: "2026-01-01 00:00:00" },
            { id: "k2", name: "secondary", key: "sk-secret-2", key_prefix: "sk-", active: 0, created_at: "2026-01-01 00:00:00" },
          ],
        },
      });
      if (!validation.ok) throw new Error("validation failed");

      const first = applyConfigRestore(db, validation);
      const second = applyConfigRestore(db, validation);

      expect(second.restored.api_keys).toBe(first.restored.api_keys);
      expect(second.restored.settings).toBe(first.restored.settings);

      const keyCount = db.query("SELECT COUNT(*) AS c FROM api_keys").get() as { c: number };
      expect(keyCount.c).toBe(2);

      const settingsRow = db.query("SELECT jwt_secret FROM settings WHERE id = 1").get() as { jwt_secret: string };
      expect(settingsRow.jwt_secret).toBe("jwt-abc");
    } finally {
      db.close();
    }
  });

  test("restore deletes existing rows before inserting (clean cutover)", () => {
    const env = testEnv();
    const db = freshDb(env);
    try {
      db.query("INSERT INTO api_keys (id, name, key, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)").run("old-key", "old", "sk-old", "sk-", "2026-01-01 00:00:00");

      const validation = validateRestorePayload({
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        tables: {
          api_keys: [
            { id: "new-key", name: "new", key: "sk-new", key_prefix: "sk-", created_at: "2026-01-01 00:00:00" },
          ],
        },
      });
      if (!validation.ok) throw new Error("validation failed");

      applyConfigRestore(db, validation);

      const oldRow = db.query("SELECT id FROM api_keys WHERE id = 'old-key'").get();
      expect(oldRow).toBeNull();

      const newRow = db.query("SELECT id FROM api_keys WHERE id = 'new-key'").get();
      expect(newRow).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("full round-trip: export → validate → restore produces identical state", () => {
    const env = testEnv();
    const sourceDb = freshDb(env);
    const targetEnv = testEnv();
    const targetDb = freshDb(targetEnv);
    try {
      sourceDb.query("INSERT INTO settings (id, initialized_at, updated_at, jwt_secret, settings_json) VALUES (1, ?, ?, ?, ?)").run("2026-01-01 00:00:00", "2026-01-01 00:00:00", "secret-xyz", '{"k":"v"}');
      sourceDb.query("INSERT INTO proxy_settings (id, enabled, updated_at) VALUES (1, ?, ?)").run(1, "2026-01-01 00:00:00");
      sourceDb.query("INSERT INTO api_keys (id, name, key, key_prefix, active, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("k1", "primary", "sk-secret", "sk-", 1, "2026-01-01 00:00:00");

      const payload = exportConfigBackup(sourceDb);
      const validation = validateRestorePayload(payload);
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error("validation failed");

      applyConfigRestore(targetDb, validation);

      const sourceSettings = sourceDb.query("SELECT settings_json, jwt_secret FROM settings WHERE id = 1").get();
      const targetSettings = targetDb.query("SELECT settings_json, jwt_secret FROM settings WHERE id = 1").get();
      expect(targetSettings).toEqual(sourceSettings);

      const sourceKeys = sourceDb.query("SELECT id, name, key_prefix, active FROM api_keys ORDER BY id").all();
      const targetKeys = targetDb.query("SELECT id, name, key_prefix, active FROM api_keys ORDER BY id").all();
      expect(targetKeys).toEqual(sourceKeys);

      const sourceProxy = sourceDb.query("SELECT enabled FROM proxy_settings WHERE id = 1").get();
      const targetProxy = targetDb.query("SELECT enabled FROM proxy_settings WHERE id = 1").get();
      expect(targetProxy).toEqual(sourceProxy);
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  });
});

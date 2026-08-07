import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createConfigPersistence } from "../../src/storage/main/config";
import { createRuntimePersistence } from "../../src/storage/runtime/runtime";
import type { PersistenceEnv } from "../../src/storage/main/env";
import { removeTempDir } from "../support/temp";

function env(root: string): PersistenceEnv {
  return { dataDir: root, dbPath: join(root, "config.sqlite"), runtimeDbPath: join(root, "runtime.sqlite"), assetDir: join(root, "assets"), logRetentionDays: 14, assetRetentionDays: 7, maxFlightsPerIp: 40 };
}

function names(db: Database, kind: "table" | "index", table?: string): string[] {
  const rows = db.query(table === undefined ? "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name" : "SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name").all(kind, ...(table === undefined ? [] : [table])) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("database topology", () => {
  test("does not reopen closed databases or retain stalled runtime writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cartethyia-close-"));
    const persistenceEnv = env(root);
    const config = createConfigPersistence(persistenceEnv);
    const runtime = createRuntimePersistence({ ...persistenceEnv, runtimeDbPath: join(root, "blocked-runtime") });
    mkdirSync(join(root, "blocked-runtime"));

    const telemetry = runtime.telemetry.start({
      requestId: "close-regression",
      endpoint: "/v1/chat/completions",
      surface: "openai-chat",
      apiKeyId: null,
      apiKeyPrefix: null,
      clientName: "unknown",
      clientSource: "unknown",
      startedAt: new Date().toISOString(),
      messageCount: 0,
      toolCount: 0,
      imageCount: 0,
    });
    await telemetry.finish({ statusCode: 200, errorKind: null, usage: null, providerId: "test", model: "test", mode: "non_stream", messageCount: 0, toolCount: 0, imageCount: 0 });

    try {
      runtime.close();
      config.close();
      expect(runtime.pendingWrites()).toBe(0);
      expect(() => runtime.metadata.querySummary("all")).toThrow("runtime database is closed");
      expect(() => config.settings.getSettingsJson()).toThrow("configuration database is closed");
    } finally {
      removeTempDir(root);
    }
  });

  test("persists and clears console logs through runtime storage", () => {
    const root = mkdtempSync(join(tmpdir(), "cartethyia-logs-"));
    const persistenceEnv = env(root);
    const runtime = createRuntimePersistence(persistenceEnv);
    try {
      runtime.consoleLogs.push("info", "test", "first line");
      runtime.consoleLogs.push("error", "test", "second line");
      expect(runtime.consoleLogs.list({ limit: 10 }).items).toHaveLength(2);
      runtime.consoleLogs.clear();
      expect(runtime.consoleLogs.list({ limit: 10 }).items).toHaveLength(0);
    } finally {
      runtime.close();
      removeTempDir(root);
    }
  });

  test("keeps config state and runtime logs/history in separate fast schemas", () => {
    const root = mkdtempSync(join(tmpdir(), "cartethyia-topology-"));
    const persistenceEnv = env(root);
    const config = createConfigPersistence(persistenceEnv);
    config.settings.getSettingsJson();
    const runtime = createRuntimePersistence(persistenceEnv);
    runtime.metadata.querySummary("all");
    runtime.close();
    config.close();

    const configDb = new Database(persistenceEnv.dbPath, { readonly: true });
    const runtimeDb = new Database(persistenceEnv.runtimeDbPath, { readonly: true });
    const configTables = names(configDb, "table");
    const runtimeTables = names(runtimeDb, "table");
    const runtimeIndexes = names(runtimeDb, "index", "request_history").concat(names(runtimeDb, "index", "console_logs"));

    expect(configTables).toContain("settings");
    expect(configTables).not.toContain("request_history");
    expect(configTables).not.toContain("console_logs");
    expect(runtimeTables).toContain("request_history");
    expect(runtimeTables).toContain("console_logs");
    expect(runtimeIndexes).toContain("idx_request_history_status_id");
    expect(runtimeIndexes).toContain("idx_request_history_provider_status_id");
    expect(runtimeIndexes).toContain("idx_console_logs_scope_ts");
    expect(runtimeIndexes).toContain("idx_console_logs_level_ts");

    configDb.close();
    runtimeDb.close();
    removeTempDir(root);
  });
});

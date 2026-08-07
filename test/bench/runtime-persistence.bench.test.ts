import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createRuntimePersistence } from "../../src/storage/runtime/runtime";
import { scaledCount } from "./helpers";
import { removeTempDir } from "../support/temp";

describe("runtime persistence throughput benchmarks", () => {
  test("bounds buffered telemetry when the runtime database is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "cartethyia-runtime-stall-"));
    const blockedPath = join(root, "runtime.sqlite");
    const configPath = join(root, "cartethyia.sqlite");
    mkdirSync(blockedPath);
    const persistence = createRuntimePersistence({
      dataDir: root,
      dbPath: configPath,
      runtimeDbPath: blockedPath,
      assetDir: join(root, "assets"),
      logRetentionDays: 14,
      assetRetentionDays: 7,
      maxFlightsPerIp: 40,
    });
    try {
      for (let index = 0; index < 1_500; index += 1) {
        const telemetry = persistence.telemetry.start({
          requestId: `runtime-stall-${index}`,
          endpoint: "/v1/chat/completions",
          surface: "openai-chat",
          apiKeyId: null,
          apiKeyPrefix: null,
          clientName: "opencode",
          clientSource: "user_agent",
          startedAt: new Date().toISOString(),
          messageCount: 1,
          toolCount: 0,
          imageCount: 0,
        });
        await telemetry.finish({ statusCode: 200, errorKind: null, usage: null, providerId: "fake", model: "model", mode: "non_stream", messageCount: 1, toolCount: 0, imageCount: 0 });
      }
      expect(persistence.pendingWrites()).toBeLessThanOrEqual(1_000);
    } finally {
      persistence.close();
      removeTempDir(root);
    }
  });

  test("handles 10k metadata and runtime-log writes without unbounded buffering", async () => {
    const root = mkdtempSync(join(tmpdir(), "cartethyia-runtime-bench-"));
    const runtimePath = join(root, "runtime.sqlite");
    const configPath = join(root, "cartethyia.sqlite");
    const operations = scaledCount(10_000);
    const persistence = createRuntimePersistence({
      dataDir: root,
      dbPath: configPath,
      runtimeDbPath: runtimePath,
      assetDir: join(root, "assets"),
      logRetentionDays: 14,
      assetRetentionDays: 7,
      maxFlightsPerIp: 40,
    });

    try {
      const started = performance.now();
      await Promise.all(Array.from({ length: operations }, async (_, index) => {
        const telemetry = persistence.telemetry.start({
          requestId: `runtime-bench-${index}`,
          endpoint: "/v1/chat/completions",
          surface: "openai-chat",
          apiKeyId: null,
          apiKeyPrefix: null,
          clientName: "opencode",
          clientSource: "user_agent",
          startedAt: new Date().toISOString(),
          messageCount: 1,
          toolCount: 0,
          imageCount: 0,
        });
        await telemetry.finish({
          statusCode: index % 31 === 0 ? 503 : 200,
          errorKind: index % 31 === 0 ? "provider_unavailable" : null,
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider" },
          providerId: index % 5 === 0 ? "deepseek" : "opencodeft",
          model: index % 5 === 0 ? "deepseek-v4-flash" : "opencodeft-default",
          mode: "non_stream",
          messageCount: 1,
          toolCount: 0,
          imageCount: 0,
        });
        persistence.consoleLogs.push(index % 31 === 0 ? "error" : "info", "runtime-bench", `request-${index}`);
      }));
      persistence.flush();
      const elapsedMs = performance.now() - started;
      const database = new Database(runtimePath, { readonly: true });
      const historyCount = Number((database.query("SELECT COUNT(*) AS count FROM request_history").get() as { count: number }).count);
      const logCount = Number((database.query("SELECT COUNT(*) AS count FROM console_logs").get() as { count: number }).count);
      const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      database.close();

      console.log(JSON.stringify({ benchmark: { scenario: "runtime-persistence-10k", operations, elapsedMs, writesPerSecond: (operations * 2) / Math.max(elapsedMs / 1_000, Number.EPSILON), historyCount, logCount, pendingWrites: persistence.pendingWrites(), tables: tables.map((row) => row.name) } }));
      expect(historyCount).toBe(operations);
      expect(logCount).toBe(operations);
      expect(persistence.pendingWrites()).toBe(0);
      expect(tables.map((row) => row.name)).toEqual(["console_logs", "request_history", "sqlite_sequence", "warp_metrics"]);
      expect(() => readFileSync(configPath)).toThrow();
    } finally {
      persistence.close();
      removeTempDir(root);
    }
  });
});

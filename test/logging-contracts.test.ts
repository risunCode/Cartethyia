import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApplicationLogger } from "../src/console/logger";
import { createConsoleLogStreamHub } from "../src/console/streams";
import { createRuntimePersistence, type RuntimePersistence } from "../src/storage/runtime/runtime";
import type { PersistenceEnv } from "../src/storage/main/env";

let counter = 0;

function makeRuntime(): RuntimePersistence {
  const dataDir = join(tmpdir(), `cartethyia-logging-${process.pid}-${Date.now()}-${counter++}`);
  mkdirSync(dataDir, { recursive: true });
  const env: PersistenceEnv = {
    dataDir,
    dbPath: join(dataDir, "config.sqlite"),
    runtimeDbPath: join(dataDir, "runtime.sqlite"),
    assetDir: join(dataDir, "assets"),
    logRetentionDays: 14,
    assetRetentionDays: 7,
    maxFlightsPerIp: 15,
  };
  return createRuntimePersistence(env);
}

describe("centralized logging", () => {
  test("routes web, request, and system events to canonical scopes", () => {
    const calls: Array<{ level: string; scope: string; message: string }> = [];
    const logger = createApplicationLogger({
      push(level, scope, msg) {
        calls.push({ level, scope, message: msg });
      },
    });

    logger.web("info", "GET /console 200");
    logger.request("warn", "proxy failed");
    logger.system("error", "oauth-refresh", "refresh failed");

    expect(calls).toEqual([
      { level: "info", scope: "web", message: "GET /console 200" },
      { level: "warn", scope: "request", message: "proxy failed" },
      { level: "error", scope: "oauth-refresh", message: "refresh failed" },
    ]);
  });

  test("defaults to non-web logs and keeps web logs separately queryable", () => {
    const runtime = makeRuntime();
    try {
      runtime.consoleLogs.push("info", "web", "dashboard loaded");
      runtime.consoleLogs.push("info", "http", "legacy web access");
      runtime.consoleLogs.push("info", "request", "proxy completed");
      runtime.consoleLogs.push("warn", "oauth-refresh", "refresh failed");
      runtime.flush();

      const all = runtime.consoleLogs.list({ limit: 20 }).items;
      expect(all.every((row) => row.category !== "web")).toBe(true);
      expect(all.map((row) => row.scope)).toEqual(["oauth-refresh", "request"]);

      const web = runtime.consoleLogs.list({ category: "web", limit: 20 }).items;
      expect(web.map((row) => row.scope)).toEqual(["http", "web"]);
      expect(web.every((row) => row.category === "web")).toBe(true);

      const request = runtime.consoleLogs.after(0, 20, { category: "request" });
      expect(request.map((row) => row.scope)).toEqual(["request"]);
    } finally {
      runtime.close();
    }
  });
  test("SSE stream scopes its snapshot to the requested category", async () => {
    const runtime = makeRuntime();
    const hub = createConsoleLogStreamHub({
      latest: (limit, filters) => runtime.consoleLogs.list({ ...filters, limit }).items,
      after: (afterId, limit, filters) => runtime.consoleLogs.after(afterId, limit, filters),
      onPush: (listener) => runtime.consoleLogs.onPush(listener),
    });
    try {
      runtime.consoleLogs.push("info", "web", "dashboard loaded");
      runtime.consoleLogs.push("info", "request", "proxy completed");
      runtime.flush();

      const response = hub.handle(new Request("http://localhost/console-logs/stream?category=web"));
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      if (reader === undefined) return;
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("dashboard loaded");
      expect(text).not.toContain("proxy completed");
      await reader.cancel();
    } finally {
      hub.close();
      runtime.close();
    }
  });
});

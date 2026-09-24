import { beforeEach, describe, expect, test } from "bun:test";
import { createLogRoutes } from "../../../src/console/domains/logs";
import { pushConsoleLog, resetConsoleLogsForTests } from "../../../src/observability/log-ring";
import type { AccessDecision } from "../../../src/security/access-control";

const readerAccess: AccessDecision = {
  id: "test-session",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
  admissionIdentity: "test-session",
};

function appWith(access: AccessDecision | undefined) {
  return createLogRoutes({ accessResolver: () => access });
}

describe("console logs routes", () => {
  beforeEach(() => resetConsoleLogsForTests());

  test("snapshot returns ring lines newest-bounded", async () => {
    pushConsoleLog("info", "boot done");
    pushConsoleLog("error", "boom");
    const response = await appWith(readerAccess).handle(new Request("http://localhost/logs"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lines: Array<{ level: string; msg: string }> };
    expect(body.lines.map((line) => `${line.level}:${line.msg}`)).toEqual([
      "info:boot done",
      "error:boom",
    ]);
  });

  test("snapshot filters by level and clamps limit", async () => {
    pushConsoleLog("info", "a");
    pushConsoleLog("warn", "b");
    pushConsoleLog("warn", "c");
    const filtered = await appWith(readerAccess).handle(
      new Request("http://localhost/logs?level=warn&limit=1"),
    );
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { lines: unknown[] }).lines).toHaveLength(1);
    const bad = await appWith(readerAccess).handle(new Request("http://localhost/logs?level=verbose"));
    expect(bad.status).toBe(400);
  });

  test("snapshot rejects unauthenticated callers", async () => {
    const response = await appWith(undefined).handle(new Request("http://localhost/logs"));
    expect(response.status).toBe(401);
  });

  test("clear empties the ring and audits the action", async () => {
    pushConsoleLog("info", "before clear");
    const recorded: Array<{ action: string; target: string }> = [];
    const app = createLogRoutes({
      accessResolver: () => readerAccess,
      auditSink: {
        record: async (entry) => void recorded.push({ action: entry.action, target: entry.target }),
      },
    });
    const response = await app.handle(
      new Request("http://localhost/logs", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(recorded).toEqual([{ action: "console_logs.cleared", target: "console-logs" }]);
    const after = await app.handle(new Request("http://localhost/logs"));
    expect(((await after.json()) as { lines: unknown[] }).lines).toEqual([]);
  });

  test("stream emits an init snapshot frame first", async () => {
    pushConsoleLog("info", "stream me");
    const response = await appWith(readerAccess).handle(new Request("http://localhost/logs/stream"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: init");
    expect(text).toContain("stream me");
  });

  test("stream rejects unauthenticated callers without opening a stream", async () => {
    const response = await appWith(undefined).handle(new Request("http://localhost/logs/stream"));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearConsoleLogs,
  getConsoleLogSnapshot,
  pushConsoleLog,
  pushStructuredConsoleLog,
  resetConsoleLogsForTests,
  subscribeConsoleLogs,
} from "../../src/observability/log-ring";
import { log } from "../../src/observability/logger";

describe("console log ring", () => {
  beforeEach(() => resetConsoleLogsForTests());

  test("pushes bounded lines and snapshots in order", () => {
    pushConsoleLog("info", "boot complete");
    pushConsoleLog("error", "upstream failed");
    const snapshot = getConsoleLogSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toMatchObject({ level: "info", msg: "boot complete" });
    expect(snapshot[1]).toMatchObject({ level: "error", msg: "upstream failed" });
    expect(typeof snapshot[0]?.ts).toBe("string");
  });

  test("stores structured request metadata alongside the human message", () => {
    pushStructuredConsoleLog("info", "Proxy request completed", {
      event: "request_complete",
      requestId: "req-1",
      endpoint: "/v1/chat/completions",
      model: "cb/deepseek-v4.1-flash",
      providerId: "cb",
      networkPoolId: "pool-1",
      clientIp: "127.0.0.1",
      status: 200,
      durationMs: 123,
      details: { outputTokens: 42 },
    });
    expect(getConsoleLogSnapshot().at(-1)).toMatchObject({
      event: "request_complete",
      requestId: "req-1",
      providerId: "cb",
      networkPoolId: "pool-1",
      clientIp: "127.0.0.1",
      status: 200,
      durationMs: 123,
      details: { outputTokens: 42 },
    });
  });

  test("a request_start line carries model, client IP, and user agent", () => {
    // The ingress stage reads the model from the already-decoded body and the
    // user agent from the request headers, so the console shows what was asked
    // for and who asked — not just the method and path.
    pushStructuredConsoleLog("info", "Incoming proxy request", {
      event: "request_start",
      requestId: "req-start",
      method: "POST",
      endpoint: "/v1/chat/completions",
      model: "grok/grok-4.6",
      clientIp: "203.0.113.9",
      userAgent: "clog-verify/1.0",
    });
    expect(getConsoleLogSnapshot().at(-1)).toMatchObject({
      event: "request_start",
      method: "POST",
      endpoint: "/v1/chat/completions",
      model: "grok/grok-4.6",
      clientIp: "203.0.113.9",
      userAgent: "clog-verify/1.0",
    });
  });

  test("delivers structured metadata to live subscribers, not just snapshots", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeConsoleLogs((event) => {
      if (event.type === "line") received.push(event.line);
    });
    pushStructuredConsoleLog("error", "Proxy request failed", {
      event: "request_error",
      requestId: "req-2",
      providerId: "cb",
      networkPoolId: "pool-2",
      clientIp: "10.0.0.1",
      status: 500,
      durationMs: 99,
      errorCode: "upstream_error",
    });
    unsubscribe();
    expect(received.at(-1)).toMatchObject({
      event: "request_error",
      requestId: "req-2",
      networkPoolId: "pool-2",
      clientIp: "10.0.0.1",
      status: 500,
      errorCode: "upstream_error",
    });
  });

  test("caps the ring and truncates long messages", () => {
    for (let i = 0; i < 600; i++) pushConsoleLog("debug", `line ${i}`);
    const snapshot = getConsoleLogSnapshot();
    expect(snapshot).toHaveLength(500);
    expect(snapshot[0]?.msg).toBe("line 100");
    pushConsoleLog("info", "x".repeat(5000));
    expect(getConsoleLogSnapshot().at(-1)?.msg.length).toBeLessThanOrEqual(2001);
  });

  test("subscribe replays a snapshot then pushes live lines; clear notifies", () => {
    pushConsoleLog("warn", "before");
    const events: string[] = [];
    const unsubscribe = subscribeConsoleLogs((event) => {
      events.push(event.type === "line" ? `line:${event.line.msg}` : event.type);
    });
    pushConsoleLog("info", "live");
    clearConsoleLogs();
    unsubscribe();
    pushConsoleLog("info", "after-unsubscribe");
    expect(events).toEqual(["init", "line:live", "clear"]);
    expect(getConsoleLogSnapshot()).toEqual([
      expect.objectContaining({ level: "info", msg: "after-unsubscribe" }),
    ]);
  });
});

describe("logger facade ring hook", () => {
  beforeEach(() => resetConsoleLogsForTests());

  test("every level lands in the ring with its message", () => {
    log.debug("debug line");
    log.info("info line");
    log.warn("warn line");
    log.error("error line");
    expect(getConsoleLogSnapshot().map((line) => `${line.level}:${line.msg}`)).toEqual([
      "debug:debug line",
      "info:info line",
      "warn:warn line",
      "error:error line",
    ]);
  });

  test("redacts credential material carried by structured args with its category", () => {
    log.error("upstream rejected", new Error("bad"), { headers: { authorization: "Bearer supersecret-token-value" } });
    const line = getConsoleLogSnapshot().at(-1)?.msg ?? "";
    expect(line).not.toContain("supersecret-token-value");
    expect(line).toContain("***REDACTED***[secret-key]");
  });

  test("survives circular args without throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => log.info("circular check", circular)).not.toThrow();
    expect(getConsoleLogSnapshot().at(-1)?.msg).toContain("[circular]");
  });
});

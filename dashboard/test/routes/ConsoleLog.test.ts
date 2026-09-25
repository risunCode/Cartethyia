import { describe, expect, test } from "bun:test";
import { filterLogLines, statusTone } from "../../src/routes/ConsoleLog";
import type { ConsoleLogEntry } from "../../src/lib/hooks/logs";

function line(partial: Partial<ConsoleLogEntry>): ConsoleLogEntry {
  return {
    id: partial.id ?? "l1",
    ts: partial.ts ?? "2026-09-20T12:00:00.000Z",
    level: partial.level ?? "info",
    msg: partial.msg ?? "message",
    ...partial,
  };
}

describe("filterLogLines", () => {
  const lines: ConsoleLogEntry[] = [
    line({ id: "a", level: "debug", msg: "debug line" }),
    line({ id: "b", level: "info", msg: "info line" }),
    line({ id: "c", level: "warn", msg: "warn line" }),
    line({ id: "d", level: "error", msg: "error line" }),
  ];

  test("a level selection actually filters", () => {
    // Regression pin: the level predicate was computed but never applied, so
    // picking "Info" still showed debug/warn/error rows.
    expect(filterLogLines(lines, "info", "").map((l) => l.id)).toEqual(["b"]);
    expect(filterLogLines(lines, "error", "").map((l) => l.id)).toEqual(["d"]);
    expect(filterLogLines(lines, "debug", "").map((l) => l.id)).toEqual(["a"]);
  });

  test("`all` keeps every level", () => {
    expect(filterLogLines(lines, "all", "").map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("level and search compose", () => {
    const mixed: ConsoleLogEntry[] = [
      line({ id: "x", level: "info", msg: "grok request" }),
      line({ id: "y", level: "error", msg: "grok failure" }),
      line({ id: "z", level: "info", msg: "muse request" }),
    ];
    expect(filterLogLines(mixed, "info", "grok").map((l) => l.id)).toEqual(["x"]);
    expect(filterLogLines(mixed, "all", "grok").map((l) => l.id)).toEqual(["x", "y"]);
  });

  test("search matches structured fields, not just the message", () => {
    const structured: ConsoleLogEntry[] = [
      line({ id: "s1", event: "request_complete", msg: "Proxy request completed", providerId: "grok", model: "grok-4.6", clientIp: "203.0.113.9", accountLabel: "aria@example.com" }),
      line({ id: "s2", event: "request_complete", msg: "Proxy request completed", providerId: "cb" }),
    ];
    expect(filterLogLines(structured, "all", "grok-4.6").map((l) => l.id)).toEqual(["s1"]);
    expect(filterLogLines(structured, "all", "203.0.113").map((l) => l.id)).toEqual(["s1"]);
    expect(filterLogLines(structured, "all", "aria@").map((l) => l.id)).toEqual(["s1"]);
    expect(filterLogLines(structured, "all", "cb").map((l) => l.id)).toEqual(["s2"]);
  });

  test("an empty search does not filter", () => {
    expect(filterLogLines(lines, "all", "").length).toBe(4);
  });
});

describe("statusTone", () => {
  test("maps status classes to badge tones", () => {
    expect(statusTone(200)).toBe("ok");
    expect(statusTone(204)).toBe("ok");
    expect(statusTone(404)).toBe("warn");
    expect(statusTone(429)).toBe("warn");
    expect(statusTone(500)).toBe("err");
    expect(statusTone(503)).toBe("err");
  });
});


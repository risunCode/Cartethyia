import { describe, expect, test } from "vitest";
import { levelMatches, normalizeLogEntry } from "../../../src/components/shared/log-types";

describe("normalizeLogEntry", () => {
  test("returns null for payloads that are not objects", () => {
    expect(normalizeLogEntry(null, "fb-1")).toBeNull();
    expect(normalizeLogEntry(undefined, "fb-1")).toBeNull();
    expect(normalizeLogEntry("error", "fb-1")).toBeNull();
    expect(normalizeLogEntry(42, "fb-1")).toBeNull();
    expect(normalizeLogEntry(false, "fb-1")).toBeNull();
  });

  test("keeps a fully formed entry untouched", () => {
    const entry = normalizeLogEntry(
      { id: "log-1", timestamp: "2026-01-01T00:00:00.000Z", level: "warn", source: "proxy.core", message: "upstream slow" },
      "fb-1",
    );

    expect(entry).toEqual({
      id: "log-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "warn",
      source: "proxy.core",
      message: "upstream slow",
    });
  });

  test("normalizes level casing and falls back to info for unknown levels", () => {
    expect(normalizeLogEntry({ level: "ERROR" }, "fb-1")?.level).toBe("error");
    expect(normalizeLogEntry({ level: "Warn" }, "fb-1")?.level).toBe("warn");
    expect(normalizeLogEntry({ level: "verbose" }, "fb-1")?.level).toBe("info");
    expect(normalizeLogEntry({ level: 7 }, "fb-1")?.level).toBe("info");
    expect(normalizeLogEntry({}, "fb-1")?.level).toBe("info");
  });

  test("bounds the message to 4096 characters", () => {
    const long = "x".repeat(5_000);
    const entry = normalizeLogEntry({ message: long }, "fb-1");

    expect(entry?.message).toHaveLength(4_096);
    expect(entry?.message).toBe("x".repeat(4_096));
  });

  test("stringifies non-string messages instead of crashing", () => {
    expect(normalizeLogEntry({ message: 123 }, "fb-1")?.message).toBe("123");
    expect(normalizeLogEntry({ message: true }, "fb-1")?.message).toBe("true");
    expect(normalizeLogEntry({ message: null }, "fb-1")?.message).toBe("");
  });

  test("bounds the source field and defaults missing sources to system", () => {
    expect(normalizeLogEntry({ source: "s".repeat(200) }, "fb-1")?.source).toHaveLength(128);
    expect(normalizeLogEntry({ source: "" }, "fb-1")?.source).toBe("system");
    expect(normalizeLogEntry({}, "fb-1")?.source).toBe("system");
    expect(normalizeLogEntry({ source: 42 }, "fb-1")?.source).toBe("system");
  });

  test("stamps the current time when the timestamp is missing or malformed", () => {
    const before = Date.now();
    const missing = normalizeLogEntry({}, "fb-1");
    const malformed = normalizeLogEntry({ timestamp: 12345 }, "fb-1");

    const missingAt = Date.parse(missing?.timestamp ?? "");
    const malformedAt = Date.parse(malformed?.timestamp ?? "");
    expect(missingAt).toBeGreaterThanOrEqual(before);
    expect(Number.isNaN(malformedAt)).toBe(false);
  });

  test("uses the fallback id only when the payload id is unusable", () => {
    expect(normalizeLogEntry({ id: "log-9" }, "fb-1")?.id).toBe("log-9");
    expect(normalizeLogEntry({ id: 42 }, "fb-1")?.id).toBe("42");
    expect(normalizeLogEntry({}, "fb-1")?.id).toBe("fb-1");
    expect(normalizeLogEntry({ id: true }, "fb-1")?.id).toBe("fb-1");
    expect(normalizeLogEntry({ id: null }, "fb-1")?.id).toBe("fb-1");
  });
});

describe("levelMatches", () => {
  test("debug as the minimum admits every level", () => {
    expect(levelMatches("debug", "debug")).toBe(true);
    expect(levelMatches("debug", "info")).toBe(true);
    expect(levelMatches("debug", "warn")).toBe(true);
    expect(levelMatches("debug", "error")).toBe(true);
  });

  test("info hides debug entries only", () => {
    expect(levelMatches("info", "debug")).toBe(false);
    expect(levelMatches("info", "info")).toBe(true);
    expect(levelMatches("info", "warn")).toBe(true);
    expect(levelMatches("info", "error")).toBe(true);
  });

  test("warn and error progressively narrow the window", () => {
    expect(levelMatches("warn", "info")).toBe(false);
    expect(levelMatches("warn", "warn")).toBe(true);
    expect(levelMatches("warn", "error")).toBe(true);
    expect(levelMatches("error", "warn")).toBe(false);
    expect(levelMatches("error", "error")).toBe(true);
  });
});

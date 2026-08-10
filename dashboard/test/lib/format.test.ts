import { describe, expect, test } from "vitest";
import { formatDuration, formatMemoryMb, formatNumber, formatTime, formatTokens, formatUptime, formatUsd } from "../../src/lib/format";

describe("formatNumber", () => {
  test("renders an em-dash for null/undefined instead of a bare 0 or NaN", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
  });

  test("groups thousands with commas", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  test("renders 0 as an explicit \"0\", not the null placeholder", () => {
    expect(formatNumber(0)).toBe("0");
  });
});

describe("formatTokens", () => {
  test("picks the largest unit whose threshold the value clears (K/M/B/T), not just >=1000", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000_000)).toBe("2.0B");
    expect(formatTokens(3_400_000_000_000)).toBe("3.4T");
  });

  test("renders an em-dash for null/undefined", () => {
    expect(formatTokens(null)).toBe("—");
  });
});

describe("formatDuration", () => {
  test("sub-second durations render as whole milliseconds", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("durations at or above 1000ms switch to seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(4500)).toBe("4.5s");
  });
});

describe("formatMemoryMb", () => {
  test("stays in MB below the 1024 GB threshold", () => {
    expect(formatMemoryMb(512)).toBe("512 MB");
  });

  test("switches to GB at exactly 1024 MB, not just \"eventually\"", () => {
    expect(formatMemoryMb(1024)).toBe("1.0 GB");
    expect(formatMemoryMb(16_088)).toBe("15.7 GB");
  });
});

describe("formatUsd", () => {
  test("renders exactly 0 as an em-dash, distinguishing \"no estimate\" from a confirmed $0.00", () => {
    expect(formatUsd(0)).toBe("—");
    expect(formatUsd(null)).toBe("—");
  });

  test("sub-cent amounts get 4 decimal places instead of rounding to $0.00", () => {
    expect(formatUsd(0.0034)).toBe("$0.0034");
  });

  test("amounts at or above a cent use standard 2-decimal currency formatting", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});

describe("formatUptime", () => {
  test("picks the coarsest two units: days+hours, hours+minutes, minutes+seconds, or bare seconds", () => {
    expect(formatUptime(5)).toBe("5s");
    expect(formatUptime(65)).toBe("1m 05s");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(90000)).toBe("1d 1h");
  });

  test("treats negative or non-finite values as unavailable, not a bogus duration", () => {
    expect(formatUptime(-1)).toBe("—");
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
  });
});

describe("formatTime", () => {
  test("returns an em-dash for a missing timestamp instead of throwing on Date parsing", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
  });

  test("returns the original string for an unparseable timestamp instead of \"Invalid Date\"", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });

  test("accepts both a space-separated SQLite timestamp and a proper ISO string", () => {
    // Both forms are treated as UTC; formatTime renders in the local zone, so
    // this only asserts the two input shapes produce the SAME output instead
    // of pinning a zone-dependent clock string.
    const spaceForm = formatTime("2026-01-01 12:00:00");
    const isoForm = formatTime("2026-01-01T12:00:00Z");
    expect(spaceForm).toBe(isoForm);
  });
});

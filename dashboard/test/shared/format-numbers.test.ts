/**
 * Numeric display policy.
 *
 * These are the numbers an operator reads, and they replaced four disagreeing
 * per-route copies — so the assertions are about the *policy*, not about string
 * output for its own sake. Two rules are load-bearing:
 *
 * - **absent vs zero.** A missing value renders `—`; a measured zero renders
 *   `0`. Collapsing them made "no data yet" indistinguishable from "none",
 *   which is the difference between waiting and investigating.
 * - **the viewer's locale.** Separators are grouped by the reader's locale, so
 *   `4.093,36` and `4,093.36` are both correct for their reader. Every test
 *   pins an explicit locale, because a test that followed the machine's locale
 *   would pass in one CI image and fail in another.
 */
import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  formatCredits,
  formatDuration,
  formatNumber,
  formatProbeDuration,
  formatUptime,
} from "../../src/lib/format/numbers";

/** A locale with `,` thousands and `.` decimals, pinned for determinism. */
const EN = "en-US";
/** A locale with `.` thousands and `,` decimals — the mirror reading. */
const DE = "de-DE";

describe("formatBytes", () => {
  test("scales B / KB / MB with one decimal above the base unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  test("the unit ladder reaches GB and TB", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    // Past a terabyte the ladder stops dividing rather than running off its end.
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
  });

  test("rounds below the base unit rather than showing a fraction of a byte", () => {
    expect(formatBytes(0.4)).toBe("0 B");
    expect(formatBytes(1023.6)).toBe("1024 B");
  });

  test("a boundary value takes the coarser unit", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  test("renders the placeholder only for absent or non-finite values", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
    // Zero is a measurement: a proxy pool that moved no bytes is a fact.
    expect(formatBytes(0)).toBe("0 B");
  });

  test("a negative value is rendered, not clamped to zero", () => {
    // A negative byte count means the accounting is wrong upstream; hiding it
    // as `0 B` would make the defect invisible. `formatBytes` compares with
    // `<`, so a negative falls into the base-unit branch and keeps its sign.
    expect(formatBytes(-1024)).toBe("-1024 B");
    expect(formatBytes(-1536)).toBe("-1536 B");
  });
});

describe("formatDuration", () => {
  test("uses ms below a second and s above", () => {
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(1500)).toBe("1.5 s");
  });

  test("the boundary is exactly one second", () => {
    expect(formatDuration(999.9)).toBe("1000 ms");
  });

  test("renders the placeholder for absent or non-finite values", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(0)).toBe("0 ms");
  });
});

describe("formatProbeDuration", () => {
  test("uses compact ms below a second and s above, with no space", () => {
    // Probe badges sit inline next to model ids, so they carry no unit space.
    expect(formatProbeDuration(250)).toBe("250ms");
    expect(formatProbeDuration(999.4)).toBe("999ms");
    expect(formatProbeDuration(1000)).toBe("1.0s");
    expect(formatProbeDuration(1234)).toBe("1.2s");
  });
});

describe("formatUptime", () => {
  test("drops zero units rather than printing them", () => {
    // "1d 0h" reads as a measurement of the hour; "1d" is what happened.
    expect(formatUptime(86_400)).toBe("1d 0h");
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(60)).toBe("1m 0s");
    expect(formatUptime(7)).toBe("7s");
  });

  test("shows the two largest units only", () => {
    // A five-unit uptime is unreadable in a footer; the two largest carry the
    // meaning a reader needs.
    expect(formatUptime(90_061)).toBe("1d 1h");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(61)).toBe("1m 1s");
  });

  test("a negative uptime clamps to zero instead of rendering a negative day", () => {
    // Clock skew between the process and its start timestamp can produce a
    // small negative; the honest display is "just started".
    expect(formatUptime(-5)).toBe("0s");
  });

  test("renders the placeholder for absent or non-finite values", () => {
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(Number.NaN)).toBe("—");
    expect(formatUptime(0)).toBe("0s");
  });
});

describe("formatNumber", () => {
  test("rounds to a whole number", () => {
    expect(formatNumber(1.4, EN)).toBe("1");
    expect(formatNumber(1.6, EN)).toBe("2");
  });

  test("groups by the viewer's locale", () => {
    // The point of the locale parameter: the same value reads correctly for
    // both conventions rather than being ambiguous to one of them.
    expect(formatNumber(1234567.89, EN)).toBe("1,234,568");
    expect(formatNumber(1234567.89, DE)).toBe("1.234.568");
  });

  test("renders the placeholder for absent or non-finite values", () => {
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatNumber(0, EN)).toBe("0");
  });

  test("handles a negative count", () => {
    expect(formatNumber(-1234, EN)).toBe("-1,234");
  });
});

describe("formatCredits", () => {
  test("keeps two fraction digits without padding whole amounts", () => {
    // Credits are money: `1234.56` must not round to `1235`, and a whole
    // amount must not grow a `.00` an operator has to read past.
    expect(formatCredits(1234.56, EN)).toBe("1,234.56");
    expect(formatCredits(1234, EN)).toBe("1,234");
  });

  test("groups by the viewer's locale", () => {
    expect(formatCredits(4093.36, EN)).toBe("4,093.36");
    expect(formatCredits(4093.36, DE)).toBe("4.093,36");
  });

  test("rounds beyond two fraction digits", () => {
    expect(formatCredits(1.005, EN)).toBe("1.01");
    expect(formatCredits(1.004, EN)).toBe("1");
  });

  test("renders the placeholder for absent or non-finite values", () => {
    expect(formatCredits(undefined)).toBe("—");
    expect(formatCredits(Number.NaN)).toBe("—");
    expect(formatCredits(0, EN)).toBe("0");
  });

  test("a negative balance is preserved, not clamped", () => {
    // A provider that over-billed produces a real negative; hiding it would
    // make the credit pool look healthy.
    expect(formatCredits(-12.5, EN)).toBe("-12.5");
  });
});

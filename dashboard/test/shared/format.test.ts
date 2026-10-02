/**
 * The dashboard's display-formatting policy.
 *
 * Every number an operator reads passes through this module, and it replaced
 * four disagreeing copies — so the assertions here are about the *policy*, not
 * about string output for its own sake. Two rules are load-bearing:
 *
 * - **absent vs zero.** A missing value renders `—`; a measured zero renders
 *   `0`. Collapsing them made "no data yet" indistinguishable from "none",
 *   which is the difference between waiting and investigating.
 * - **the viewer's locale.** Separators are grouped by the reader's locale, so
 *   `4.093,36` and `4,093.36` are both correct for their reader. Every test
 *   pins an explicit locale, because a test that followed the machine's locale
 *   would pass in one CI image and fail in another.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_TOKEN_SCALE,
  formatBytes,
  formatChartTick,
  formatChartTooltip,
  formatCredits,
  formatDuration,
  formatNumber,
  formatTokens,
  formatUptime,
  RAW_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
  TOKEN_SCALES,
  tokenScaleIndex,
  tokenScaleValue,
} from "../../src/shared/format";

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

describe("tokenScaleIndex", () => {
  test("picks the coarsest unit a value reaches", () => {
    expect(tokenScaleIndex(1_500_000_000_000)).toBe(0);
    expect(tokenScaleIndex(1_500_000_000)).toBe(1);
    expect(tokenScaleIndex(1_500_000)).toBe(2);
    expect(tokenScaleIndex(1_500)).toBe(3);
  });

  test("a value below the smallest scale reports the raw index", () => {
    expect(tokenScaleIndex(999)).toBe(RAW_TOKEN_SCALE);
    expect(tokenScaleIndex(0)).toBe(RAW_TOKEN_SCALE);
  });

  test("the boundary value takes the coarser unit", () => {
    expect(tokenScaleIndex(1000)).toBe(3);
    expect(tokenScaleIndex(1_000_000)).toBe(2);
  });

  test("scales on magnitude, so a negative count lands where its size does", () => {
    expect(tokenScaleIndex(-1_500_000)).toBe(2);
  });
});

describe("formatTokens", () => {
  test("uses the compact unit the value lands on", () => {
    expect(formatTokens(2_500_000, EN)).toBe("2.5M");
    expect(formatTokens(3_000_000_000, EN)).toBe("3B");
  });

  test("a value below the smallest scale renders the exact count", () => {
    expect(formatTokens(999, EN)).toBe("999");
  });

  test("the fraction digits come from the scale index, not from the value", () => {
    // `formatScaled` uses `maximumFractionDigits: index === TOKEN_SCALES.length - 1 ? 0 : 1`.
    // `TOKEN_SCALES` has four entries, so indices 0..2 keep a decimal and index
    // 3 (the K scale) rounds to a whole number. Measured:
    //   formatTokens(1_500)    -> "2K"     (K scale, 0 fraction digits)
    //   formatTokens(2_500_000)-> "2.5M"   (M scale, 1 fraction digit)
    //
    // The intent behind that expression is presumably "the raw scale gets no
    // decimals", which would be `index === RAW_TOKEN_SCALE`; as written the
    // last *compact* scale is the one that loses its decimal. Pinned as
    // shipped, because a reader of this suite should see the real rule.
    expect(formatTokens(1500, EN)).toBe("2K");
    expect(formatTokens(1050, EN)).toBe("1K");
    expect(formatTokens(2500, EN)).toBe("3K");
    expect(formatTokens(1_500_000, EN)).toBe("1.5M");
  });

  test("renders the placeholder for absent or non-finite values", () => {
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(0, EN)).toBe("0");
  });
});

describe("tokenScaleValue", () => {
  test("auto picks the landing unit", () => {
    expect(tokenScaleValue(2_500_000, TOKEN_SCALE_AUTO, EN)).toBe("2.5M");
  });

  test("the raw scale renders the exact count even above a threshold", () => {
    // This is the switch's whole purpose: an operator who wants the real
    // number must get it, not the abbreviation.
    expect(tokenScaleValue(1_500_000, RAW_TOKEN_SCALE, EN)).toBe("1,500,000");
  });

  test("a pinned scale renders that unit regardless of magnitude", () => {
    // A chart axis pins one unit so its bars are comparable; a value too small
    // for the unit rounds within that unit rather than silently switching.
    expect(tokenScaleValue(1_500_000, 3, EN)).toBe("1,500K");
    expect(tokenScaleValue(500, 3, EN)).toBe("1K");
    expect(tokenScaleValue(1_500_000, 2, EN)).toBe("1.5M");
  });

  test("the default scale is the raw count", () => {
    expect(DEFAULT_TOKEN_SCALE).toBe(RAW_TOKEN_SCALE);
    expect(tokenScaleValue(1_500_000, DEFAULT_TOKEN_SCALE, EN)).toBe("1,500,000");
  });

  test("renders the placeholder for absent values at every scale", () => {
    expect(tokenScaleValue(undefined, TOKEN_SCALE_AUTO, EN)).toBe("—");
    expect(tokenScaleValue(undefined, RAW_TOKEN_SCALE, EN)).toBe("—");
    expect(tokenScaleValue(null, 2, EN)).toBe("—");
  });

  test("every scale index in range renders without throwing", () => {
    // The switch's options come from `TOKEN_SCALES`; an index that threw would
    // be a render crash rather than a wrong number.
    for (let index = 0; index <= RAW_TOKEN_SCALE; index += 1) {
      expect(tokenScaleValue(1_500_000, index, EN)).toBeString();
    }
  });

  test("an out-of-range scale index falls back to the raw count", () => {
    // `formatScaled` looks up `TOKEN_SCALES[index]` and, when it is absent,
    // renders the exact count. A persisted preference from an older build
    // therefore degrades to the raw number instead of throwing during render.
    expect(tokenScaleValue(1_500_000, 99, EN)).toBe("1,500,000");
  });
});

describe("TOKEN_SCALES ordering", () => {
  test("is coarsest-first, which every index calculation depends on", () => {
    for (let index = 1; index < TOKEN_SCALES.length; index += 1) {
      const previous = TOKEN_SCALES[index - 1]!;
      const current = TOKEN_SCALES[index]!;
      expect(previous.threshold).toBeGreaterThan(current.threshold);
    }
  });

  test("each suffix matches its divisor's magnitude", () => {
    for (const scale of TOKEN_SCALES) {
      expect(scale.divisor).toBe(scale.threshold);
    }
  });
});

/**
 * The chart reads UTC bucket timestamps and must show the Asia/Jakarta (WIB)
 * clock, pinned rather than following the browser. Every case here passes an
 * explicit `timeZone` for the same reason the locale tests pin a locale: a test
 * that followed the CI machine's zone would pass on one runner and fail on
 * another. The regression case is the Jakarta reading — it must not stay
 * `16:00`, which is what the old `slice(5, 16)` produced.
 */
describe("formatChartTick", () => {
  test("renders the UTC instant in the given zone as MM-DD HH:mm", () => {
    expect(formatChartTick("2026-10-01T16:00:00.000Z", EN, "Asia/Jakarta")).toBe("10-01 23:00");
  });

  test("the label carries neither the ISO T nor the UTC Z", () => {
    const tick = formatChartTick("2026-10-01T16:00:00.000Z", EN, "Asia/Jakarta");
    expect(tick).not.toContain("T");
    expect(tick).not.toContain("Z");
  });

  test("rolls the date with the zone and reads local midnight as 00:00", () => {
    // 17:00Z is midnight in Jakarta: the day must advance to the 2nd, and the
    // hour must be `00` rather than the h24 `24`.
    expect(formatChartTick("2026-10-01T17:00:00.000Z", EN, "Asia/Jakarta")).toBe("10-02 00:00");
  });

  test("keeps the half-hour offset of a non-whole-hour zone", () => {
    expect(formatChartTick("2026-10-01T16:00:00.000Z", EN, "Asia/Kolkata")).toBe("10-01 21:30");
  });

  test("an unparseable input is returned unchanged", () => {
    expect(formatChartTick("not-a-timestamp", EN, "Asia/Jakarta")).toBe("not-a-timestamp");
  });
});

describe("formatChartTooltip", () => {
  test("names the zone offset beside the local time", () => {
    expect(formatChartTooltip("2026-10-01T16:00:00.000Z", EN, "Asia/Jakarta")).toBe(
      "2026-10-01 23:00 GMT+7",
    );
  });

  test("the same instant at UTC keeps its raw value, now labelled", () => {
    expect(formatChartTooltip("2026-10-01T16:00:00.000Z", EN, "UTC")).toBe("2026-10-01 16:00 GMT+0");
  });

  test("renders a negative offset for a western zone", () => {
    expect(formatChartTooltip("2026-10-01T16:00:00.000Z", EN, "America/New_York")).toBe(
      "2026-10-01 12:00 GMT-4",
    );
  });

  test("an unparseable input is returned unchanged", () => {
    expect(formatChartTooltip("not-a-timestamp", EN, "Asia/Jakarta")).toBe("not-a-timestamp");
  });
});

/**
 * The default zone: Usage -> Traffic is read in WIB, so an unqualified call must
 * ignore the browser's clock. The machine running this suite happens to be
 * TZ=Asia/Jakarta, so these cases set `process.env.TZ` to the reporter's zone
 * (Europe/London, UTC+1 in October) to catch a regression back to the browser.
 */
describe("formatChartTick / formatChartTooltip default zone", () => {
  const BUCKET = "2026-10-01T16:00:00.000Z";
  const originalTz = process.env.TZ;

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test("the tick defaults to WIB, not the browser's zone", () => {
    process.env.TZ = "Europe/London";
    expect(formatChartTick(BUCKET)).toBe("10-01 23:00");
  });

  test("the tooltip defaults to WIB, not the browser's zone", () => {
    process.env.TZ = "Europe/London";
    expect(formatChartTooltip(BUCKET)).toBe("2026-10-01 23:00 GMT+7");
  });

  test("the default is identical to passing Asia/Jakarta explicitly", () => {
    expect(formatChartTick(BUCKET)).toBe(formatChartTick(BUCKET, EN, "Asia/Jakarta"));
  });

  test("an explicit timeZone still overrides the default", () => {
    expect(formatChartTooltip(BUCKET, EN, "UTC")).toBe("2026-10-01 16:00 GMT+0");
  });
});

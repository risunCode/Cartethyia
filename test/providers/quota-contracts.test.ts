import { describe, expect, test } from "bun:test";
import { totalRemainingCredit, totalRemainingPercent, type ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

const window = (value: Partial<ProviderQuotaWindow>): ProviderQuotaWindow => ({
  kind: "test",
  label: "Test",
  accounting: "independent",
  usedPercent: null,
  remainingPercent: null,
  resetsAt: null,
  ...value,
});

describe("absolute quota credit accounting", () => {
  test("uses absolute remaining and used values", () => {
    expect(
      totalRemainingCredit([
        window({ accounting: "pooled", limit: 100, remaining: 70 }),
        window({ accounting: "pooled", limit: 50, used: 10 }),
      ]),
    ).toBe(110);
  });

  test("ignores percentage-only windows", () => {
    expect(totalRemainingCredit([window({ limit: 100, usedPercent: 25 })])).toBeNull();
  });

  test("does not add independent usage limits to pooled credits", () => {
    expect(totalRemainingCredit([
      window({ accounting: "pooled", limit: 500, used: 441.7 }),
      window({ accounting: "pooled", limit: 10, used: 10 }),
      window({ limit: 21_600, used: 21_600, remainingPercent: 0 }),
    ])).toBeCloseTo(58.3);
  });
});

describe("percent quota remaining accounting", () => {
  test("takes the lowest remaining percent across windows", () => {
    expect(
      totalRemainingPercent([
        window({ remainingPercent: 80 }),
        window({ remainingPercent: 35 }),
      ]),
    ).toBe(35);
  });

  test("sums credit buckets before calculating their remaining percent", () => {
    expect(
      totalRemainingPercent([
        window({ accounting: "pooled", usedPercent: 88.34, remainingPercent: 11.66, limit: 500, used: 441.7 }),
        window({ accounting: "pooled", usedPercent: 100, remainingPercent: 0, limit: 10, used: 10 }),
      ]),
    ).toBeCloseTo((58.3 / 510) * 100);
  });

  test("keeps percentage-only windows as independent constraints beside credits", () => {
    expect(
      totalRemainingPercent([
        window({ accounting: "pooled", limit: 500, used: 441.7 }),
        window({ accounting: "pooled", limit: 10, used: 10 }),
        window({ remainingPercent: 5 }),
      ]),
    ).toBe(5);
  });

  test("derives percent from credit balances and clamps reported percentages", () => {
    expect(totalRemainingPercent([window({ accounting: "pooled", limit: 100, remaining: 70 })])).toBe(70);
    expect(totalRemainingPercent([window({ remainingPercent: 140 })])).toBe(100);
    expect(totalRemainingPercent([window({ remainingPercent: -5 })])).toBe(0);
  });
});

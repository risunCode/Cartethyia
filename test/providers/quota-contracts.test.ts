import { describe, expect, test } from "bun:test";
import { totalRemainingCredit, totalRemainingPercent, type ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

const window = (value: Partial<ProviderQuotaWindow>): ProviderQuotaWindow => ({
  kind: "test",
  label: "Test",
  usedPercent: null,
  remainingPercent: null,
  resetsAt: null,
  ...value,
});

describe("absolute quota credit accounting", () => {
  test("uses absolute remaining and used values", () => {
    expect(
      totalRemainingCredit([
        window({ limit: 100, remaining: 70 }),
        window({ limit: 50, used: 10 }),
      ]),
    ).toBe(110);
  });

  test("ignores percentage-only windows", () => {
    expect(totalRemainingCredit([window({ limit: 100, usedPercent: 25 })])).toBeNull();
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

  test("ignores windows without a percent figure and clamps to 0-100", () => {
    expect(totalRemainingPercent([window({ limit: 100, remaining: 70 })])).toBeNull();
    expect(totalRemainingPercent([window({ remainingPercent: 140 })])).toBe(100);
    expect(totalRemainingPercent([window({ remainingPercent: -5 })])).toBe(0);
  });
});

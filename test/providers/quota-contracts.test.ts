import { describe, expect, test } from "bun:test";
import { totalRemainingCredit, type ProviderQuotaWindow } from "../../src/providers/quota/quota-contracts";

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

import { describe, expect, test } from "bun:test";
import { assertProviderRouting } from "../../src/lib/api/validators";

const routing = {
  providerId: "inferhub",
  tenantId: null,
  strategy: "fallback",
  rotateCount: 1,
  maxInflight: null,
  usageFloor: null,
  usageFloorUnit: "percent",
  enabled: true,
  bypassProxy: true,
};

describe("assertProviderRouting", () => {
  test("an empty identity is a saved None, not a broken response", () => {
    expect(assertProviderRouting({ ...routing, userAgent: "" }).userAgent).toBe("");
  });

  test("a selected identity still loads", () => {
    expect(assertProviderRouting({ ...routing, userAgent: "Cartethyia/2.1" }).userAgent).toBe(
      "Cartethyia/2.1",
    );
  });
});

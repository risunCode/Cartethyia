import { describe, expect, test } from "bun:test";

import { assertProviderRouting } from "./common";

describe("assertProviderRouting", () => {
  test("rejects a non-numeric maxInflight", () => {
    expect(() =>
      assertProviderRouting({
        providerId: "openai",
        strategy: "round_robin",
        rotateCount: 1,
        enabled: true,
        maxInflight: "8",
        bypassProxy: false,
      }),
    ).toThrow("Invalid provider routing response");
  });

  test("accepts maxInflight null with a boolean bypassProxy", () => {
    const result = assertProviderRouting({
      providerId: "openai",
      strategy: "round_robin",
      rotateCount: 1,
      enabled: true,
      maxInflight: null,
      bypassProxy: false,
    });
    expect(result.maxInflight).toBeNull();
    expect(result.bypassProxy).toBe(false);
  });
  test("rejects a response without rotateCount", () => {
    expect(() =>
      assertProviderRouting({
        providerId: "openai",
        strategy: "round_robin",
        enabled: true,
        maxInflight: null,
        bypassProxy: false,
      }),
    ).toThrow("Invalid provider routing response");
  });
});

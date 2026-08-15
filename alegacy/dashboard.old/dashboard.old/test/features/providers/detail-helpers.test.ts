import { describe, expect, test } from "vitest";
import { ApiError } from "../../../src/lib/api";
import { errorMessage, selectAccountTestModel } from "../../../src/features/providers/detail-helpers";

describe("provider detail helpers", () => {
  test("prefers the provider-specific connection test model", () => {
    const models = [{ id: "gpt-5" }, { id: "gpt-5.4-mini" }];

    expect(selectAccountTestModel("codex", models)).toEqual({ id: "gpt-5.4-mini" });
    expect(selectAccountTestModel("openai", models)).toEqual({ id: "gpt-5" });
    expect(selectAccountTestModel("openai", [])).toBeUndefined();
  });

  test("keeps known error messages and uses a safe fallback", () => {
    expect(errorMessage(new ApiError(502, "upstream", "Provider unavailable"))).toBe("Provider unavailable");
    expect(errorMessage(new Error("Network failed"))).toBe("Network failed");
    expect(errorMessage({ message: "not an Error instance" })).toBe("request failed");
  });
});

import { describe, expect, test } from "vitest";
import { formatQuotaWindowLabel, formatResetDistance, friendlyQuotaError } from "../../../src/features/quota/formatters";

describe("quota display formatters", () => {
  test("uses named windows and converts hour labels to days", () => {
    expect(formatQuotaWindowLabel("168 Hour")).toBe("Weekly");
    expect(formatQuotaWindowLabel("167 hour")).toBe("6d 23h");
    expect(formatQuotaWindowLabel("720 hour")).toBe("Monthly");
  });

  test("does not render placeholder punctuation for missing reset times", () => {
    expect(formatResetDistance(null)).toBe("");
  });
  test("prioritizes OAuth invalidation over quota wording", () => {
    expect(friendlyQuotaError("OAuth account invalidated; reauthorization required")).toBe("OAuth account invalidated — re-login required");
  });
});

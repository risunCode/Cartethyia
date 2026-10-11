import { describe, expect, test } from "bun:test";
import { accountErrorLabel } from "../../src/lib/format/labels";

/**
 * The account pill used to render the raw category, so a quota endpoint that
 * failed showed `quota_fetch_failed` — a machine value an operator cannot act
 * on. The label has to say what is wrong.
 */
describe("accountErrorLabel", () => {
  test("a quota fetch failure reads as the quota surface being unreachable", () => {
    expect(accountErrorLabel("quota_fetch_failed")).toBe("Quota unreachable");
  });

  test("a revoked credential says what the operator must do", () => {
    expect(accountErrorLabel("auth_invalidated")).toBe("Re-login required");
  });

  test("an unknown category is shown as-is rather than hidden", () => {
    expect(accountErrorLabel("something_new")).toBe("something_new");
  });
});

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

  test("a revoked OAuth credential says to re-login", () => {
    expect(accountErrorLabel("auth_invalidated", "oauth")).toBe("Re-login required");
  });

  test("a revoked API key says to replace the key, not re-login", () => {
    // A BYOK key has no login to return to; telling the operator to re-login
    // sends them after a sign-in button their provider does not have.
    expect(accountErrorLabel("auth_invalidated", "api_key")).toBe("Replace API key");
  });

  test("an unlabelled revoked credential still avoids a login instruction", () => {
    expect(accountErrorLabel("auth_invalidated")).not.toMatch(/login/i);
  });

  test("an unknown category is shown as-is rather than hidden", () => {
    expect(accountErrorLabel("something_new")).toBe("something_new");
  });
});

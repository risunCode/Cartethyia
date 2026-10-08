/**
 * A buddy-family channel rejection must park the account.
 *
 * `11128` ("Illegal API invocation from an unapproved channel") is the
 * upstream refusing the calling channel for a whole account, not one prompt —
 * it repeats on every invocation. It used to fall through to `unknown` with
 * `mutates=false`, so the account stayed in rotation and failed every request;
 * with every account failing the same way the pool looked dead and nothing was
 * ever parked, so routing never moved on.
 */
import { describe, expect, test } from "bun:test";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

const evidence = {
  origin: "upstream",
  scope: "account",
  statusCode: 400,
  credentialEvidence: true,
} as const;

function classify(message: string, providerCode: string, providerId: string) {
  return classifyAccountError(new Error(message), {
    ...evidence,
    providerId,
    providerCode,
  });
}

describe("buddy channel rejection 11128", () => {
  test("parks the account and mutates it", () => {
    const c = classify("invalid_request: Illegal API invocation from an unapproved channel", "11128", "cb");
    expect(c.category).toBe("policy_blocked");
    expect(c.status).toBe("cooldown");
    expect(c.mutatesAccount).toBe(true);
  });

  test("is recognised from the message when no provider code is present", () => {
    const c = classify("Illegal API invocation from an unapproved channel", "", "workbuddy");
    expect(c.category).toBe("policy_blocked");
    expect(c.mutatesAccount).toBe(true);
  });

  test("sets a retryAt in the future so routing skips the account", () => {
    const c = classify("Illegal API invocation from an unapproved channel", "11128", "cbcn");
    expect(c.retryAt).not.toBeNull();
    expect(c.retryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("an upstream account suspension parks the account too", () => {
    // The buddy family reports a suspended account as "Request illegal:
    // Account Suspended." — a bare "Account Suspended" carries no provider
    // code, so it is matched on its text rather than a new code constant.
    for (const message of [
      "Request illegal: Account Suspended.",
      "Account Suspended",
    ]) {
      const c = classify(message, "", "cb");
      expect(c.category).toBe("policy_blocked");
      expect(c.mutatesAccount).toBe(true);
    }
  });
  test("stays account-wide only for the buddy family", () => {
    // accounts on a code we have only verified on the buddy family.
    const c = classify("Illegal API invocation from an unapproved channel", "11128", "anthropic");
    expect(c.mutatesAccount).toBe(false);
  });

  test("leaves a malformed-parameter rejection alone", () => {
    // 11133 is a bad *request*, not a bad account: parking every account for
    // one oversized payload would be wrong.
    const c = classify("invalid_request: Invalid request parameters", "11133", "cb");
    expect(c.category).toBe("unknown");
    expect(c.mutatesAccount).toBe(false);
  });
});

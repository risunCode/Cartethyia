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

describe("buddy credit exhaustion 14018", () => {
  test("is a hard quota cooldown recovered by the twelve-hour sweep", () => {
    const c = classify("Credits exhausted. Please visit the link below to purchase add-on packs", "14018", "cb");
    expect(c.category).toBe("quota_exhausted");
    expect(c.status).toBe("cooldown");
    expect(c.mutatesAccount).toBe(true);
    expect(c.cooldownMs).toBe(12 * 60 * 60 * 1000);
    expect(c.retryAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
  });
});

/**
 * The penalty's *size*, which the assertions above deliberately leave open.
 *
 * This block was a flat 6h here and 24h for the sibling `11140` content block,
 * both applied on the first observation. Both codes are ambiguous from the
 * response alone: `workbuddy-shared.ts` records that the wrong desktop
 * `User-Agent` brand also answers `11140`, and a channel rejection is purely
 * about the calling channel we built — neither says anything about the
 * credential being unusable for a day.
 *
 * A flat day meant that after we fixed a header regression, every buddy account
 * stayed dead for up to a further 24h. As a short base the consecutive-failure
 * ladder decides instead, which is the evidence that actually separates the
 * causes: an account the upstream genuinely refuses is refused again on its very
 * next request and escalates to the cap within minutes, while one bad prompt or
 * one bad header costs five minutes.
 */
describe("buddy policy/channel block — a base backoff, not a flat day", () => {
  test("the first observation is a short backoff, not 6h or 24h", () => {
    const channel = classify("Illegal API invocation from an unapproved channel", "11128", "cb");
    expect(channel.cooldownMs).toBeLessThanOrEqual(5 * 60_000);
    const policy = classify("request illegal: did not pass the safety review", "11140", "cb");
    expect(policy.cooldownMs).toBeLessThanOrEqual(5 * 60_000);
  });

  test("both codes share one knob, so an operator can retune them together", () => {
    // Same category, same control: splitting them would let the two halves of
    // one upstream decision drift apart.
    const channel = classify("Illegal API invocation from an unapproved channel", "11128", "cb");
    const policy = classify("request illegal: did not pass the safety review", "11140", "cb");
    expect(policy.cooldownMs).toBe(channel.cooldownMs);
  });

  test("it stays a cooldown with a deadline, so the sweep recovers it", () => {
    // `disabled` is not an option here even at the cap: the credential is valid
    // and the block clears on its own, so an operator must never have to
    // re-enable the account by hand.
    const c = classify("Illegal API invocation from an unapproved channel", "11128", "cb");
    expect(c.status).toBe("cooldown");
    expect(c.retryAt).toBeInstanceOf(Date);
  });
});

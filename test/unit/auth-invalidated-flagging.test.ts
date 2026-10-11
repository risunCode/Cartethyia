import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/protocol/gateway-error";
import { classifyAccountError } from "../../src/providers/operations/account-health-service";

/**
 * A revoked OAuth token has to park the account, not cool it down. Codex
 * reports the revocation as `token_revoked` — underscore, inside a sentence —
 * and the classifier used to match only the spaced form `token revoked`, so
 * the account stayed in rotation and failed every request until an operator
 * noticed by hand.
 */

// No `credentialEvidence` and no `providerCode`: this is the shape a stream
// error frame carries when the upstream names the revocation only in prose.
// The HTTP path sets `credentialEvidence` from the status alone, which is why
// a test that includes it passes either way and proves nothing.
const REVOKED = new GatewayError(
  "platform_unavailable",
  502,
  "Encountered invalidated oauth token for user, failing request (token_revoked)",
  {},
  "upstream",
);

describe("classifyAccountError — a revoked token parks the account", () => {
  test("token_revoked is read as credential rejection, not an unknown failure", () => {
    const classification = classifyAccountError(REVOKED, {
      origin: "upstream",
      scope: "provider",
      credentialKind: "oauth",
    });
    expect(classification.category).toBe("auth_invalidated");
    // A revocation names no expiry and no refresh to run, so there is nothing
    // to wait out. Cooling the account for five minutes only puts it back into
    // rotation to fail again.
    expect(classification.status).toBe("disabled");
    expect(classification.mutatesAccount).toBe(true);
  });

  test("the same phrase with spaces or hyphens classifies identically", () => {
    for (const wording of ["token revoked", "token-revoked"]) {
      const error = new GatewayError(
        "authentication_failed",
        401,
        `credential rejected: ${wording}`,
        { credentialEvidence: true },
        "upstream",
      );
      const classification = classifyAccountError(error, {
        origin: "upstream",
        scope: "account",
        credentialEvidence: true,
        credentialKind: "oauth",
      });
      expect(classification.category).toBe("auth_invalidated");
      expect(classification.status).toBe("disabled");
    }
  });

  test("an expiry still cools down instead of parking — a refresh can fix it", () => {
    const error = new GatewayError(
      "authentication_failed",
      401,
      "token expired",
      { credentialEvidence: true },
      "upstream",
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
      credentialKind: "oauth",
    });
    expect(classification.category).toBe("auth_invalidated");
    expect(classification.status).toBe("cooldown");
  });
});

describe("classifyAccountError — a regional model rejection", () => {
  test("cools the model instead of disabling the account", () => {
    const error = new GatewayError(
      "policy_rejected",
      403,
      "Provider credential rejected: access forbidden: cline-free/muse-spark-1.3-contributor is not available in your region",
      { credentialEvidence: true },
      "upstream",
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
      credentialKind: "oauth",
      modelId: "muse-spark-1.3-contributor",
    });
    expect(classification.category).toBe("model_unreachable");
    expect(classification.status).toBe("cooldown");
    expect(classification.mutatesAccount).toBe(true);
  });
});

/**
 * The other half of the distinction: an auth rejection that names no revocation
 * must NOT park the account.
 *
 * The branch above is deliberate — a revocation is the one auth outcome with no
 * expiry to wait out and no refresh to run. But `disabled` is also the one state
 * no sweep recovers (`sweepExpiredCooldowns` selects `status = "cooldown"` only,
 * and `recordAccountSuccess` returns early on `disabled`), so every *other* auth
 * rejection reaching it removed the account from rotation until an operator
 * noticed by hand.
 *
 * A bare `401`/`403` is weak evidence: clock skew, a key rotated upstream a
 * moment ago, an edge answering before the credential loads. All of them used to
 * cost the account permanently. `disabled` must now require the upstream to
 * actually name the revocation.
 */
describe("classifyAccountError — a rejection that names no revocation cools down", () => {
  test("a bare 401 cools the account instead of disabling it", () => {
    const error = new GatewayError(
      "authentication_failed",
      401,
      "Invalid Authentication",
      { credentialEvidence: true },
      "upstream",
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
    });
    // `cooldown`, not `disabled`: the deadline is what lets the sweep return it.
    expect(classification.status).toBe("cooldown");
    expect(classification.category).toBe("auth_invalidated");
    expect(classification.mutatesAccount).toBe(true);
    expect(classification.cooldownMs).toBeGreaterThan(0);
    expect(classification.retryAt).toBeInstanceOf(Date);
  });

  test("a 403 credential rejection cools down too", () => {
    const error = new GatewayError(
      "authentication_failed",
      403,
      "Incorrect API key provided",
      { credentialEvidence: true },
      "upstream",
    );
    expect(
      classifyAccountError(error, { origin: "upstream", scope: "account", credentialEvidence: true }).status,
    ).toBe("cooldown");
  });

  test("an OAuth expiry cools down whether or not the credential kind is known", () => {
    // Dispatch builds its evidence as `{...classifyUpstreamFailure(error)}`,
    // which carries no `credentialKind`, so the refresh-aware branch was
    // unreachable from the request path and an expired OAuth token was parked
    // exactly like a revoked one. Both must cool; `recordAccountFailure` fills
    // the kind in from the account row.
    const error = new GatewayError(
      "authentication_failed",
      401,
      "token expired",
      { credentialEvidence: true },
      "upstream",
    );
    expect(
      classifyAccountError(error, { origin: "upstream", scope: "account", credentialEvidence: true }).status,
    ).toBe("cooldown");
    expect(
      classifyAccountError(error, {
        origin: "upstream",
        scope: "account",
        credentialEvidence: true,
        credentialKind: "oauth",
      }).status,
    ).toBe("cooldown");
  });

  test("a generic rejection never reports the revocation wording", () => {
    // The reason is what the health dialog shows an operator. Claiming a
    // credential was *revoked* on a bare 401 would send them to re-authenticate
    // a key that was never revoked.
    const error = new GatewayError(
      "authentication_failed",
      401,
      "Invalid Authentication",
      { credentialEvidence: true },
      "upstream",
    );
    const classification = classifyAccountError(error, {
      origin: "upstream",
      scope: "account",
      credentialEvidence: true,
    });
    expect(classification.reason).not.toMatch(/revoked/i);
  });

  test("a named revocation still parks the account", () => {
    // The companion rule: without a refresh to run and no window to wait out, a
    // cooldown only returns a dead credential to rotation to fail again.
    for (const message of ["token_revoked", "token revoked", "invalidated oauth token"]) {
      const error = new GatewayError(
        "authentication_failed",
        401,
        message,
        { credentialEvidence: true },
        "upstream",
      );
      const classification = classifyAccountError(error, {
        origin: "upstream",
        scope: "account",
        credentialEvidence: true,
      });
      expect(classification.status).toBe("disabled");
      expect(classification.mutatesAccount).toBe(true);
    }
  });

  test("a local-origin rejection mutates nothing either way", () => {
    // Only an upstream verdict is evidence about the credential.
    const error = new GatewayError("authentication_failed", 401, "bad key", {}, "cartethyia");
    expect(classifyAccountError(error, { origin: "cartethyia" }).mutatesAccount).toBe(false);
  });
});

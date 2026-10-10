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

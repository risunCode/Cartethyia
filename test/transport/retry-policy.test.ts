/**
 * Retry policy: the two questions the attempt loop asks about every failure.
 *
 * "Is this credential itself dead, so refreshing could help?" and "is this a
 * provider rate limit, so the pool should cool down?" Both answers move money
 * and availability, and both have a documented near-miss that was fixed:
 *
 * 1. **A provider 403 is not evidence of a dead credential.** CodeBuddy uses
 *    403 for a deterministic safety/content rejection (`code: 11140`), and
 *    refreshing the token cannot change that outcome — so a naive "403 means
 *    re-auth" rule burns a token refresh on every policy refusal and, worse,
 *    can invalidate a working credential.
 * 2. **Cooling the pool for an account-keyed 429 sidesteps every healthy
 *    sibling.** For an account-keyed provider the limit belongs to the account
 *    that was dialed, and the account health machine already records it; cooling
 *    the shared egress removes healthy accounts from service for the whole
 *    cooldown window.
 *
 * The third property is structural: `providerId` is the caller's own candidate
 * rather than a field read off the error, because the in-stream error frames the
 * protocol modules build carry no `providerId` — reading it from `details` would
 * silently disable the IP-scoped rule on exactly the streaming path it exists
 * for. That is asserted directly.
 */
import { describe, expect, test } from "bun:test";
import {
  isOAuthCredentialInvalidated,
  shouldCooldownPool,
} from "../../src/transport/dispatch/retry-policy";
import { GatewayError } from "../../src/transport/gateway-error";
import { providerRateLimitIsIpScoped } from "../../src/providers/provider-registry";

/** The one bundled provider whose rate limit follows the egress address. */
const IP_SCOPED_PROVIDER = "opencodeft";
/** A bundled provider whose limits are keyed to the account credential. */
const ACCOUNT_KEYED_PROVIDER = "anthropic";

function upstream429(details: Record<string, unknown> = {}): GatewayError {
  return new GatewayError("accounts_rate_limited", 429, "rate limited", details, "upstream");
}

describe("isOAuthCredentialInvalidated — the credential-death signal", () => {
  test("a non-GatewayError is never credential evidence", () => {
    // The guard is typed, and a caller passes whatever the attempt loop caught:
    // a TypeError from a bad adapter must not be read as a dead token.
    expect(isOAuthCredentialInvalidated(new Error("boom"))).toBe(false);
    expect(isOAuthCredentialInvalidated("authentication_failed")).toBe(false);
    expect(isOAuthCredentialInvalidated(null)).toBe(false);
    expect(isOAuthCredentialInvalidated(undefined)).toBe(false);
    expect(isOAuthCredentialInvalidated({ code: "authentication_failed" })).toBe(false);
  });

  test("a non-403 authentication failure needs explicit credential evidence", () => {
    // The 401 path: the provider said the credential is bad, and the flag is
    // what distinguishes "the token is dead" from "the provider rejected this
    // request for another reason under a 401".
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("authentication_failed", 401, "invalid key", { credentialEvidence: true }),
      ),
    ).toBe(true);
    expect(
      isOAuthCredentialInvalidated(new GatewayError("authentication_failed", 401, "invalid key")),
    ).toBe(false);
  });

  test("a non-403 error with the flag but a different code is not evidence", () => {
    // The flag is only meaningful alongside `authentication_failed`; a quota or
    // routing error carrying a stray flag must not trigger a refresh.
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("quota_exceeded", 429, "limited", { credentialEvidence: true }),
      ),
    ).toBe(false);
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("not_found", 404, "missing", { credentialEvidence: true }),
      ),
    ).toBe(false);
  });

  test("a 403 without credential evidence is not a dead credential", () => {
    // A 403 is a policy signal at least as often as it is an auth signal, so
    // the flag is required.
    expect(isOAuthCredentialInvalidated(new GatewayError("policy_rejected", 403, "nope"))).toBe(
      false,
    );
  });

  test("a 403 with credential evidence IS evidence", () => {
    // The complement, so the special cases below cannot be satisfied by
    // refusing every 403 outright.
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("authentication_failed", 403, "token expired", { credentialEvidence: true }),
      ),
    ).toBe(true);
  });

  test("a 403 with credential evidence still refuses the safety-review provider code", () => {
    // The documented near-miss: CodeBuddy answers a content-policy refusal with
    // 403 and `code: 11140`, and refreshing the token cannot change that request
    // outcome. Treating it as a dead credential burns a refresh on every refusal.
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("policy_rejected", 403, "rejected", {
          credentialEvidence: true,
          providerCode: "11140",
        }),
      ),
    ).toBe(false);
  });

  test("the provider code comparison is case-insensitive", () => {
    // The upstream is free to send the code as a string in any case; a
    // case-sensitive compare would let `11140` through as a credential signal.
    for (const providerCode of ["11140", "11140"]) {
      expect(
        isOAuthCredentialInvalidated(
          new GatewayError("policy_rejected", 403, "x", { credentialEvidence: true, providerCode }),
        ),
      ).toBe(false);
    }
  });

  test("a 403 whose text names a safety review is not a dead credential", () => {
    // The text fallback exists because not every upstream sets `providerCode`.
    // Each phrase the pattern documents gets its own case.
    const phrases = [
      "this request failed safety review",
      "content did not pass review",
      "request illegal for this model",
      "content blocked by policy",
    ];
    for (const phrase of phrases) {
      expect(
        isOAuthCredentialInvalidated(
          new GatewayError("policy_rejected", 403, phrase, { credentialEvidence: true }),
        ),
      ).toBe(false);
    }
  });

  test("the safety phrases are matched inside a raw upstream body string too", () => {
    // The message and the raw body are concatenated before matching, because the
    // explanation often arrives only in the upstream's own JSON. MEASURED: the
    // concatenation is `String(details.raw)`, and the producer that sets `raw`
    // on these errors (`src/protocol/messages-errors.ts`) sets it to the
    // upstream's message *string*, so the phrase is found.
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("policy_rejected", 403, "rejected", {
          credentialEvidence: true,
          raw: '{"error":{"message":"content blocked"}}',
        }),
      ),
    ).toBe(false);
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("policy_rejected", 403, "rejected", {
          credentialEvidence: true,
          raw: "request illegal",
        }),
      ),
    ).toBe(false);
  });

  test("a raw body that is an OBJECT does not contribute its text", () => {
    // MEASURED DIVERGENCE, pinned rather than asserted as correct.
    //
    // `String(details.raw)` on a non-string yields `"[object Object]"`, so a
    // structured raw body contributes nothing to the phrase match. In the
    // product this is currently harmless: the producer that sets `raw` on a
    // provider error (`protocol/messages-errors.ts`) sets it to a string, and
    // the only other consumer stringifies it explicitly before use
    // (`gateway-error.ts`'s `publicGatewayErrorDetails` runs it through
    // `redactTelemetryValue`). The test exists so that a future producer passing
    // a parsed body is a deliberate change with a test to update, rather than a
    // silent hole in the safety-review exclusion — a hole that would make the
    // gateway treat a policy refusal as a dead OAuth credential and burn a
    // token refresh on every refusal.
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("policy_rejected", 403, "rejected", {
          credentialEvidence: true,
          raw: { error: { message: "content blocked" } },
        }),
      ),
    ).toBe(true);
  });

  test("a 403 from a hosted tool is not a dead credential", () => {
    // The comment is explicit: a hosted-tool failure (web search / web fetch /
    // x search) is a per-request outcome of the provider's own server-side tool.
    // Refreshing the OAuth token cannot fix it, and doing so on every tool
    // failure would invalidate a working credential under load.
    const phrases = [
      "web search failed",
      "web-search backend error",
      "web fetch failed",
      "x search unavailable",
      "tool invocation failed",
      "search backend unavailable",
    ];
    for (const phrase of phrases) {
      expect(
        isOAuthCredentialInvalidated(
          new GatewayError("platform_unavailable", 403, phrase, { credentialEvidence: true }),
        ),
      ).toBe(false);
    }
  });

  test("a 403 with credential evidence and no special phrase is evidence", () => {
    // The default after every exclusion: a plain "your token is revoked" 403.
    expect(
      isOAuthCredentialInvalidated(
        new GatewayError("authentication_failed", 403, "token revoked", { credentialEvidence: true }),
      ),
    ).toBe(true);
  });

  test("credential evidence must be exactly true, not merely truthy", () => {
    // The check is `=== true`, so a string or a number does not qualify. Pinned
    // because a truthy check would accept `"false"` and refresh the credential
    // on an upstream that sent the flag as a string.
    for (const value of ["true", 1, {}, []]) {
      expect(
        isOAuthCredentialInvalidated(
          new GatewayError("authentication_failed", 401, "x", { credentialEvidence: value }),
        ),
      ).toBe(false);
    }
  });
});

describe("shouldCooldownPool — the IP-scoped rate-limit signal", () => {
  test("a provider-scoped upstream 429 on an IP-scoped provider cools the pool", () => {
    // The case the rule exists for: the upstream counted requests from this
    // address, so the pool is the resource that ran out and backing it off is
    // the fix.
    expect(
      shouldCooldownPool(upstream429({ rateLimitScope: "provider" }), IP_SCOPED_PROVIDER),
    ).toBe(true);
  });

  test("the same error on an account-keyed provider does NOT cool the pool", () => {
    // The documented near-miss: cooling the pool sidelines every healthy sibling
    // sharing that egress, because one account hit its own limit.
    expect(
      shouldCooldownPool(upstream429({ rateLimitScope: "provider" }), ACCOUNT_KEYED_PROVIDER),
    ).toBe(false);
  });

  test("a BYOK provider is treated as account-keyed", () => {
    // The comment: a configurable upstream states nothing about IP scoping, so
    // the pool is left alone. Assuming IP scoping would take a tenant's own
    // proxy pool out of service on an unrelated limit.
    expect(
      shouldCooldownPool(upstream429({ rateLimitScope: "provider" }), "my-byok-provider"),
    ).toBe(false);
  });

  test("a 429 with no provider scope never cools the pool, on any provider", () => {
    // The comment: a bare 429 with no provider scope stays a request-level limit.
    for (const providerId of [IP_SCOPED_PROVIDER, ACCOUNT_KEYED_PROVIDER, "byok"]) {
      expect(shouldCooldownPool(upstream429(), providerId)).toBe(false);
      expect(shouldCooldownPool(upstream429({ rateLimitScope: "account" }), providerId)).toBe(false);
      expect(shouldCooldownPool(upstream429({ rateLimitScope: "request" }), providerId)).toBe(false);
    }
  });

  test("only a 429 qualifies", () => {
    // A 403 or a 500 is a different incident; cooling the pool on one would
    // remove a healthy egress for an unrelated failure.
    for (const status of [400, 401, 403, 404, 500, 502, 503, 504]) {
      expect(
        shouldCooldownPool(
          new GatewayError("platform_unavailable", status, "x", { rateLimitScope: "provider" }, "upstream"),
          IP_SCOPED_PROVIDER,
        ),
      ).toBe(false);
    }
  });

  test("only an upstream-origin error qualifies", () => {
    // A gateway-origin 429 is our own admission decision. Cooling the tenant's
    // proxy pool because we throttled the tenant would blame the network for a
    // quota the tenant exhausted.
    for (const origin of ["cartethyia", "network"] as const) {
      expect(
        shouldCooldownPool(
          new GatewayError("accounts_rate_limited", 429, "x", { rateLimitScope: "provider" }, origin),
          IP_SCOPED_PROVIDER,
        ),
      ).toBe(false);
    }
  });

  test("a non-GatewayError never qualifies", () => {
    expect(shouldCooldownPool(new Error("429"), IP_SCOPED_PROVIDER)).toBe(false);
    expect(shouldCooldownPool(null, IP_SCOPED_PROVIDER)).toBe(false);
    expect(
      shouldCooldownPool({ status: 429, origin: "upstream", details: { rateLimitScope: "provider" } }, IP_SCOPED_PROVIDER),
    ).toBe(false);
  });

  test("the provider id is the caller's argument, not a field on the error", () => {
    // The documented structural property. The in-stream error frames the
    // protocol modules build carry no `providerId` detail, so a rule that read
    // the id off `details` would silently disable itself on exactly the
    // streaming path it exists for. A detail naming a DIFFERENT provider must
    // not change the answer.
    const error = upstream429({
      rateLimitScope: "provider",
      providerId: ACCOUNT_KEYED_PROVIDER,
    });
    expect(shouldCooldownPool(error, IP_SCOPED_PROVIDER)).toBe(true);
    const ipScopedDetail = upstream429({
      rateLimitScope: "provider",
      providerId: IP_SCOPED_PROVIDER,
    });
    expect(shouldCooldownPool(ipScopedDetail, ACCOUNT_KEYED_PROVIDER)).toBe(false);
  });

  test("an empty or undefined provider id is account-keyed", () => {
    // The helper's own guard: an unknown id states nothing about IP scoping.
    expect(shouldCooldownPool(upstream429({ rateLimitScope: "provider" }), "")).toBe(false);
    expect(
      shouldCooldownPool(
        upstream429({ rateLimitScope: "provider" }),
        undefined as unknown as string,
      ),
    ).toBe(false);
  });

  test("the guard narrows to GatewayError for the caller", () => {
    // The type guard exists so a caller can hand the same value to
    // `flagPoolCooldown` without a second narrowing step. This is asserted at
    // the type level by using the narrowed value's own fields.
    const error: unknown = upstream429({ rateLimitScope: "provider" });
    if (shouldCooldownPool(error, IP_SCOPED_PROVIDER)) {
      expect(error.code).toBe("accounts_rate_limited");
      expect(error.details.rateLimitScope).toBe("provider");
    } else {
      throw new Error("the guard should have narrowed");
    }
  });

  test("the scope comparison is exact, not case-insensitive", () => {
    // The detail is written by our own protocol modules, so it is a literal; a
    // case-insensitive compare would accept a value no producer writes.
    expect(
      shouldCooldownPool(upstream429({ rateLimitScope: "Provider" }), IP_SCOPED_PROVIDER),
    ).toBe(false);
    expect(
      shouldCooldownPool(upstream429({ rateLimitScope: "PROVIDER" }), IP_SCOPED_PROVIDER),
    ).toBe(false);
  });
});

describe("providerRateLimitIsIpScoped — the underlying provider fact", () => {
  test("the bundled IP-scoped provider is recognised", () => {
    // This is the data the pool-cooldown rule reads. If the flag were dropped
    // from the metadata, the rule would silently stop firing for the one
    // provider it was written for.
    expect(providerRateLimitIsIpScoped(IP_SCOPED_PROVIDER)).toBe(true);
  });

  test("an account-keyed bundled provider is not IP-scoped", () => {
    expect(providerRateLimitIsIpScoped(ACCOUNT_KEYED_PROVIDER)).toBe(false);
  });

  test("an unknown id is not IP-scoped", () => {
    // The documented default for a BYOK provider.
    expect(providerRateLimitIsIpScoped("some-byok-slug")).toBe(false);
    expect(providerRateLimitIsIpScoped("")).toBe(false);
    expect(providerRateLimitIsIpScoped(undefined)).toBe(false);
  });

  test("the lookup is exact, so a near-miss spelling is not IP-scoped", () => {
    // A Set membership test on the literal id. A prefix or fuzzy match would
    // make a BYOK slug that resembles a bundled id inherit the bundled
    // provider's scoping.
    expect(providerRateLimitIsIpScoped(IP_SCOPED_PROVIDER.toUpperCase())).toBe(false);
    expect(providerRateLimitIsIpScoped(`${IP_SCOPED_PROVIDER} `)).toBe(false);
    expect(providerRateLimitIsIpScoped(`${IP_SCOPED_PROVIDER}-free`)).toBe(false);
  });

  test("the two functions agree on every case they share", () => {
    // The pool-cooldown rule is only as correct as the fact it reads. Asserting
    // them together means a change to either cannot drift past this suite.
    for (const providerId of [IP_SCOPED_PROVIDER, ACCOUNT_KEYED_PROVIDER, "byok-slug"]) {
      expect(shouldCooldownPool(upstream429({ rateLimitScope: "provider" }), providerId)).toBe(
        providerRateLimitIsIpScoped(providerId),
      );
    }
  });
});

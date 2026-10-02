/**
 * Credential extraction and the model-authorization rule, as units.
 *
 * These are the two decisions the gateway makes before it does anything
 * expensive, and both are pure functions over their inputs — so they can be
 * exercised exhaustively without a database or a socket. The gateway-level
 * suites prove the wiring; this one proves the rules, including the inputs a
 * request cannot easily produce (a Set instead of an array, a null list, an
 * address family mix).
 */
import { describe, expect, test } from "bun:test";
import {
  createAuthorizationSnapshot,
  getAdmissionIdentity,
  isModelAllowed,
  listIncludes,
  modelRejectionReason,
  requestToken,
} from "../../src/security/api-key-auth";
import { GatewayError } from "../../src/transport/gateway-error";

/** Builds a snapshot with only the fields a case cares about. */
function snapshot(input: {
  allow?: readonly string[] | null;
  deny?: readonly string[] | null;
  scopes?: readonly string[];
  admissionIdentity?: string;
}) {
  return createAuthorizationSnapshot({
    api_key_id: "key-1",
    tenant_id: "tenant-1",
    ...(input.allow === undefined || input.allow === null
      ? {}
      : { model_allowlist: input.allow }),
    ...(input.deny === undefined || input.deny === null ? {} : { model_denylist: input.deny }),
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    ...(input.admissionIdentity === undefined
      ? {}
      : { admission_identity: input.admissionIdentity }),
  });
}

describe("requestToken", () => {
  test("reads a bearer token from a Headers instance", () => {
    expect(requestToken(new Headers({ authorization: "Bearer abc123" }))).toBe("abc123");
  });

  test("reads a bearer token from a plain object", () => {
    expect(requestToken({ authorization: "Bearer abc123" })).toBe("abc123");
  });

  test("reads x-api-key when no Authorization header is present", () => {
    expect(requestToken({ "x-api-key": "abc123" })).toBe("abc123");
  });

  test("prefers the identical credential sent in both headers", () => {
    // The Anthropic-compatible idiom: both headers carry one key.
    expect(
      requestToken({ authorization: "Bearer abc123", "x-api-key": "abc123" }),
    ).toBe("abc123");
  });

  test("rejects two different credentials rather than choosing one", () => {
    expect(() =>
      requestToken({ authorization: "Bearer abc123", "x-api-key": "different" }),
    ).toThrow(GatewayError);
  });

  test("the conflict error is a 400 invalid_request", () => {
    try {
      requestToken({ authorization: "Bearer a", "x-api-key": "b" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      const gatewayError = error as GatewayError;
      expect(gatewayError.code).toBe("invalid_request");
      expect(gatewayError.status).toBe(400);
    }
  });

  test("an absent header is a 401, not a 400", () => {
    // The status distinction matters to a client: 401 means "supply a
    // credential", 400 means "your request is malformed".
    try {
      requestToken({});
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as GatewayError).status).toBe(401);
    }
  });

  test("a non-bearer Authorization scheme is refused", () => {
    expect(() => requestToken({ authorization: "Basic dXNlcjpwYXNz" })).toThrow(GatewayError);
  });

  test("an empty x-api-key is treated as absent", () => {
    expect(() => requestToken({ "x-api-key": "   " })).toThrow(GatewayError);
  });

  test("surrounding whitespace on the Authorization header is tolerated", () => {
    expect(requestToken({ authorization: "  Bearer abc123  " })).toBe("abc123");
  });

  test("a token with an internal space is not truncated", () => {
    // `Bearer a b` does not match the single-token pattern, so it must be
    // refused rather than authenticated as `a`.
    expect(() => requestToken({ authorization: "Bearer a b" })).toThrow(GatewayError);
  });

  test("the bearer scheme is case-insensitive", () => {
    expect(requestToken({ authorization: "BEARER abc123" })).toBe("abc123");
    expect(requestToken({ authorization: "bearer abc123" })).toBe("abc123");
  });

  test("a token containing punctuation survives verbatim", () => {
    const token = "rk_a-b.c_d~e+f/g=h";
    expect(requestToken({ authorization: `Bearer ${token}` })).toBe(token);
  });
});

describe("listIncludes", () => {
  test("matches an array entry", () => {
    expect(listIncludes(["a", "b"], "b")).toBe(true);
    expect(listIncludes(["a", "b"], "c")).toBe(false);
  });

  test("matches a Set entry", () => {
    expect(listIncludes(new Set(["a", "b"]), "b")).toBe(true);
    expect(listIncludes(new Set(["a"]), "b")).toBe(false);
  });

  test("an absent or null list matches nothing", () => {
    // Failing closed here is what keeps a missing list from meaning "allow
    // everything"; the caller decides whether absent means unrestricted.
    expect(listIncludes(null, "a")).toBe(false);
    expect(listIncludes(undefined, "a")).toBe(false);
  });

  test("an empty list matches nothing", () => {
    expect(listIncludes([], "a")).toBe(false);
  });

  test("matching is exact, not a prefix or substring", () => {
    // A prefix match would make `gpt-4` allow `gpt-4o`, which is a different
    // model with a different price.
    expect(listIncludes(["gpt-4"], "gpt-4o")).toBe(false);
    expect(listIncludes(["gpt-4o"], "gpt-4")).toBe(false);
  });
});

describe("modelRejectionReason", () => {
  test("no lists means no restriction", () => {
    expect(modelRejectionReason(snapshot({}), "gpt-4")).toBeNull();
  });

  test("an allowlist permits exactly its entries", () => {
    const snap = snapshot({ allow: ["gpt-4", "gpt-4o"] });
    expect(modelRejectionReason(snap, "gpt-4")).toBeNull();
    expect(modelRejectionReason(snap, "gpt-3.5")).toBe("model-not-allowed");
  });

  test("an empty allowlist is unrestricted, not deny-all", () => {
    expect(modelRejectionReason(snapshot({ allow: [] }), "anything")).toBeNull();
  });

  test("a denylist refuses exactly its entries", () => {
    const snap = snapshot({ deny: ["gpt-4"] });
    expect(modelRejectionReason(snap, "gpt-4")).toBe("model-denied");
    expect(modelRejectionReason(snap, "gpt-4o")).toBeNull();
  });

  test("the denylist wins when a model is on both lists", () => {
    const snap = snapshot({ allow: ["gpt-4"], deny: ["gpt-4"] });
    expect(modelRejectionReason(snap, "gpt-4")).toBe("model-denied");
  });

  test("a bare entry matches a qualified target", () => {
    const snap = snapshot({ allow: ["mimo-chat"] });
    expect(modelRejectionReason(snap, "xiaomi/mimo-chat", "xiaomi")).toBeNull();
  });

  test("a qualified target matches when the provider is supplied", () => {
    const snap = snapshot({ allow: ["xiaomi/mimo-chat"] });
    expect(modelRejectionReason(snap, "mimo-chat", "xiaomi")).toBeNull();
  });

  test("a qualified entry authorizes a bare target when no provider is supplied", () => {
    // Was "a qualified target is refused when no provider is supplied", pinning the
    // defect: without `targetProvider` the function could not build the qualified
    // candidate name, so a qualified allowlist entry missed a bare target.
    //
    // That mattered because the preparer is the FIRST enforcement point and runs
    // before routing, so it cannot supply `targetProvider` — the provider is not
    // chosen yet. The miss was therefore final, and the dashboard's `ModelPicker`
    // writes exactly the qualified form into `modelAllowlist`, so a client naming
    // the bare model was refused a model the operator explicitly allowed.
    //
    // The reverse direction now applies while the provider is unknown. It is scoped
    // to `targetProvider === undefined` so the comparison stays precise once
    // admission runs with the provider known — see the next test.
    const snap = snapshot({ allow: ["xiaomi/mimo-chat"] });
    expect(modelRejectionReason(snap, "mimo-chat", undefined)).toBeNull();
  });

  test("a qualified entry does not authorize a DIFFERENT provider's model", () => {
    // The over-permission the fix must not introduce: once the provider is known,
    // `providerA/model-x` must not authorize `providerB/model-x`. They are different
    // upstreams, which is exactly what a qualified allowlist entry pins.
    const snap = snapshot({ allow: ["providerA/model-x"] });
    expect(modelRejectionReason(snap, "model-x", "providerA")).toBeNull();
    expect(modelRejectionReason(snap, "model-x", "providerB")).toBe("model-not-allowed");
  });

  test("a qualified entry still refuses an unlisted model", () => {
    // The other half of the boundary: the new reverse direction must not become a
    // blanket allow.
    const snap = snapshot({ allow: ["xiaomi/mimo-chat"] });
    expect(modelRejectionReason(snap, "other-model", undefined)).toBe("model-not-allowed");
    expect(modelRejectionReason(snap, "other-provider/other-model", undefined)).toBe(
      "model-not-allowed",
    );
  });

  test("a qualified denylist entry does not catch a bare target with no provider", () => {
    // Same asymmetry as the allowlist, and the same cause: with no
    // `targetProvider` the candidate names are only `[target, bare(target)]`,
    // so a qualified entry is never constructed and never compared.
    //
    // The gateway-level suite shows why the denylist is not exploitable in
    // practice: `admission.ts` calls the same rule a second time with
    // `targetProvider` supplied, and *that* call constructs the qualified name
    // and refuses. This unit pins the function's own behavior so the reason the
    // second call is load-bearing is recorded next to the rule itself.
    const snap = snapshot({ deny: ["xiaomi/mimo-chat"] });
    expect(modelRejectionReason(snap, "mimo-chat", undefined)).toBeNull();
    // With the provider supplied — the admission layer's call — it refuses.
    expect(modelRejectionReason(snap, "mimo-chat", "xiaomi")).toBe("model-denied");
  });

  test("a requested name that differs from the target is also checked", () => {
    // An alias request: the caller asked for `fast`, which resolved to
    // `gpt-4`. Denying either name must refuse the request — otherwise an
    // allowlisted alias could launder a denied target.
    const snap = snapshot({ deny: ["fast"] });
    expect(modelRejectionReason(snap, "gpt-4", "openai", "fast")).toBe("model-denied");
  });

  test("a denylist still refuses when only the resolved target is denied", () => {
    const snap = snapshot({ deny: ["gpt-4"] });
    expect(modelRejectionReason(snap, "gpt-4", "openai", "fast")).toBe("model-denied");
  });

  test("an allowlisted alias authorizes its resolved target", () => {
    // The operator allowed the alias; routing resolved it to a provider/model
    // they never typed. Refusing the resolved form would break the alias.
    const snap = snapshot({ allow: ["fast"] });
    expect(modelRejectionReason(snap, "gpt-4", "openai", "fast")).toBeNull();
  });

  test("a CLI remapping authorizes its target only with the cli_mapping scope", () => {
    // The remap exists for Claude Code specifically, and the operator granted
    // the scope deliberately. Without it, the remapped target is not allowed.
    const withScope = snapshot({ allow: ["claude-only"], scopes: ["routing:cli_mapping"] });
    expect(modelRejectionReason(withScope, "deepseek-chat", "deepseek", "opus")).toBeNull();

    const withoutScope = snapshot({ allow: ["claude-only"], scopes: ["routing:invoke"] });
    expect(modelRejectionReason(withoutScope, "deepseek-chat", "deepseek", "opus")).toBe(
      "model-not-allowed",
    );
  });

  test("the denylist still wins over a CLI remapping", () => {
    const snap = snapshot({
      allow: ["claude-only"],
      deny: ["deepseek-chat"],
      scopes: ["routing:cli_mapping"],
    });
    expect(modelRejectionReason(snap, "deepseek-chat", "deepseek", "opus")).toBe("model-denied");
  });

  test("a target with several slashes keeps only the last segment as its bare id", () => {
    const snap = snapshot({ allow: ["model-x"] });
    expect(modelRejectionReason(snap, "provider/group/model-x", "provider")).toBeNull();
  });
});

describe("isModelAllowed", () => {
  test("is exactly the null-ness of the rejection reason", () => {
    const allowed = snapshot({ allow: ["a"] });
    const denied = snapshot({ deny: ["b"] });
    expect(isModelAllowed(allowed, "a")).toBe(true);
    expect(isModelAllowed(allowed, "b")).toBe(false);
    expect(isModelAllowed(denied, "b")).toBe(false);
    expect(isModelAllowed(denied, "a")).toBe(true);
  });
});

describe("getAdmissionIdentity", () => {
  test("uses the admission identity when a share child set one", () => {
    // A share recipient admits against the parent's counters, so the family
    // shares one quota instead of each child getting a full budget.
    expect(getAdmissionIdentity(snapshot({ admissionIdentity: "parent-key" }))).toBe(
      "parent-key",
    );
  });

  test("falls back to the key's own id", () => {
    expect(getAdmissionIdentity(snapshot({}))).toBe("key-1");
  });
});

describe("createAuthorizationSnapshot", () => {
  test("an absent list is stored as an absent value, not an empty one", () => {
    // `freezeSnapshot` passes the list through `freezeList`, which returns
    // `undefined` for an absent list — so the key is present on the object but
    // holds `undefined`. `modelRejectionReason` reads that through
    // `listSize`, which treats both `null` and `undefined` as "no list", so the
    // distinction never reaches a policy decision.
    const snap = snapshot({});
    expect(snap.model_allowlist).toBeUndefined();
    expect(snap.model_denylist).toBeUndefined();
  });

  test("keeps an empty array as an explicit empty list", () => {
    const snap = snapshot({ allow: [] });
    expect(snap.model_allowlist).toEqual([]);
  });

  test("freezes the snapshot so a caller cannot widen it after the fact", () => {
    const snap = snapshot({ allow: ["a"] });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.model_allowlist)).toBe(true);
  });

  test("defaults the identity fields to empty strings rather than null", () => {
    const snap = createAuthorizationSnapshot({ api_key_id: "", tenant_id: "" });
    expect(snap.api_key_id).toBe("");
    expect(snap.tenant_id).toBe("");
  });

  test("admission identity defaults to the key's own id", () => {
    expect(snapshot({}).admission_identity).toBe("key-1");
  });
});

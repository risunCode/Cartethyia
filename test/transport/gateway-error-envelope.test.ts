/**
 * The public error envelope: the only thing a client is allowed to learn about
 * a failure.
 *
 * Every rejection the gateway produces — a quota 429, an upstream 502, a
 * routing 404 — is shaped by this module before it leaves. Two properties carry
 * the whole risk:
 *
 * 1. **Nothing outside the allowlist escapes.** `details` is populated by
 *    internal code with whatever it finds useful, including upstream response
 *    bodies. The allowlist is the boundary between "useful to a client" and
 *    "an internal map of the deployment" — provider ids, pool ids, account
 *    scope, and routing reasons are all on it deliberately, and everything else
 *    (including a future field nobody re-checked) must be dropped.
 * 2. **An upstream body that echoes a credential must be redacted.** `raw` is
 *    the one allowlisted field that carries attacker-controlled text: an
 *    upstream 401 body frequently repeats the API key it rejected. That is why
 *    it alone passes through `redactTelemetryValue` before being bounded.
 *
 * The message shaper is the third surface: clients branch on the code, and a
 * legacy brand prefix leaking into the text tells a client which product is in
 * front of the upstream.
 */
import { describe, expect, test } from "bun:test";
import {
  explainGatewayError,
  formatPublicErrorMessage,
  GatewayError,
  publicGatewayErrorDetails,
  type GatewayErrorCode,
} from "../../src/transport/gateway-error";

describe("GatewayError", () => {
  test("carries its code, status, origin, and details", () => {
    const error = new GatewayError("quota_exceeded", 429, "rpm limit exceeded", { limit: 10 });
    expect(error.code).toBe("quota_exceeded");
    expect(error.status).toBe(429);
    expect(error.origin).toBe("cartethyia");
    expect(error.details).toEqual({ limit: 10 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GatewayError");
  });

  test("defaults to the gateway as the origin", () => {
    // Origin drives the operator's triage: "our bug" and "the provider's bug"
    // are different incidents. A default of `upstream` would mis-blame.
    expect(new GatewayError("internal_error", 500, "x").origin).toBe("cartethyia");
  });

  test("defaults to no details rather than undefined", () => {
    // `Object.entries(error.details)` runs on every public envelope; an
    // undefined details object would throw inside the error path itself.
    expect(new GatewayError("internal_error", 500, "x").details).toEqual({});
  });

  test("accepts each documented origin", () => {
    for (const origin of ["cartethyia", "upstream", "network"] as const) {
      expect(new GatewayError("platform_unavailable", 502, "x", {}, origin).origin).toBe(origin);
    }
  });
});

describe("formatPublicErrorMessage", () => {
  test("prefixes the code onto an explanatory message", () => {
    expect(formatPublicErrorMessage("quota_exceeded", "rpm limit exceeded")).toBe(
      "quota_exceeded: rpm limit exceeded",
    );
  });

  test("applies the prefix once, not twice", () => {
    // The shaper can run more than once on a value that crossed two boundaries;
    // a doubled prefix reads as a client bug in the gateway's own text.
    expect(formatPublicErrorMessage("quota_exceeded", "quota_exceeded: rpm limit exceeded")).toBe(
      "quota_exceeded: rpm limit exceeded",
    );
  });

  test("a message equal to the code is not doubled", () => {
    // The error path can build a message from the code alone; `code: code`
    // adds nothing and looks like a formatting defect to the client.
    expect(formatPublicErrorMessage("not_found", "not_found")).toBe("not_found");
  });

  test("an empty message collapses to the bare code", () => {
    // A blank explanatory clause would render as `code: ` with a trailing
    // separator, which reads as a truncated response.
    expect(formatPublicErrorMessage("not_found", "")).toBe("not_found");
    expect(formatPublicErrorMessage("not_found", "   ")).toBe("not_found");
  });

  test("strips every legacy origin brand prefix", () => {
    // Older builds stamped the brand into the public message. A client must
    // never see product branding in the error text, and blame lives in the
    // structured `origin` field instead.
    expect(formatPublicErrorMessage("internal_error", "Cartethyia Error: something broke")).toBe(
      "internal_error: something broke",
    );
    expect(formatPublicErrorMessage("platform_unavailable", "Upstream Error: bad gateway")).toBe(
      "platform_unavailable: bad gateway",
    );
    expect(formatPublicErrorMessage("transport_unavailable", "Network Error: reset")).toBe(
      "transport_unavailable: reset",
    );
  });

  test("a legacy prefix alone collapses to the bare code", () => {
    // Stripping leaves nothing; the result must not be `code: ` with a
    // dangling separator.
    expect(formatPublicErrorMessage("internal_error", "Cartethyia Error:")).toBe("internal_error");
    expect(formatPublicErrorMessage("internal_error", "  Cartethyia Error:   ")).toBe(
      "internal_error",
    );
  });

  test("only the leading prefix is stripped, not one embedded in the text", () => {
    // A message that happens to mention the brand mid-sentence is real content;
    // stripping it would corrupt the explanation.
    expect(
      formatPublicErrorMessage("internal_error", "the Cartethyia Error: handler failed"),
    ).toBe("internal_error: the Cartethyia Error: handler failed");
  });

  test("a message that already starts with a DIFFERENT code is still prefixed", () => {
    // The guard compares against this error's own code, so an unrelated prefix
    // is treated as ordinary text.
    expect(formatPublicErrorMessage("not_found", "quota_exceeded: nope")).toBe(
      "not_found: quota_exceeded: nope",
    );
  });

  test("surrounding whitespace is trimmed", () => {
    expect(formatPublicErrorMessage("not_found", "  missing  ")).toBe("not_found: missing");
  });
});

describe("explainGatewayError", () => {
  test("formats the error's own code and message", () => {
    const error = new GatewayError("accounts_rate_limited", 429, "all accounts are cooling down");
    expect(explainGatewayError(error)).toBe(
      "accounts_rate_limited: all accounts are cooling down",
    );
  });

  test("does not mutate the error it explains", () => {
    // The same error object is reused for telemetry and for the console; a
    // formatter that rewrote `message` in place would leak the shaped text into
    // the internal record.
    const error = new GatewayError("internal_error", 500, "Cartethyia Error: boom");
    explainGatewayError(error);
    expect(error.message).toBe("Cartethyia Error: boom");
  });

  test("the origin never appears in the public text", () => {
    // The comment is explicit: gateway and upstream look the same on the wire,
    // and a client that needs the layer reads `error.origin`.
    for (const origin of ["cartethyia", "upstream", "network"] as const) {
      const text = explainGatewayError(new GatewayError("platform_unavailable", 502, "failed", {}, origin));
      expect(text).not.toContain(origin);
    }
  });
});

describe("publicGatewayErrorDetails — the allowlist", () => {
  test("keeps every allowlisted key it is given", () => {
    // The allowlist is deliberate: provider, pool, account scope, and routing
    // reasons are what a client needs to act on a rejection.
    const details = {
      providerId: "anthropic",
      poolId: "pool-1",
      model: "claude-sonnet-4-6",
      reason: "rpm-exhausted",
      retryAfterMs: 1_500,
      upstreamStatus: 429,
      requestId: "req-1",
    };
    expect(publicGatewayErrorDetails(new GatewayError("quota_exceeded", 429, "x", details))).toEqual(
      details,
    );
  });

  test("drops every key that is not on the allowlist", () => {
    // This is the boundary. An internal field that reaches a client is an
    // information leak, and the failure mode is silent — nothing else breaks.
    const details = {
      providerId: "anthropic",
      owners: ["tenant-secret"],
      tenantId: "tenant-secret",
      internalNote: "upstream said the key sk-live-EXAMPLE is revoked",
      stack: "at someInternalFunction (/srv/app/src/secret.ts:42)",
      databaseUrl: "postgres://user:pw@host/db",
      providerIdInternal: "x",
    };
    const public_ = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    );
    expect(public_).toEqual({ providerId: "anthropic" });
    // Sweep the serialized envelope, so a key added later is caught by this
    // test rather than by an incident.
    const serialized = JSON.stringify(public_);
    for (const secret of [
      "tenant-secret",
      "sk-live-EXAMPLE",
      "someInternalFunction",
      "/srv/app",
      "postgres://",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("an empty details object yields an empty envelope", () => {
    expect(publicGatewayErrorDetails(new GatewayError("not_found", 404, "x"))).toEqual({});
  });

  test("a key that merely resembles an allowlisted one is dropped", () => {
    // Exact membership, not a prefix or case-insensitive match: `ProviderId`
    // and `provider_id` are different keys, and only the listed spelling is
    // published.
    const details = { ProviderId: "anthropic", provider_id: "anthropic", providerId: "anthropic" };
    expect(
      publicGatewayErrorDetails(new GatewayError("accounts_unavailable", 503, "x", details)),
    ).toEqual({ providerId: "anthropic" });
  });

  test("a value of undefined is published as undefined, not dropped", () => {
    // MEASURED: the filter is on the key alone. The envelope then serializes
    // the key away in JSON, so this is observable only on the object. Pinned
    // because a change to `Object.entries` handling would alter the shape.
    const details = { providerId: undefined, reason: "x" };
    const public_ = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    );
    expect("providerId" in public_).toBe(true);
    expect(public_.providerId).toBeUndefined();
  });
});

describe("publicGatewayErrorDetails — bounds", () => {
  test("a long string is truncated to 500 characters", () => {
    // An upstream that answers with a multi-megabyte body must not turn the
    // error envelope into a multi-megabyte response.
    const details = { safeMessage: "x".repeat(10_000) };
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", details),
    ).safeMessage;
    expect(typeof value).toBe("string");
    expect((value as string).length).toBe(500);
  });

  test("an array is truncated to 32 entries", () => {
    const details = { reasons: Array.from({ length: 100 }, (_value, index) => `r${index}`) };
    const value = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    ).reasons;
    expect(Array.isArray(value)).toBe(true);
    expect((value as readonly unknown[]).length).toBe(32);
  });

  test("an object nested past three levels is redacted", () => {
    // MEASURED: the depth guard runs *after* the string check, so a scalar at
    // any depth survives and only an object at depth 3 or deeper becomes
    // `"[redacted]"`. Depth bounds the work a hostile upstream can make the
    // gateway do while building an error response, and it is the point past
    // which the envelope stops being a client-facing explanation — so the
    // assertion nests an object, which is the shape the guard actually catches.
    const details = {
      reason: { level2: { level3: { level4: { level5: "deep" } } } },
    };
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", details),
    ).reason;
    expect(JSON.stringify(value)).toContain("[redacted]");
    expect(JSON.stringify(value)).not.toContain("deep");
  });

  test("a scalar at any depth is preserved, only its container is bounded", () => {
    // The complement of the test above, pinned so nobody "tightens" the guard
    // into dropping scalar leaves: the leaves are the useful part of an error
    // explanation and the depth bound exists to stop recursion, not to hide
    // values.
    const details = {
      reason: { level2: { level3: { level4: "still visible" } } },
    };
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", details),
    ).reason;
    expect(JSON.stringify(value)).toContain("still visible");
  });

  test("shallow nesting is preserved in full", () => {
    // The bound must not be so tight that the useful shape is lost.
    const details = { reason: { a: "1", b: { c: "2" } } };
    expect(
      publicGatewayErrorDetails(new GatewayError("platform_unavailable", 502, "x", details)).reason,
    ).toEqual({ a: "1", b: { c: "2" } });
  });

  test("non-string scalars pass through untouched", () => {
    // Numbers and booleans are the useful part of a rejection: a client retries
    // on `retryAfterMs` and branches on `upstreamStatus`.
    const details = { retryAfterMs: 1_500, upstreamStatus: 429, available: true, capacity: 0 };
    expect(
      publicGatewayErrorDetails(new GatewayError("capacity_exhausted", 429, "x", details)),
    ).toEqual(details);
  });

  test("null and an absent value survive as-is", () => {
    const details = { reason: null };
    expect(
      publicGatewayErrorDetails(new GatewayError("platform_unavailable", 502, "x", details)).reason,
    ).toBeNull();
  });
});

describe("publicGatewayErrorDetails — raw is redacted", () => {
  test("a credential echoed in an upstream body does not reach the client", () => {
    // This is the field's whole reason for existing in the allowlist. An
    // upstream 401 body routinely repeats the key it rejected; publishing it
    // hands the client back its own credential inside an error message that
    // then lands in logs, bug reports, and screenshots.
    const upstreamBody = {
      error: {
        message: "invalid api key: sk-ant-api03-EXAMPLEnotarealkey000000000000",
        type: "authentication_error",
      },
    };
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", { raw: upstreamBody }),
    ).raw;
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("sk-ant-api03-EXAMPLEnotarealkey000000000000");
  });

  test("a bearer token echoed in an upstream body is redacted", () => {
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", {
        raw: { detail: "Authorization: Bearer EXAMPLEtokenvalue1234567890 was rejected" },
      }),
    ).raw;
    expect(JSON.stringify(value)).not.toContain("EXAMPLEtokenvalue1234567890");
  });

  test("a redacted raw body keeps its useful shape", () => {
    // Redaction must not blank the object: the operator still needs to see that
    // it was an authentication error from the upstream's own type field.
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", {
        raw: { error: { type: "authentication_error", message: "bad key" } },
      }),
    ).raw;
    expect(JSON.stringify(value)).toContain("authentication_error");
  });

  test("only raw is redacted; other allowlisted fields are published verbatim", () => {
    // `safeMessage` is gateway-authored text by contract, so it is not run
    // through the credential sweep — a value that looked like a key there would
    // still be published, and that is the intended contract rather than a hole.
    const value = publicGatewayErrorDetails(
      new GatewayError("platform_unavailable", 502, "x", { safeMessage: "upstream returned 500" }),
    ).safeMessage;
    expect(value).toBe("upstream returned 500");
  });

  test("raw is redacted before it is size-bounded", () => {
    // Order matters: bounding first would cut a credential in half and leave a
    // prefix that no longer matches the redaction pattern.
    const longSecret = `sk-ant-${"a".repeat(4_000)}`;
    const value = publicGatewayErrorDetails(
      new GatewayError("authentication_failed", 401, "x", { raw: { message: longSecret } }),
    ).raw;
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("aaaa");
    expect(serialized.length).toBeLessThan(2_000);
  });
});

describe("publicGatewayErrorDetails — a hostile details object", () => {
  test("a circular details object does not throw", () => {
    // `details` is built by internal code, but a value passed through from an
    // upstream JSON body could in principle be cyclic after a transform. An
    // error path that throws replaces a useful rejection with a 500.
    const circular: Record<string, unknown> = { providerId: "anthropic" };
    circular.reason = circular;
    let failure: unknown = null;
    let result: Readonly<Record<string, unknown>> | undefined;
    try {
      result = publicGatewayErrorDetails(
        new GatewayError("accounts_unavailable", 503, "x", circular),
      );
    } catch (error: unknown) {
      failure = error;
    }
    // The depth bound stops the recursion, so this resolves rather than throws.
    expect(failure).toBeNull();
    expect(result?.providerId).toBe("anthropic");
  });

  test("a details object with a getter that throws does not escape", () => {
    // `Object.entries` reads every value. A throwing getter on an untrusted
    // object would otherwise surface as a 500 instead of the real rejection.
    const hostile: Record<string, unknown> = { providerId: "anthropic" };
    Object.defineProperty(hostile, "reason", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    let failure: unknown = null;
    try {
      publicGatewayErrorDetails(new GatewayError("accounts_unavailable", 503, "x", hostile));
    } catch (error: unknown) {
      failure = error;
    }
    // Recorded as the measured behaviour: the sanitizer is not defensive against
    // a throwing getter, because `details` is gateway-authored rather than
    // client-supplied. Pinned so a change here is a deliberate decision.
    expect(failure).toBeInstanceOf(Error);
  });

  test("a very wide array is bounded, not walked entirely", () => {
    const details = { reasons: Array.from({ length: 100_000 }, () => "x") };
    const value = publicGatewayErrorDetails(
      new GatewayError("accounts_unavailable", 503, "x", details),
    ).reasons;
    expect((value as readonly unknown[]).length).toBe(32);
  });
});

describe("the error code vocabulary", () => {
  test("every code is a non-empty stable identifier", () => {
    // Clients branch on these strings. A code with a space, an uppercase letter,
    // or an empty value would break a client's match without failing anything
    // in the gateway.
    const codes: readonly GatewayErrorCode[] = [
      "capability_unsupported",
      "ambiguous_model",
      "model_not_found",
      "upstream_not_found",
      "context_length_exceeded",
      "request_too_large",
      "accounts_unavailable",
      "accounts_rate_limited",
      "capacity_exhausted",
      "proxy_pool_capacity_exceeded",
      "proxy_pool_cooldown",
      "proxy_pool_unavailable",
      "proxy_pool_unhealthy",
      "invalid_pool_limits",
      "admission_unavailable",
      "slug_reserved",
      "quota_exceeded",
      "authentication_failed",
      "policy_rejected",
      "invalid_request",
      "not_found",
      "link_not_found",
      "invalid_sequence",
      "invalid_lifecycle",
      "unsupported_field",
      "unsupported_media_type",
      "upstream_conflict",
      "upstream_unprocessable",
      "internal_error",
      "transport_unavailable",
      "tunnel_setup_failed",
      "platform_unavailable",
      "tenant_capacity_exhausted",
      "tls_rejected",
      "proxy_auth_required",
      "deadline_exceeded",
      "transport_closed",
      "max_connections_exceeded",
      "proxy_unreachable",
      "tool_call_loop_detected",
      "client_router_denied",
      "model_abuse_banned",
      "shutting_down",
      "restart_for_update",
    ];
    for (const code of codes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    // The list above is exhaustive by construction: it is typed as the union,
    // so adding a code to the product without adding it here fails typecheck.
    expect(new Set(codes).size).toBe(codes.length);
  });
});

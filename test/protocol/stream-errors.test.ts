/**
 * Upstream error classification: in-stream error frames and the Claude paths.
 *
 * A `200 OK` whose SSE body carries an error envelope is an upstream failure
 * that arrived *after* the status line, and it is the shape that used to reach
 * the client with no `error.code`, no message, and an `unknown_error` telemetry
 * category. Three modules now share one classifier, and this suite pins the
 * contract each of them owes its callers:
 *
 * - `stream-error-frames.ts` — the OpenAI-family decoders' single entry point.
 * - `messages-errors.ts` — the Claude HTTP and SSE paths, which keep their own
 *   envelope extraction on top of the same classifier.
 *
 * The load-bearing rule is that classification reads **structured identifiers
 * only** (`error.type`, `error.code`, a numeric `error.status`) and never
 * message prose. Two consequences are pinned here because they are easy to
 * "improve" into a defect: a frame carrying nothing but `{ type: "error" }`
 * classifies as `platform_unavailable` rather than being pattern-matched on its
 * text, and the CodeBuddy family's `{"code":"6004","msg":"…"}` yields the
 * `msg` as the message (so the account-health machine can parse a stated reset)
 * while `6004` is reported as the provider code.
 *
 * Everything is a pure call: no sockets, no streams, no clock.
 */
import { describe, expect, test } from "bun:test";
import { gatewayErrorFromStreamError } from "../../src/protocol/stream-error-frames";
import { mapClaudeHttpError, mapClaudeStreamError } from "../../src/protocol/messages-errors";
import type { GatewayError } from "../../src/transport/gateway-error";

/** The classifier's view of one input, as a comparable tuple. */
function classified(error: GatewayError | undefined): string {
  if (error === undefined) return "undefined";
  return `${error.code}/${error.status}/${error.origin}`;
}

describe("gatewayErrorFromStreamError: frames that carry no error", () => {
  test("null and undefined are not errors at all", () => {
    // The caller may unwrap an absent envelope into either; neither is a
    // failure, so the decoder continues rather than throwing.
    expect(gatewayErrorFromStreamError(null, "label")).toBeUndefined();
    expect(gatewayErrorFromStreamError(undefined, "label")).toBeUndefined();
  });

  test("a primitive that is not a string is not an error either", () => {
    // A bare number or boolean can only have come from a mis-unwrapped frame;
    // treating it as a failure would fabricate an upstream error.
    for (const value of [42, true, Symbol("s"), 0]) {
      expect(gatewayErrorFromStreamError(value, "label")).toBeUndefined();
    }
  });

  test("an array is not an error, even though typeof says object", () => {
    // `isRecord` excludes arrays deliberately: an array of errors is not the
    // error envelope, and reading `.type` off it would pick up array indices.
    expect(gatewayErrorFromStreamError([{ type: "rate_limit_exceeded" }], "label")).toBeUndefined();
  });
});

describe("gatewayErrorFromStreamError: string envelopes", () => {
  test("a bare string error becomes an honest platform failure", () => {
    // The Cline shape: `{"error": "Not Found"}` — the upstream declared a
    // failure with no structure to classify it by, so the status is 502 and
    // the origin is upstream rather than invented.
    const error = gatewayErrorFromStreamError("Not Found", "openai");
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
    expect(error?.message).toBe("Not Found");
  });

  test("an empty string falls back to the caller's label", () => {
    // Without the fallback the client would see an empty message and have
    // nothing to act on. The label names which upstream produced the failure.
    const error = gatewayErrorFromStreamError("", "codex upstream");
    expect(error?.message).toBe("codex upstream");
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
  });

  test("a whitespace-only string is kept rather than falling back", () => {
    // Measured: the guard is `error.slice(0, 500) || label`, and a
    // whitespace-only string is truthy. Harmless — it is a message the
    // upstream actually sent — but pinned so the boundary is known.
    expect(gatewayErrorFromStreamError("   ", "label")?.message).toBe("   ");
  });

  test("a long string message is truncated to 500 characters", () => {
    // The bound is applied to the raw string before it becomes a message; an
    // upstream that echoes a whole HTML page must not fill the error envelope.
    expect(gatewayErrorFromStreamError("z".repeat(900), "label")?.message).toHaveLength(500);
  });

  test("a string error carries no provider metadata", () => {
    // There is no code or status to record, and fabricating an empty
    // `providerCode` would make the operator's search match every failure.
    const error = gatewayErrorFromStreamError("boom", "label");
    expect(error?.details).toEqual({});
  });
});

describe("gatewayErrorFromStreamError: unclassifiable objects", () => {
  test("an empty object is a failure with the label as its message", () => {
    const error = gatewayErrorFromStreamError({}, "openai");
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
    expect(error?.message).toBe("openai");
    expect(error?.details).toEqual({});
  });

  test("a frame whose only identifier is the frame type stays unclassified", () => {
    // `type: "error"` names the frame, not the failure. Classifying on it would
    // make every unlabelled error look like a specific provider problem; the
    // honest answer is "the upstream failed and we do not know more".
    for (const frameType of ["error", "response.failed", "response.error"]) {
      const error = gatewayErrorFromStreamError({ type: frameType }, "label");
      expect(classified(error)).toBe("platform_unavailable/502/upstream");
      expect(error?.details).toEqual({});
    }
  });

  test("a bare numeric status string is not read as an identifier", () => {
    // `upstreamErrorIdentifier` skips any `type` that is exactly three digits:
    // `"500"` as a type names the frame's status, not a provider error code, so
    // it must not be reported as `providerCode`.
    const error = gatewayErrorFromStreamError({ type: "500" }, "label");
    expect(error?.details).toEqual({});
  });

  test("message prose is never used for classification", () => {
    // The rule the module header states: a substring rule fires on any message
    // containing the word — including text the client itself wrote. A message
    // that names a rate limit must not become a rate limit.
    const error = gatewayErrorFromStreamError(
      { message: "rate_limit_exceeded: please slow down, capacity exhausted" },
      "label",
    );
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
    expect(error?.message).toBe("rate_limit_exceeded: please slow down, capacity exhausted");
  });
});

describe("gatewayErrorFromStreamError: structured status", () => {
  test("a declared 5xx status is used verbatim and recorded", () => {
    const error = gatewayErrorFromStreamError({ status: 500 }, "label");
    expect(classified(error)).toBe("platform_unavailable/500/upstream");
    expect(error?.details).toEqual({ providerStatus: 500 });
  });

  test("the status window is 400..599 inclusive", () => {
    expect(classified(gatewayErrorFromStreamError({ status: 400 }, "l"))).toBe("invalid_request/400/upstream");
    expect(classified(gatewayErrorFromStreamError({ status: 599 }, "l"))).toBe("platform_unavailable/599/upstream");
  });

  test("a status outside the window is ignored rather than clamped", () => {
    // A 3xx or a 6xx is not an error status the classifier can reason about, so
    // it is dropped and the default 502 applies. Clamping would invent a code.
    for (const status of [302, 399, 600, 999, 200]) {
      const error = gatewayErrorFromStreamError({ status }, "label");
      expect(classified(error)).toBe("platform_unavailable/502/upstream");
      expect(error?.details).toEqual({});
    }
  });

  test("a non-numeric status is ignored", () => {
    for (const status of ["500", null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = gatewayErrorFromStreamError({ status }, "label");
      expect(classified(error)).toBe("platform_unavailable/502/upstream");
    }
  });

  test("the first recognized status field wins", () => {
    // `numericStatus` reads `status`, then `statusCode`, then `status_code` in
    // that order, so a frame carrying both is read by its canonical field.
    expect(classified(gatewayErrorFromStreamError({ status: 400, statusCode: 503 }, "l"))).toBe(
      "invalid_request/400/upstream",
    );
    expect(classified(gatewayErrorFromStreamError({ statusCode: 503 }, "l"))).toBe(
      "platform_unavailable/503/upstream",
    );
    expect(classified(gatewayErrorFromStreamError({ status_code: 504 }, "l"))).toBe(
      "deadline_exceeded/504/upstream",
    );
  });

  test("a 407 is a proxy failure and its origin says so", () => {
    // The only status that changes the *origin*: a proxy demanding auth is a
    // network-layer problem, not the upstream's, and the operator's next step
    // (fix the pool credential) depends on that distinction.
    const error = gatewayErrorFromStreamError({ status: 407 }, "label");
    expect(classified(error)).toBe("proxy_auth_required/407/network");
    expect(error?.details).toEqual({ providerStatus: 407 });
  });

  test("a 529 is capacity, not a generic 5xx, and is provider-scoped", () => {
    const error = gatewayErrorFromStreamError({ status: 529 }, "label");
    expect(classified(error)).toBe("capacity_exhausted/529/upstream");
    expect(error?.details).toEqual({ providerStatus: 529, rateLimitScope: "provider" });
  });

  test("a 429 is quota and provider-scoped even without an identifier", () => {
    const error = gatewayErrorFromStreamError({ status: 429 }, "label");
    expect(classified(error)).toBe("quota_exceeded/429/upstream");
    expect(error?.details).toEqual({ providerStatus: 429, rateLimitScope: "provider" });
  });
});

describe("gatewayErrorFromStreamError: structured identifiers", () => {
  test("a quota identifier outranks the status and forces 429", () => {
    // The upstream sent a 500 whose body names a quota problem. The identifier
    // is the more specific signal, so the code is quota_exceeded — but the
    // status stays 429 because 500 is not a quota status.
    const error = gatewayErrorFromStreamError({ status: 500, type: "rate_limit_exceeded" }, "label");
    expect(classified(error)).toBe("quota_exceeded/429/upstream");
    expect(error?.details).toEqual({
      providerStatus: 500,
      providerCode: "rate_limit_exceeded",
      rateLimitScope: "provider",
    });
  });

  test("a quota identifier keeps a 402 or 429 status rather than rewriting it", () => {
    for (const status of [402, 429]) {
      const error = gatewayErrorFromStreamError({ status, code: "insufficient_quota" }, "label");
      expect(error?.status).toBe(status);
      expect(error?.code).toBe("quota_exceeded");
    }
  });

  test("an auth identifier sets credential evidence", () => {
    // `credentialEvidence` is what the account-health machine reads to decide
    // the credential is dead rather than the provider being busy.
    const error = gatewayErrorFromStreamError({ type: "invalid_api_key" }, "label");
    expect(classified(error)).toBe("authentication_failed/401/upstream");
    expect(error?.details).toEqual({
      providerCode: "invalid_api_key",
      credentialEvidence: true,
    });
  });

  test("a permission identifier is a 403, not a 401", () => {
    // A key that authenticated but lacks scope is not a bad key; the operator
    // must not be told to rotate a working credential.
    for (const identifier of ["permission_error", "insufficient_scope", "permission_denied"]) {
      const error = gatewayErrorFromStreamError({ code: identifier }, "label");
      expect(classified(error)).toBe("authentication_failed/403/upstream");
      expect(error?.details).toEqual({ providerCode: identifier, credentialEvidence: true });
    }
  });

  test("a context-length identifier is a 413 with its own code", () => {
    const error = gatewayErrorFromStreamError({ code: "context_length_exceeded" }, "label");
    expect(classified(error)).toBe("context_length_exceeded/413/upstream");
    expect(error?.details).toEqual({ providerCode: "context_length_exceeded" });
  });

  test("a capacity identifier is a 529 unless the status already says 503", () => {
    expect(gatewayErrorFromStreamError({ type: "overloaded_error" }, "l")?.status).toBe(529);
    expect(gatewayErrorFromStreamError({ status: 503, type: "overloaded_error" }, "l")?.status).toBe(503);
    expect(gatewayErrorFromStreamError({ status: 503, type: "overloaded_error" }, "l")?.code).toBe(
      "capacity_exhausted",
    );
  });

  test("a platform identifier keeps the upstream's own 5xx status", () => {
    const error = gatewayErrorFromStreamError({ status: 502, type: "server_error" }, "label");
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
    expect(error?.details).toEqual({ providerStatus: 502, providerCode: "server_error" });
  });

  test("the provider's own numeric code is reported as the provider code", () => {
    // The 11140 family: a policy rejection sent as a bare number.
    const error = gatewayErrorFromStreamError({ code: 11140 }, "label");
    expect(classified(error)).toBe("policy_rejected/403/upstream");
    expect(error?.details).toEqual({ providerCode: "11140" });
  });

  test("a bare-numeric code does not become the message when a sibling carries text", () => {
    // The CodeBuddy/WorkBuddy shape. Taking the digits as the message discarded
    // the only text the account-health machine can parse for a stated reset, so
    // the account fell back to the generic cooldown and failed every request
    // inside the provider's real window.
    const error = gatewayErrorFromStreamError(
      { code: "6004", msg: "your usage will reset at 2026-10-02 12:00 UTC+8" },
      "label",
    );
    expect(error?.message).toBe("your usage will reset at 2026-10-02 12:00 UTC+8");
    expect(error?.details).toEqual({ providerCode: "6004" });
  });

  test("a bare-numeric code with no sibling text is still better than nothing", () => {
    // Last resort: it is what the operator would quote to the provider.
    expect(gatewayErrorFromStreamError({ code: "6004" }, "label")?.message).toBe("6004");
  });

  test("a symbolic code is readable on its own and is used as the message", () => {
    expect(gatewayErrorFromStreamError({ code: "insufficient_quota" }, "label")?.message).toBe(
      "insufficient_quota",
    );
  });

  test("a nested envelope is read for its identifier", () => {
    // Some decoders hand the whole frame through rather than unwrapping it
    // first; `upstreamErrorIdentifier` reads `error.code`/`error.type` so the
    // classification survives either calling convention.
    const error = gatewayErrorFromStreamError({ error: { type: "overloaded_error" } }, "label");
    expect(classified(error)).toBe("capacity_exhausted/529/upstream");
    expect(error?.details).toEqual({ providerCode: "overloaded_error" });
  });

  test("an extError code wins over a nested one", () => {
    // The 11148 family: a top-level numeric code with the specific string
    // nested in `extError`. The specific code is the actionable one.
    const error = gatewayErrorFromStreamError(
      { code: 11148, extError: { code: "tool_call_sequence_broken" } },
      "label",
    );
    expect(error?.details).toEqual({ providerCode: "tool_call_sequence_broken" });
  });

  test("identifiers are matched case-insensitively", () => {
    const error = gatewayErrorFromStreamError({ type: "RATE_LIMIT_EXCEEDED" }, "label");
    expect(error?.code).toBe("quota_exceeded");
    // The code is reported as the upstream spelled it, so an operator can
    // search the provider's docs for the exact string.
    expect(error?.details).toEqual({ providerCode: "RATE_LIMIT_EXCEEDED", rateLimitScope: "provider" });
  });

  test("an unrecognized identifier falls back to the status alone", () => {
    const error = gatewayErrorFromStreamError({ status: 503, type: "some_new_provider_code" }, "label");
    expect(classified(error)).toBe("platform_unavailable/503/upstream");
    expect(error?.details).toEqual({ providerStatus: 503, providerCode: "some_new_provider_code" });
  });

  test("an empty-string identifier is treated as absent", () => {
    // A blank `code` is not an identifier; recording it would put an empty
    // string in the operator's search field.
    const error = gatewayErrorFromStreamError({ status: 500, code: "   " }, "label");
    expect(error?.details).toEqual({ providerStatus: 500 });
  });
});

describe("mapClaudeHttpError", () => {
  test("a JSON error envelope is read for message, code, and status", () => {
    const error = mapClaudeHttpError(
      429,
      JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }),
    );
    expect(classified(error)).toBe("quota_exceeded/429/upstream");
    expect(error.message).toBe("slow down");
    expect(error.details).toEqual({
      upstreamStatus: 429,
      providerCode: "rate_limit_error",
      raw: "slow down",
      rateLimitScope: "provider",
    });
  });

  test("the HTTP status is always recorded, unlike the stream path", () => {
    // The Claude path knows the status from the response line, so
    // `details.upstreamStatus` is unconditional; `gatewayErrorFromStreamError`
    // can only record a status the upstream declared inside the frame. Pinned
    // because the two shapes are consumed by the same operator tooling.
    const error = mapClaudeHttpError(500, "{}");
    expect(error.details).toHaveProperty("upstreamStatus", 500);
    expect(error.details).not.toHaveProperty("providerStatus");
  });

  test("a 401 sets credential evidence with no provider code present", () => {
    const error = mapClaudeHttpError(401, JSON.stringify({ error: { message: "bad key" } }));
    expect(classified(error)).toBe("authentication_failed/401/upstream");
    expect(error.details).toEqual({
      upstreamStatus: 401,
      raw: "bad key",
      credentialEvidence: true,
    });
  });

  test("a body that is not JSON becomes the message verbatim", () => {
    // An HTML error page from a misconfigured edge; the text is what the
    // operator needs to see, and the status still classifies the failure.
    const error = mapClaudeHttpError(502, "<html>oops</html>");
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
    expect(error.message).toBe("<html>oops</html>");
  });

  test("an empty or whitespace-only body synthesizes a message from the status", () => {
    // Without the fallback the client sees an empty message. The synthetic text
    // is bounded and contains no upstream payload.
    for (const body of ["", "   ", "\n"]) {
      const error = mapClaudeHttpError(503, body);
      expect(error.message).toBe("claude error 503");
      expect(error.details).toHaveProperty("raw", "claude error 503");
    }
  });

  test("a JSON null body is reported as the literal text, not dropped", () => {
    // `parsedBody ?? body` falls back to the raw text on null, so "null" is the
    // message. Odd but honest: the upstream sent something and it was not an
    // envelope, and the alternative is a silent empty message.
    expect(mapClaudeHttpError(500, "null").message).toBe("null");
  });

  test("a JSON body that is not an object yields no message and falls back", () => {
    // `extractUpstreamMessage(5)` is "", so the synthesized message applies —
    // but `raw` is the synthesized one too, not the number.
    const error = mapClaudeHttpError(500, "5");
    expect(error.message).toBe("claude error 500");
  });

  test("a string-valued error field is the message", () => {
    // The Cline shape again, this time through the Claude path.
    const error = mapClaudeHttpError(404, JSON.stringify({ error: "Not Found", success: false }));
    expect(classified(error)).toBe("upstream_not_found/404/upstream");
    expect(error.message).toBe("Not Found");
  });

  test("a request id header is recorded for the support ticket", () => {
    const error = mapClaudeHttpError(
      429,
      JSON.stringify({ error: { message: "x" } }),
      new Headers({ "x-request-id": "req-1" }),
    );
    expect(error.details).toHaveProperty("upstreamRequestId", "req-1");
  });

  test("a blank request id falls through to the next candidate header", () => {
    // `Headers.get` returns "" — not null — for a header sent with no value,
    // and `??` falls through only on null, so a bare `x-request-id:` used to
    // discard a perfectly good `cf-ray` on the same response.
    const error = mapClaudeHttpError(
      429,
      "{}",
      new Headers({ "x-request-id": "", "cf-ray": "ray-9" }),
    );
    expect(error.details).toHaveProperty("upstreamRequestId", "ray-9");
  });

  test("no headers means no request id key at all", () => {
    // Absent, not undefined-valued: the public envelope serializer filters by
    // key allowlist, and an explicit `undefined` would serialize as a key.
    const error = mapClaudeHttpError(500, "{}");
    expect(error.details).not.toHaveProperty("upstreamRequestId");
  });

  test("a long message is truncated to 500 characters", () => {
    const error = mapClaudeHttpError(500, JSON.stringify({ error: { message: "m".repeat(2000) } }));
    expect(error.message).toHaveLength(500);
  });

  test("a 407 is a network-origin proxy failure here too", () => {
    const error = mapClaudeHttpError(407, "{}");
    expect(classified(error)).toBe("proxy_auth_required/407/network");
  });
});

describe("mapClaudeStreamError", () => {
  test("a frame with a status is classified by that status", () => {
    const error = mapClaudeStreamError({ status: 500, message: "boom" });
    expect(classified(error)).toBe("platform_unavailable/500/upstream");
    expect(error.message).toBe("boom");
    expect(error.details).toEqual({ upstreamStatus: 500, raw: "boom" });
  });

  test("a frame with no status defaults to 502", () => {
    // A stream error with no declared status is an upstream failure with no
    // HTTP status line to read; 502 is the honest default rather than 500,
    // which would claim the upstream returned a server error.
    const error = mapClaudeStreamError({ message: "boom" });
    expect(classified(error)).toBe("platform_unavailable/502/upstream");
  });

  test("a payload that is not a record yields the generic message", () => {
    // The caller may pass a raw SSE payload that failed to unwrap. A string
    // payload is not an envelope, so its text is not used as a message.
    for (const payload of ["plain", null, undefined, 42, [1]]) {
      const error = mapClaudeStreamError(payload);
      expect(error.message).toBe("Claude stream returned an error");
      expect(classified(error)).toBe("platform_unavailable/502/upstream");
    }
  });

  test("a non-string message field is replaced by the generic text", () => {
    const error = mapClaudeStreamError({ status: 500, message: { nested: true } });
    expect(error.message).toBe("Claude stream returned an error");
  });

  test("an empty-string message is kept rather than replaced", () => {
    // Measured: the guard is `typeof message === "string"`, so "" passes and
    // the envelope carries an empty message. Pinned as the known boundary.
    expect(mapClaudeStreamError({ message: "" }).message).toBe("");
  });

  test("a long message is truncated to 500 characters", () => {
    expect(mapClaudeStreamError({ message: "m".repeat(2000) }).message).toHaveLength(500);
  });

  test("a numeric provider code is stringified into the details", () => {
    const error = mapClaudeStreamError({ code: 11148, message: "x" });
    expect(error.details).toEqual({
      upstreamStatus: 502,
      providerCode: "11148",
      raw: "x",
    });
  });

  test("a request id header is recorded", () => {
    const error = mapClaudeStreamError({ message: "x" }, new Headers({ "request-id": "r-2" }));
    expect(error.details).toHaveProperty("upstreamRequestId", "r-2");
  });

  test("a non-2xx status other than 5xx classifies by the status table", () => {
    // The stream path passes the declared status straight through, so the same
    // status→code table the HTTP path uses applies.
    expect(mapClaudeStreamError({ status: 401, message: "x" }).code).toBe("authentication_failed");
    expect(mapClaudeStreamError({ status: 404, message: "x" }).code).toBe("upstream_not_found");
    expect(mapClaudeStreamError({ status: 429, message: "x" }).code).toBe("quota_exceeded");
    expect(mapClaudeStreamError({ status: 529, message: "x" }).code).toBe("capacity_exhausted");
    expect(mapClaudeStreamError({ status: 407, message: "x" }).code).toBe("proxy_auth_required");
  });

  test("a stream error never reports a provider status, only the upstream status", () => {
    // The declared status becomes the *upstream* status, because on this path
    // it is the upstream that said it — there was no HTTP response line.
    const error = mapClaudeStreamError({ status: 503, message: "x" });
    expect(error.details).toHaveProperty("upstreamStatus", 503);
    expect(error.details).not.toHaveProperty("providerStatus");
  });
});

describe("the two Claude paths agree on classification", () => {
  test("the same status and identifier produce the same code and origin", () => {
    // The module's stated contract: "the classifier is the single authority for
    // codes, retries, and credential evidence". A divergence here would mean a
    // retry decision differing by transport, which is the bug this pins out.
    const cases: ReadonlyArray<{ status: number; body: string }> = [
      { status: 401, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 403, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 404, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 413, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 429, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 500, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 503, body: JSON.stringify({ error: { message: "m" } }) },
      { status: 529, body: JSON.stringify({ error: { message: "m" } }) },
    ];
    for (const { status, body } of cases) {
      const http = mapClaudeHttpError(status, body);
      const stream = mapClaudeStreamError({ status, message: "m" });
      expect(`${http.code}/${http.status}/${http.origin}`).toBe(
        `${stream.code}/${stream.status}/${stream.origin}`,
      );
    }
  });

  test("both paths mark credential evidence for the same auth identifier", () => {
    const http = mapClaudeHttpError(401, JSON.stringify({ error: { type: "invalid_api_key" } }));
    const stream = mapClaudeStreamError({ type: "invalid_api_key" });
    expect(http.details).toHaveProperty("credentialEvidence", true);
    expect(stream.details).toHaveProperty("credentialEvidence", true);
  });

  test("both paths mark the rate-limit scope for a quota identifier", () => {
    const http = mapClaudeHttpError(429, JSON.stringify({ error: { type: "rate_limit_error" } }));
    const stream = mapClaudeStreamError({ type: "rate_limit_error" });
    expect(http.details).toHaveProperty("rateLimitScope", "provider");
    expect(stream.details).toHaveProperty("rateLimitScope", "provider");
  });

  test("both paths report a proxy auth failure with the network origin", () => {
    expect(mapClaudeHttpError(407, "{}").origin).toBe("network");
    expect(mapClaudeStreamError({ status: 407 }).origin).toBe("network");
  });
});

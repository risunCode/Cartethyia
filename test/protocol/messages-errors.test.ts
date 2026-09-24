import { describe, expect, test } from "bun:test";
import { mapClaudeHttpError, mapClaudeStreamError } from "../../src/protocol/messages-errors";

describe("mapClaudeHttpError", () => {
  test("401 maps to authentication_failed with upstream request id preserved", () => {
    const headers = new Headers({ "x-request-id": "req-123" });
    const err = mapClaudeHttpError(
      401,
      JSON.stringify({ error: { code: "invalid_token", message: "bad" } }),
      headers,
    );
    expect(err.code).toBe("authentication_failed");
    expect(err.details["upstreamRequestId"]).toBe("req-123");
    expect(err.details["credentialEvidence"]).toBe(true);
    expect(err.details["providerCode"]).toBe("invalid_token");
  });

  test("429 maps to quota_exceeded", () => {
    const err = mapClaudeHttpError(429, "slow down");
    expect(err.code).toBe("quota_exceeded");
    expect(err.details["rateLimitScope"]).toBe("provider");
  });
});

describe("mapClaudeStreamError", () => {
  test("shares the HTTP status table for proxy/capacity/5xx failures", () => {
    expect(mapClaudeStreamError({ status: 407, message: "proxy auth" }).code).toBe(
      "proxy_auth_required",
    );
    expect(mapClaudeStreamError({ status: 407 }).origin).toBe("network");
    expect(mapClaudeStreamError({ status: 529, message: "overloaded" }).code).toBe(
      "capacity_exhausted",
    );
    expect(mapClaudeStreamError({ status: 529 }).details["rateLimitScope"]).toBe("provider");
    expect(mapClaudeStreamError({ status: 500, message: "boom" }).code).toBe(
      "platform_unavailable",
    );
    expect(mapClaudeStreamError({ status: 503 }).code).toBe("platform_unavailable");
  });

  test("carries provider code and upstream request id", () => {
    const err = mapClaudeStreamError(
      { status: 400, code: "invalid_request_error", message: "bad" },
      new Headers({ "x-request-id": "req-sse-1" }),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.details["providerCode"]).toBe("invalid_request_error");
    expect(err.details["upstreamRequestId"]).toBe("req-sse-1");
  });

  test("missing status is an upstream 502 platform failure", () => {
    const err = mapClaudeStreamError({ message: "broken" });
    expect(err.status).toBe(502);
    expect(err.code).toBe("platform_unavailable");
    expect(err.message).toBe("broken");
  });
});

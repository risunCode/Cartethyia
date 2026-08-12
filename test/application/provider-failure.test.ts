import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  normalizeProviderFailure,
  sanitizeMessage,
  type ProviderCallError,
  type ProviderFailureCode,
} from "../../src/application/contracts";

const baseError: ProviderCallError = {
  statusCode: null,
  kind: "provider_protocol_error",
  retryable: true,
  routeScope: "provider",
  source: "upstream",
  sanitizedMessage: "upstream failure",
  retryAt: null,
};

function expectCode(input: Parameters<typeof classifyProviderFailure>[0], code: ProviderFailureCode): void {
  expect(classifyProviderFailure(input)).toBe(code);
}

describe("stable provider failure classification", () => {
  test("prioritizes caller abort and timeout phase over misleading provider text", () => {
    expectCode({ callerAborted: true, phase: "idle", statusCode: 429, message: "quota exceeded" }, "caller_aborted");
    expectCode({ phase: "pre_response", statusCode: 429, message: "rate limit" }, "stream_pre_response_timeout");
    expectCode({ phase: "idle", message: "context too long" }, "stream_idle_timeout");
    expectCode({ phase: "total", message: "empty response" }, "stream_total_timeout");
  });

  test("maps status and structured provider codes before bounded message text", () => {
    expectCode({ statusCode: 401, message: "rate limit" }, "auth_invalidated");
    expectCode({ statusCode: 403 }, "auth_invalidated");
    expectCode({ statusCode: 402 }, "usage_limit");
    expectCode({ statusCode: 413, message: "unsupported parameter" }, "context_overflow");
    expectCode({ statusCode: 429, message: "quota exceeded" }, "usage_limit");
    expectCode({ statusCode: 429, message: "try again later" }, "rate_limit_transient");
    expectCode({ structuredCode: { error: { code: "invalid_previous_response" } }, message: "unknown" }, "stale_response_state");
    expectCode({ structuredCode: "tool_schema_rejected", message: "optional parameter unsupported" }, "tool_schema_rejected");
  });

  test("classifies bounded body states and provider message categories", () => {
    expectCode({ bodyState: "empty" }, "empty_provider_body");
    expectCode({ bodyState: "truncated" }, "provider_finish_error");
    expectCode({ message: "The model context length exceeded the maximum" }, "context_overflow");
    expectCode({ message: "content_filter policy violation" }, "content_blocked");
    expectCode({ message: "Unsupported parameter: response_format" }, "optional_parameter_rejected");
    expectCode({ message: "invalid tool schema" }, "tool_schema_rejected");
    expectCode({ message: "response ended before a terminal event" }, "provider_finish_error");
    expectCode({ message: "previous_response_id is stale" }, "stale_response_state");
    expectCode({ message: "credential invalid or token expired" }, "auth_invalidated");
  });

  test("normalizes to a bounded generic diagnostic without raw secrets or payloads", () => {
    const normalized = normalizeProviderFailure(
      { ...baseError, statusCode: 400 },
      {
        message: 'Unsupported parameter: tools; prompt="do not leak this" authorization: Bearer super-secret-token',
      },
    );
    expect(normalized.failureCode).toBe("optional_parameter_rejected");
    expect(normalized.sanitizedMessage).toBe("Provider rejected an optional parameter");
    expect(normalized.sanitizedMessage).not.toContain("do not leak this");
    expect(normalized.sanitizedMessage).not.toContain("super-secret-token");
    expect(normalized.sanitizedMessage).not.toContain("tools");
  });

  test("sanitizeMessage redacts credentials while bounded diagnostics redact structured request fields", () => {
    expect(sanitizeMessage("Authorization: Bearer top-secret")).toBe("Authorization: Bearer [redacted]");
    expect(sanitizeMessage("api_key=secret-value")).toBe("credential=[redacted]");
    const normalized = normalizeProviderFailure(baseError, {
      message: '{"prompt":"private instructions","tool_arguments":{"secret":"value"},"body":"raw provider body"}',
    });
    expect(normalized.sanitizedMessage).toBe("Provider request failed");
    expect(normalized.sanitizedMessage).not.toMatch(/private instructions|secret|raw provider body/);
  });

  test("falls back to the bounded unknown code for unrecognized failures", () => {
    expectCode({ statusCode: 418, message: "teapot" }, "unknown_provider_failure");
    expectCode({ structuredCode: "new_vendor_code", message: "new vendor detail" }, "unknown_provider_failure");
    expectCode({ kind: "client_aborted" }, "caller_aborted");
  });
});

import { describe, expect, test } from "bun:test";
import { gatewayErrorFromStreamError } from "../../src/protocol/stream-error-frames";
import type { GatewayError } from "../../src/transport/gateway-error";

/**
 * The classifier for an explicit error frame that arrives inside a 200 OK.
 *
 * The chat, responses, and codex decoders used to record such a frame only as
 * a `failed` terminal, so the client received no `error.code` and telemetry
 * recorded `unknown_error` for a failure the upstream had described perfectly
 * well. These tests pin the classification and the surface wiring in
 * `test/protocol/response/stream-error-frames.test.ts`.
 */
describe("gatewayErrorFromStreamError", () => {
  function classify(error: unknown): GatewayError {
    const result = gatewayErrorFromStreamError(error, "fallback label");
    if (result === undefined) throw new Error("expected a classified error");
    return result;
  }

  test("returns undefined for a frame that carries no error", () => {
    expect(gatewayErrorFromStreamError(undefined, "label")).toBeUndefined();
    expect(gatewayErrorFromStreamError(null, "label")).toBeUndefined();
    expect(gatewayErrorFromStreamError(42, "label")).toBeUndefined();
    expect(gatewayErrorFromStreamError([], "label")).toBeUndefined();
  });

  test("classifies a rate-limit identifier as quota, never as a client fault", () => {
    for (const type of ["rate_limit_exceeded", "rate_limit_error", "insufficient_quota", "usage_limit_reached"]) {
      const error = classify({ type, message: "slow down" });
      expect(error).toMatchObject({ code: "quota_exceeded", status: 429, origin: "upstream" });
      // A provider-scoped limit is what cools the pool down.
      expect(error.details["rateLimitScope"]).toBe("provider");
    }
  });

  test("classifies an overload identifier as an upstream outage", () => {
    for (const type of ["overloaded_error", "server_error", "model_at_capacity", "server_is_overloaded"]) {
      expect(classify({ type })).toMatchObject({ code: "platform_unavailable", status: 502, origin: "upstream" });
    }
  });

  test("classifies an auth identifier with credential evidence", () => {
    const error = classify({ type: "authentication_error", message: "bad key" });
    expect(error).toMatchObject({ code: "authentication_failed", status: 401, origin: "upstream" });
    expect(error.details["credentialEvidence"]).toBe(true);
  });

  test("an explicit status on the frame outranks the identifier", () => {
    // A frame that states its own status is describing the upstream response
    // it came from, so the status table is the authority.
    const error = classify({ type: "overloaded_error", status: 503 });
    expect(error).toMatchObject({ code: "platform_unavailable", status: 503 });
    expect(error.details["providerStatus"]).toBe(503);
  });

  test("names a context overflow even inside a 200 OK", () => {
    const error = classify({ code: "context_length_exceeded", message: "too long" });
    expect(error).toMatchObject({ code: "context_length_exceeded", status: 413, origin: "upstream" });
  });

  test("keeps a bare string error as an upstream failure", () => {
    expect(classify("Not Found")).toMatchObject({ code: "platform_unavailable", status: 502 });
  });

  test("falls back to a platform failure when the frame names nothing", () => {
    // The upstream declared a failure and we cannot say more. That is honest;
    // guessing `invalid_request` would blame the client for the provider's
    // problem and invite an identical retry.
    const error = classify({ message: "something went wrong" });
    expect(error).toMatchObject({ code: "platform_unavailable", status: 502, origin: "upstream" });
    expect(error.message).toBe("something went wrong");
  });

  test("never classifies from message prose", () => {
    // A substring rule like `{ text: "capacity" }` fires on any message
    // containing the word — including text the client itself wrote.
    const error = classify({ message: "the capacity of my request was described by the client" });
    expect(error.code).toBe("platform_unavailable");
  });

  test("uses the caller's label when the frame carries no message", () => {
    expect(classify({ type: "server_error" }).message).toBe("fallback label");
  });
});

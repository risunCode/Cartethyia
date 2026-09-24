import { describe, expect, test } from "bun:test";
import { decodeGeminiStreamEvent } from "../../../src/protocol/response/gemini";
import { GatewayError } from "../../../src/transport/gateway-error";

/**
 * The Gemini-family SSE line policy, shared by the Gemini and Antigravity
 * decoders. It was written out twice, verbatim, before this module owned it.
 *
 * The `[DONE]` marker is deliberately *not* this function's concern: Gemini
 * skips it and keeps reading, Antigravity stops. That difference stays at each
 * call site, so it is asserted here as "the decoder passes the marker through"
 * rather than as a decoder behaviour.
 */
describe("decodeGeminiStreamEvent", () => {
  test("returns the parsed object for a JSON payload", () => {
    expect(decodeGeminiStreamEvent('{"candidates":[]}', "x stream error")).toEqual({
      candidates: [],
    });
  });

  test("returns undefined for an empty or whitespace-only payload", () => {
    expect(decodeGeminiStreamEvent("", "x stream error")).toBeUndefined();
    expect(decodeGeminiStreamEvent("   ", "x stream error")).toBeUndefined();
  });

  test("returns undefined for a JSON value that is not an object", () => {
    // A bare number/string/array is not a Gemini envelope; ignoring it keeps a
    // stray keepalive from failing the stream.
    expect(decodeGeminiStreamEvent("42", "x stream error")).toBeUndefined();
    expect(decodeGeminiStreamEvent('"keepalive"', "x stream error")).toBeUndefined();
    expect(decodeGeminiStreamEvent("[1,2]", "x stream error")).toBeUndefined();
    expect(decodeGeminiStreamEvent("null", "x stream error")).toBeUndefined();
  });

  test("passes the [DONE] marker through, because its meaning is per-caller", () => {
    // Not JSON — the caller must have handled it before calling. The decoder
    // rejects it as malformed rather than silently swallowing it, so a caller
    // that forgets the marker check fails loudly instead of truncating.
    expect(() => decodeGeminiStreamEvent("[DONE]", "x stream error")).toThrow(GatewayError);
  });

  test("throws a 502 for malformed JSON instead of reading it as a short success", () => {
    let caught: unknown;
    try {
      decodeGeminiStreamEvent("{not json", "x stream error");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).code).toBe("platform_unavailable");
    expect((caught as GatewayError).status).toBe(502);
    // The corrupt bytes are the upstream's, so the envelope must not blame the
    // gateway: `origin: "upstream"` is what keeps "Cartethyia Error:" off it.
    expect((caught as GatewayError).origin).toBe("upstream");
    expect((caught as GatewayError).message).toStartWith("Malformed SSE event: ");
  });

  test("throws a 502 for an upstream error envelope, using the caller's label", () => {
    const withMessage = () =>
      decodeGeminiStreamEvent('{"error":{"message":"quota exceeded"}}', "Gemini stream error");
    let caught: unknown;
    try {
      withMessage();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).code).toBe("platform_unavailable");
    expect((caught as GatewayError).status).toBe(502);
    expect((caught as GatewayError).origin).toBe("upstream");
    expect((caught as GatewayError).message).toBe("quota exceeded");
  });

  test("falls back to the caller's label when the error envelope carries no message", () => {
    // This is the one real divergence the two callers kept: an operator reading
    // the error must be able to tell which upstream produced it.
    for (const label of ["Gemini stream error", "antigravity stream error"]) {
      let caught: unknown;
      try {
        decodeGeminiStreamEvent('{"error":{"code":429}}', label);
      } catch (error) {
        caught = error;
      }
      expect((caught as GatewayError).message).toBe(label);
    }
  });

  test("caps an upstream error message at 500 characters", () => {
    const long = "x".repeat(900);
    let caught: unknown;
    try {
      decodeGeminiStreamEvent(JSON.stringify({ error: { message: long } }), "x stream error");
    } catch (error) {
      caught = error;
    }
    expect((caught as GatewayError).message).toHaveLength(500);
  });
});

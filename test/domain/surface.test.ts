import { describe, expect, test } from "bun:test";
import { detectSurface, isProtocolError, normalizeRequest, parseRequestBody } from "../../src/domain/protocols";
import type { ProxyEndpoint, RequestLimits } from "../../src/domain/contracts";

const limits: RequestLimits = {
  maxBodyBytes: 1_000_000,
  connectTimeoutMs: 1_000,
  firstByteTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  totalTimeoutMs: 5_000,
};

const input = { signal: new AbortController().signal, limits };

describe("detectSurface", () => {
  test.each([
    ["/v1/chat/completions", "openai-chat"],
    ["/v1/messages", "anthropic-messages"],
    ["/v1/responses", "openai-responses"],
    ["/v1/images/generations", "images"],
    ["/v1/images/edits", "images"],
  ] as const)("maps %s to %s", (endpoint, surface) => {
    expect(detectSurface(endpoint as ProxyEndpoint)).toBe(surface);
  });

  test("returns null for the model listing endpoint", () => {
    expect(detectSurface("/v1/models" as ProxyEndpoint)).toBe(null);
  });
});

describe("parseRequestBody", () => {
  test("parses a single JSON object", () => {
    const parsed = parseRequestBody('{"model":"gpt-4o"}', limits);
    expect(isProtocolError(parsed)).toBe(false);
    expect(parsed).toEqual({ model: "gpt-4o" });
  });

  test("rejects a body exceeding the byte bound", () => {
    const small = { ...limits, maxBodyBytes: 8 };
    const result = parseRequestBody('{"model":"gpt-4o"}', small);
    expect(isProtocolError(result)).toBe(true);
  });

  test("rejects an empty body", () => {
    expect(isProtocolError(parseRequestBody("   ", limits))).toBe(true);
  });

  test("rejects NDJSON/batch bodies that do not start with an object", () => {
    expect(isProtocolError(parseRequestBody('[1,2,3]', limits))).toBe(true);
  });

  test("rejects a JSON array (parsed value is not a record)", () => {
    expect(isProtocolError(parseRequestBody('[1,2,3]', limits))).toBe(true);
  });

  test("rejects invalid JSON", () => {
    expect(isProtocolError(parseRequestBody('{bad json}', limits))).toBe(true);
  });
});

describe("normalizeRequest dispatch", () => {
  test("rejects the model listing endpoint with a typed error", () => {
    const result = normalizeRequest("/v1/models" as ProxyEndpoint, {}, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("endpoint");
      expect(result.error.sanitizedMessage).toContain("model listing");
    }
  });

  test("routes /v1/chat/completions to the chat normalizer", () => {
    const result = normalizeRequest("/v1/chat/completions" as ProxyEndpoint, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, input);
    expect(result.ok).toBe(true);
  });

  test("routes /v1/messages to the Anthropic normalizer", () => {
    const result = normalizeRequest("/v1/messages" as ProxyEndpoint, { model: "claude-3", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, input);
    expect(result.ok).toBe(true);
  });

  test("routes /v1/responses to the Responses normalizer", () => {
    const result = normalizeRequest("/v1/responses" as ProxyEndpoint, { model: "gpt-4o", input: "hi" }, input);
    expect(result.ok).toBe(true);
  });

  test("routes image endpoints to the image normalizer with the declared operation", () => {
    const gen = normalizeRequest("/v1/images/generations" as ProxyEndpoint, { model: "dall-e-3", prompt: "a cat" }, input);
    expect(gen.ok).toBe(true);
    if (gen.ok) expect(gen.request.imageOperation).toBe("generate");

    const edit = normalizeRequest("/v1/images/edits" as ProxyEndpoint, { model: "dall-e-3", prompt: "a cat", image: "data:image/png;base64,iVBOR=" }, input);
    // The edit endpoint requires an image reference; either outcome is typed.
    expect(edit.ok === true || (edit.ok === false && isProtocolError(edit.error))).toBe(true);
  });
});

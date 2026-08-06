import { describe, expect, test } from "bun:test";
import { readBoundedJson } from "../../src/domain/protocols/body";

/** Builds a Request with a given body string and optional content-length override. */
function makeRequest(body: string, contentLength?: number | null): Request {
  const headers = new Headers();
  if (contentLength !== undefined && contentLength !== null) headers.set("content-length", String(contentLength));
  else if (contentLength !== null) headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  return new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers,
    body,
  });
}

/** Builds a Request whose stream emits the given chunks separately. */
function makeChunkedRequest(chunks: readonly string[], contentLength?: number): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  });
}

describe("readBoundedJson", () => {
  describe("content-length pre-check", () => {
    test("rejects when content-length exceeds the byte limit before reading", async () => {
      const req = makeRequest('{"model":"gpt-4o"}', 1_000_000);
      const result = await readBoundedJson(req, 100);
      expect(result).toEqual({ ok: false, reason: "too_large" });
    });

    test("allows a body whose content-length is within the limit", async () => {
      const req = makeRequest('{"model":"gpt-4o"}');
      const result = await readBoundedJson(req, 100);
      expect(result.ok).toBe(true);
    });

    test("ignores a non-finite content-length and falls through to streaming", async () => {
      const req = makeRequest('{"ok":true}', Number.NaN);
      const result = await readBoundedJson(req, 100);
      expect(result.ok).toBe(true);
    });
  });

  describe("mid-stream overflow detection", () => {
    test("rejects when accumulated bytes exceed the limit during read", async () => {
      // content-length not set; the body is 18 bytes, limit is 8.
      const req = makeChunkedRequest(['{"model":"gpt-4o"}']);
      const result = await readBoundedJson(req, 8);
      expect(result).toEqual({ ok: false, reason: "too_large" });
    });

    test("detects overflow across multiple chunks", async () => {
      // Two chunks of 5 bytes each = 10 total; limit is 8.
      const req = makeChunkedRequest(["AAAAA", "BBBBB"]);
      const result = await readBoundedJson(req, 8);
      expect(result).toEqual({ ok: false, reason: "too_large" });
    });
  });

  describe("boundary: exactly at limit vs limit+1", () => {
    const payload = '{"xx":1}'; // 8 bytes
    test("exactly at limit passes", async () => {
      const req = makeRequest(payload);
      const result = await readBoundedJson(req, 8);
      expect(result.ok).toBe(true);
    });

    test("limit+1 is rejected as too_large via content-length", async () => {
      const req = makeRequest(payload, 9);
      const result = await readBoundedJson(req, 7);
      expect(result).toEqual({ ok: false, reason: "too_large" });
    });

    test("limit+1 is rejected as too_large during streaming", async () => {
      const req = makeChunkedRequest([payload], undefined);
      const result = await readBoundedJson(req, 7);
      expect(result).toEqual({ ok: false, reason: "too_large" });
    });
  });

  describe("error classification", () => {
    test("too_large is distinct from invalid_json", async () => {
      const tooLarge = await readBoundedJson(makeRequest('{"a":1}', 999), 10);
      const invalid = await readBoundedJson(makeRequest("{bad json}"), 1_000);
      expect(tooLarge).toEqual({ ok: false, reason: "too_large" });
      expect(invalid).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("null / empty body handling", () => {
    test("null body yields invalid", async () => {
      const req = new Request("https://proxy.local/v1/chat/completions", { method: "POST" });
      const result = await readBoundedJson(req, 1_000);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    test("empty string body yields invalid (JSON.parse fails on empty)", async () => {
      const req = makeRequest("");
      const result = await readBoundedJson(req, 1_000);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("malformed JSON", () => {
    test("truncated JSON is invalid", async () => {
      const req = makeRequest('{"model":"gpt');
      const result = await readBoundedJson(req, 1_000);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    test("JSON with trailing garbage is invalid", async () => {
      const req = makeRequest('{"ok":true} extra');
      const result = await readBoundedJson(req, 1_000);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    test("non-JSON text is invalid", async () => {
      const req = makeRequest("not json at all");
      const result = await readBoundedJson(req, 1_000);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("valid JSON object pass-through", () => {
    test("parses a simple object", async () => {
      const req = makeRequest('{"model":"gpt-4o","stream":true}');
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ model: "gpt-4o", stream: true });
    });

    test("parses a nested object", async () => {
      const payload = '{"data":{"nested":{"deep":42}}}';
      const req = makeRequest(payload);
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ data: { nested: { deep: 42 } } });
    });

    test("parses a unicode-containing object", async () => {
      const payload = '{"msg":"héllo 🌍"}';
      const req = makeRequest(payload);
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect((result.value as { msg: string }).msg).toBe("héllo 🌍");
    });
  });

  describe("non-object JSON rejection", () => {
    test("a JSON array is parsed successfully (value is an array)", async () => {
      const req = makeRequest("[1,2,3]");
      const result = await readBoundedJson(req, 1_000);
      // readBoundedJson returns whatever JSON.parse yields; it does not enforce object-only.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([1, 2, 3]);
    });

    test("a JSON string is parsed successfully (value is a string)", async () => {
      const req = makeRequest('"hello"');
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("hello");
    });

    test("a JSON number is parsed successfully (value is a number)", async () => {
      const req = makeRequest("42");
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(42);
    });

    test("JSON null is parsed successfully (value is null)", async () => {
      const req = makeRequest("null");
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(null);
    });

    test("JSON boolean is parsed successfully", async () => {
      const req = makeRequest("true");
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(true);
    });
  });

  describe("multi-chunk valid body", () => {
    test("assembles chunks split across the stream into a valid object", async () => {
      const req = makeChunkedRequest(['{"mode', 'l":"gp', 't-4o"}']);
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ model: "gpt-4o" });
    });

    test("uses content-length pre-allocation when provided", async () => {
      // content-length exactly matches the body; the pre-allocated buffer path is exercised.
      const payload = '{"a":1,"b":2}';
      const req = makeChunkedRequest([payload], new TextEncoder().encode(payload).byteLength);
      const result = await readBoundedJson(req, 1_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ a: 1, b: 2 });
    });
  });
});

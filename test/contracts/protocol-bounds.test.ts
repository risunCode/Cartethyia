import { describe, expect, test } from "bun:test";
import { applyCachePlan, buildCachePlan, looksStableText, markCacheSections } from "../../src/domain/cache";
import {
  MAX_DATA_URL_LENGTH,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_URL_LENGTH,
  MAX_MEDIA_TYPE_LENGTH,
  MAX_MESSAGE_COUNT,
  MAX_TEXT_BLOCK_LENGTH,
  MAX_TOOL_ARGUMENT_LENGTH,
  MAX_TOOL_CALLS_PER_MESSAGE,
  MAX_TOOL_COUNT,
  MAX_TOOL_DESCRIPTION_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_SCHEMA_LENGTH,
  classifyImageReference,
  normalizeRequest,
  type NormalizeInput,
} from "../../src/domain/protocols";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function normalizeInput(signal = new AbortController().signal): NormalizeInput {
  return { signal, limits };
}

describe("image reference bounds and SSRF safety", () => {
  test("rejects private, loopback, link-local, and reserved image URLs", () => {
    for (const url of [
      "http://127.0.0.1/x.png",
      "http://localhost/x.png",
      "http://10.1.2.3/x.png",
      "http://172.16.0.1/x.png",
      "http://192.168.1.9/x.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/x.png",
      "http://[::ffff:127.0.0.1]/x.png",
      "http://0.0.0.0/x.png",
      "https://router.local/x.png",
      "http://intranet/x.png",
      "http://user:pass@example.com/x.png",
      "ftp://example.com/x.png",
      "",
      "not a url",
    ]) {
      const classification = classifyImageReference(url, "messages[0].content[0].image_url.url");
      expect({ url, ok: classification.ok }).toMatchObject({ url, ok: false });
    }
  });

  test("accepts public https and bounded data URLs", () => {
    const https = classifyImageReference("https://example.com/x.png", "field");
    expect(https.ok).toBe(true);
    if (https.ok) expect(https.reference).toEqual({ kind: "url", value: "https://example.com/x.png", mediaType: null });

    const data = classifyImageReference("data:image/png;base64,AAAA", "field");
    expect(data.ok).toBe(true);
    if (data.ok) expect(data.reference.kind).toBe("data");
  });

  test("rejects inline images past the byte cap and media types past the length cap", () => {
    const oversized = classifyImageReference(`data:image/png;base64,${"A".repeat(MAX_DATA_URL_LENGTH)}`, "field");
    expect(oversized.ok).toBe(false);

    const longMediaType = classifyImageReference(`data:${"a".repeat(MAX_MEDIA_TYPE_LENGTH + 1)};base64,AAAA`, "field");
    expect(longMediaType.ok).toBe(false);

    const longUrl = classifyImageReference(`https://example.com/${"x".repeat(MAX_IMAGE_URL_LENGTH)}`, "field");
    expect(longUrl.ok).toBe(false);
  });

  test("normalization rejects private image URLs before provider selection", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/steal.png" } }] }],
    }, normalizeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_request");
  });

  test("enforces the global image count bound per request", () => {
    const imageBlocks = Array.from({ length: MAX_IMAGE_COUNT + 1 }, (_, index) => ({
      type: "image_url",
      image_url: { url: `https://example.com/${index}.png` },
    }));
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: imageBlocks }],
    }, normalizeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toContain("image_url");
      expect(result.error.sanitizedMessage).toContain("64 images");
    }
  });

  test("normalization rejects image URLs with unsupported schemes", () => {
    const result = normalizeRequest("/v1/responses", {
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "file:///tmp/x.png" }] }],
    }, normalizeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toContain("image_url");
  });
});

describe("tool, message, and reasoning bounds", () => {
  test("rejects more tools than the catalog allows", () => {
    const tools = Array.from({ length: MAX_TOOL_COUNT + 1 }, (_, index) => ({
      type: "function",
      function: { name: `tool-${index}`, parameters: { type: "object" } },
    }));
    const result = normalizeRequest("/v1/chat/completions", { model: "gpt-5", messages: [{ role: "user", content: "hi" }], tools }, normalizeInput());
    expect(result.ok).toBe(false);
  });

  test("rejects tool schemas, names, and descriptions past their caps", () => {
    const hugeSchema = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { padding: "x".repeat(MAX_TOOL_SCHEMA_LENGTH + 1) } } }],
    }, normalizeInput());
    expect(hugeSchema.ok).toBe(false);
    if (!hugeSchema.ok) expect(hugeSchema.error.field).toContain("parameters");

    const longName = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t".repeat(MAX_TOOL_NAME_LENGTH + 1), parameters: { type: "object" } } }],
    }, normalizeInput());
    expect(longName.ok).toBe(false);

    const longDescription = normalizeRequest("/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", description: "d".repeat(MAX_TOOL_DESCRIPTION_LENGTH + 1), input_schema: { type: "object" } }],
    }, normalizeInput());
    expect(longDescription.ok).toBe(false);
    if (!longDescription.ok) expect(longDescription.error.field).toContain("description");
  });

  test("bounds tool-call argument payloads on every surface", () => {
    const chatCalls = [{ id: "call_1", type: "function", function: { name: "f", arguments: "y".repeat(MAX_TOOL_ARGUMENT_LENGTH + 1) } }];
    const chat = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "assistant", content: "", tool_calls: chatCalls }],
    }, normalizeInput());
    expect(chat.ok).toBe(false);
    if (!chat.ok) expect(chat.error.field).toContain("arguments");

    const responses = normalizeRequest("/v1/responses", {
      model: "gpt-5",
      input: [{ type: "function_call", call_id: "call_1", name: "f", arguments: "y".repeat(MAX_TOOL_ARGUMENT_LENGTH + 1) }],
    }, normalizeInput());
    expect(responses.ok).toBe(false);

    const messages = normalizeRequest("/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: { padding: "z".repeat(MAX_TOOL_ARGUMENT_LENGTH + 1) } }] }],
    }, normalizeInput());
    expect(messages.ok).toBe(false);
    if (!messages.ok) expect(messages.error.field).toContain("input");
  });

  test("bounds message counts, block counts, and text blocks", () => {
    const tooMany = Array.from({ length: MAX_MESSAGE_COUNT + 1 }, () => ({ role: "user", content: "x" }));
    expect(normalizeRequest("/v1/chat/completions", { model: "gpt-5", messages: tooMany }, normalizeInput()).ok).toBe(false);

    const longBlock = Array.from({ length: MAX_TEXT_BLOCK_LENGTH + 1 }, () => "x").join("");
    expect(normalizeRequest("/v1/chat/completions", { model: "gpt-5", messages: [{ role: "user", content: longBlock }] }, normalizeInput()).ok).toBe(false);
  });

  test("rejects too many tool calls on a single assistant message", () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_MESSAGE + 1 }, (_, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: "f", arguments: "{}" },
    }));
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "assistant", content: "", tool_calls: calls }],
    }, normalizeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toContain("tool_calls");
  });

  test("keeps tool call names, ids, and description limits", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f".repeat(MAX_TOOL_NAME_LENGTH + 1) } }],
    }, normalizeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toContain("tools[0].function.name");
  });
});

describe("cache section bounds", () => {
  test("detects unstable text that breaks prefix identity", () => {
    expect(looksStableText("static instructions")).toBe(true);
    expect(looksStableText("shipped at 2026-08-04T12:00:00Z")).toBe(false);
    expect(looksStableText("id 550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(looksStableText("-----BEGIN RSA PRIVATE KEY-----")).toBe(false);
  });

  test("keeps the cache boundary before unstable content", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [
        { role: "system", content: "stable instructions" },
        { role: "user", content: "2026-08-04T12:00:00Z report" },
        { role: "user", content: "follow-up" },
      ],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = buildCachePlan(result.request);
    expect(plan.hasStablePrefix).toBe(true);
    expect(plan.prefixEndMessageIndex).toBe(0);
    // Unstable user content is never part of the fingerprint.
    expect(plan.prefixFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const marked = applyCachePlan(result.request, plan);
    expect(marked.messages[0]?.content[0]?.cacheControl).toBe("ephemeral");
    expect(marked.messages[1]?.content[0]?.cacheControl).toBeUndefined();
  });

  test("ends the cache prefix before mutable tool results", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [
        { role: "system", content: "stable" },
        { role: "user", content: "look up x" },
        { role: "tool", tool_call_id: "call_1", content: "result: 42" },
      ],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sections = markCacheSections(result.request);
    expect(sections.at(-1)?.kind).toBe("dynamic");
    const plan = buildCachePlan(result.request);
    expect(plan.hasStablePrefix).toBe(true);
    expect(plan.prefixEndMessageIndex).toBe(1);
  });

  test("fingerprints are deterministic and change with content or tools", () => {
    const body = {
      model: "gpt-5",
      messages: [{ role: "system", content: "stable" }, { role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    };
    const first = normalizeRequest("/v1/chat/completions", body, normalizeInput());
    const second = normalizeRequest("/v1/chat/completions", body, normalizeInput());
    if (!first.ok || !second.ok) return;
    expect(buildCachePlan(first.request).prefixFingerprint).toBe(buildCachePlan(second.request).prefixFingerprint);

    const changed = normalizeRequest("/v1/chat/completions", { ...body, messages: [{ role: "system", content: "different" }, { role: "user", content: "hello" }] }, normalizeInput());
    if (!changed.ok) return;
    expect(buildCachePlan(changed.request).prefixFingerprint).not.toBe(buildCachePlan(first.request).prefixFingerprint);

    const noTools = normalizeRequest("/v1/chat/completions", { ...body, tools: [] }, normalizeInput());
    if (!noTools.ok) return;
    expect(buildCachePlan(noTools.request).prefixFingerprint).not.toBe(buildCachePlan(first.request).prefixFingerprint);
  });
});
import { describe, expect, test } from "bun:test";
import { applyCachePlan, buildCachePlan } from "../../src/domain/cache";
import { normalizeRequest, type NormalizeInput } from "../../src/domain/protocols";
import { buildChatPayload, mapChatUsage, toOpenAIImageUrl } from "../../src/domain/protocols/openai-chat";
import { ProtocolCodecError } from "../../src/domain/protocols/errors";
import { buildResponsesPayload, mapResponsesUsage } from "../../src/domain/protocols/openai-responses";
import { buildMessagesPayload, mapAnthropicUsage } from "../../src/domain/protocols/anthropic-messages";
import { AnthropicAdapter } from "../../src/providers/anthropic";
import type { NormalizedProviderRequest } from "../../src/domain/contracts";

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

function anthropicCapabilities() {
  return new AnthropicAdapter().capabilities;
}

function manualRequest(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

describe("Image generation and edit normalization", () => {
  test("normalizes generation prompts into the canonical image request", () => {
    const result = normalizeRequest("/v1/images/generations", { model: "gpt-5", prompt: "A neon koi pond at night" }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.sourceSurface).toBe("images");
    expect(result.request.imageOperation).toBe("generate");
    expect(result.request.messages[0]?.content[0]).toEqual({ type: "text", text: "A neon koi pond at night" });
  });

  test("normalizes image edits and preserves bounded input references", () => {
    const result = normalizeRequest("/v1/images/edits", { model: "gpt-5", prompt: "Add a moon", images: ["data:image/png;base64,AAAA"] }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.imageOperation).toBe("edit");
    expect(result.request.images).toEqual([{ kind: "data", value: "data:image/png;base64,AAAA", mediaType: "image/png" }]);
    expect(result.request.messages[0]?.content).toHaveLength(2);
  });

  test("rejects edits without an input image", () => {
    const result = normalizeRequest("/v1/images/edits", { model: "gpt-5", prompt: "Edit this" }, normalizeInput());
    expect(result.ok).toBe(false);
  });
});

describe("OpenAI chat normalization and payload conversion", () => {
  test("converts normalized chat requests into the wire payload", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      stream: true,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello" },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Look things up", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
      reasoning_effort: "high",
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = buildChatPayload(result.request);
    expect(payload.model).toBe("gpt-5");
    expect(payload.stream).toBe(true);
    expect(payload.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello" },
    ]);
    expect(payload.tools).toEqual([
      { type: "function", function: { name: "lookup", description: "Look things up", parameters: { type: "object", properties: { q: { type: "string" } } } } },
    ]);
    expect(payload.max_tokens).toBe(256);
    expect(payload.response_format).toEqual({ type: "json_object" });
    // Requested "high" effort is narrowed to the adapter's supported effort.
    expect(payload.reasoning_effort).toBe("medium");
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(payload.prompt_cache_key).toBeUndefined();
  });

  test("round-trips assistant tool calls and tool results through chat payloads", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-5",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: '{"answer":42}' },
      ],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = buildChatPayload(result.request);
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
    });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"answer":42}' });
  });

  test("embeds normalized images as image_url blocks in chat payloads", () => {
    const result = normalizeRequest("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "https://example.com/cat.png" } }] }],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = buildChatPayload(result.request);
    const content = (payload.messages as Array<Record<string, unknown>>)[0]?.content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "https://example.com/cat.png" } });
  });

  test("always surfaces cached-token usage from the upstream response", () => {
    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 4 } };
    expect(mapChatUsage(usage)).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 4 });
    expect(mapChatUsage({ prompt_tokens: 1, completion_tokens: 2 }).cacheReadTokens).toBeNull();
  });
});

describe("OpenAI responses normalization and payload conversion", () => {
  test("round-trips input items and tools into the responses wire payload", () => {
    const result = normalizeRequest("/v1/responses", {
      model: "gpt-5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"answer":42}' },
      ],
      tools: [{ type: "function", name: "lookup", description: "Look things up", parameters: { type: "object" } }],
      max_output_tokens: 512,
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = buildResponsesPayload(result.request);
    expect(payload.model).toBe("gpt-5");
    expect(payload.max_output_tokens).toBe(512);
    expect(payload.tools).toEqual([{ type: "function", name: "lookup", description: "Look things up", parameters: { type: "object" } }]);
    expect(payload.input).toEqual([
      { role: "user", content: "Hello" },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { role: "user", content: [{ type: "function_call_output", call_id: "call_1", output: '{"answer":42}' }] },
    ]);
  });

  test("keeps reasoning items and blocks out of visible content but flags reasoning", () => {
    const result = normalizeRequest("/v1/responses", {
      model: "gpt-5",
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
        { type: "message", role: "assistant", content: [{ type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] }, { type: "output_text", text: "visible" }] },
      ],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoning).toBe("enabled");
    const messages = result.request.messages;
    expect(messages[messages.length - 1]?.content).toEqual([{ type: "text", text: "visible" }]);
  });

  test("always surfaces cached tokens from responses usage", () => {
    const usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 4 } };
    expect(mapResponsesUsage(usage)).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 4 });
    expect(mapResponsesUsage({ input_tokens: 1, output_tokens: 2 }).cacheReadTokens).toBeNull();
  });
});

describe("Anthropic messages normalization and payload conversion", () => {
  test("converts system, tools, thinking, and cache plan into the wire payload", () => {
    const result = normalizeRequest("/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: "You are concise.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "lookup", description: "Look things up", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      thinking: { type: "enabled", budget_tokens: 512 },
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.reasoning).toBe("enabled");
    expect(result.request.maxOutputTokens).toBe(1024);

    const marked = applyCachePlan(result.request, buildCachePlan(result.request));
    const payload = buildMessagesPayload(marked, anthropicCapabilities());
    expect(payload.model).toBe("claude-sonnet-4-5");
    expect(payload.max_tokens).toBe(1024);
    expect(payload.system).toEqual([{ type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } }]);
    expect(payload.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(payload.tools).toEqual([
      { name: "lookup", description: "Look things up", input_schema: { type: "object", properties: { q: { type: "string" } } } },
    ]);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("omits cache markers without an applied cache key and caps the thinking budget", () => {
    const plain = buildMessagesPayload(manualRequest({ reasoning: "enabled", maxOutputTokens: 50_000 }), anthropicCapabilities());
    expect(plain.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
    expect(plain.system).toBeUndefined();
    expect((plain.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: "user", content: [{ type: "text", text: "Hello" }] });

    const defaultTokens = buildMessagesPayload(manualRequest({ reasoning: "default" }), anthropicCapabilities());
    expect(defaultTokens.max_tokens).toBe(4096);
  });

  test("round-trips tool_use blocks into tool_use content", () => {
    const result = normalizeRequest("/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }] }],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = buildMessagesPayload(result.request, anthropicCapabilities());
    const content = (payload.messages as Array<Record<string, unknown>>)[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } });
  });

  test("round-trips tool result error flags through the wire payload", () => {
    const result = normalizeRequest("/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "it failed", is_error: true }] },
      ],
    }, normalizeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages[0]?.content[0]).toMatchObject({ type: "tool_result", toolResultIsError: true });

    const payload = buildMessagesPayload(result.request, anthropicCapabilities());
    const content = (payload.messages as Array<Record<string, unknown>>)[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "it failed", is_error: true });
  });

  test("always surfaces anthropic cache read and write tokens", () => {
    const usage = { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 };
    expect(mapAnthropicUsage(usage)).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1 });
    expect(mapAnthropicUsage({ input_tokens: 1, output_tokens: 2 }).cacheReadTokens).toBeNull();
  });
});

describe("image reference payload encoding", () => {
  test("encodes url and data references for OpenAI and rejects file kinds", () => {
    expect(toOpenAIImageUrl({ kind: "url", value: "https://example.com/x.png", mediaType: null })).toBe("https://example.com/x.png");
    expect(toOpenAIImageUrl({ kind: "data", value: "data:image/png;base64,AAAA", mediaType: "image/png" })).toBe("data:image/png;base64,AAAA");
    expect(toOpenAIImageUrl({ kind: "data", value: "AAAA", mediaType: "image/webp" })).toBe("data:image/webp;base64,AAAA");
    expect(() => toOpenAIImageUrl({ kind: "file", value: "/tmp/x.png", mediaType: null })).toThrow(ProtocolCodecError);
  });
});
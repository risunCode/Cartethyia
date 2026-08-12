import { describe, expect, test } from "bun:test";
import { normalizeChatRequest, buildChatPayload } from "../../src/open-sse/translate/request/openai-chat";
import { normalizeResponsesRequest, buildResponsesPayload } from "../../src/open-sse/translate/request/openai-responses";
import { normalizeMessagesRequest, buildMessagesPayload } from "../../src/open-sse/translate/request/anthropic";
import { translateNonStreamResponse } from "../../src/open-sse/translate";
import type { ProviderCaps } from "../../src/application/contracts";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

const input = { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS } as const;
const anthropicCaps: ProviderCaps = {
  surfaces: ["anthropic-messages"], streaming: true, reasoning: true, toolCalls: true, images: true,
  mediaGeneration: [], explicitCache: true, promptCacheKey: true,
};

describe("direct compatibility matrix", () => {
  test("round-trips OpenAI Chat controls and tool calls", () => {
    const result = normalizeChatRequest({
      model: "gpt-5", stream: false, messages: [{ role: "user", content: "read" }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
      tool_choice: "auto", parallel_tool_calls: true,
    }, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = buildChatPayload(result.request);
    expect(payload.model).toBe("gpt-5");
    expect(payload.tool_choice).toBe("auto");
    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.tools).toEqual([{ type: "function", function: { name: "Read", description: undefined, parameters: { type: "object" } } }]);
  });

  test("round-trips Responses input items and structured output controls", () => {
    const result = normalizeResponsesRequest({
      model: "gpt-5", stream: false, input: "summarize", text: { format: { type: "json_schema", json_schema: { name: "summary", schema: { type: "object" } } } },
      parallel_tool_calls: false, tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
    }, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = buildResponsesPayload(result.request);
    expect(payload.input).toEqual("summarize");
    expect(payload.parallel_tool_calls).toBe(false);
    expect(payload.text).toEqual({ format: { type: "json_schema", json_schema: { name: "summary", schema: { type: "object" } } } });
  });

  test("round-trips Anthropic system, thinking, and tool blocks", () => {
    const result = normalizeMessagesRequest({
      model: "claude-sonnet", stream: false, max_tokens: 200,
      system: [{ type: "text", text: "Be precise", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "read" }] }],
      thinking: { type: "enabled", budget_tokens: 64 },
      tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
    }, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = buildMessagesPayload(result.request, anthropicCaps);
    expect(payload.system).toEqual([{ type: "text", text: "Be precise", cache_control: { type: "ephemeral" } }]);
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 64 });
    expect(payload.tools).toEqual([{ name: "Read", description: "Read a file", input_schema: { type: "object" } }]);
  });

  test("projects a direct response through the canonical fallback edge", () => {
    const translated = translateNonStreamResponse({
      id: "chat-1", object: "chat.completion", model: "claude-sonnet",
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    }, "openai-chat", "anthropic-messages", "claude-sonnet");
    expect(translated).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "done" }] });
  });

  test("rejects unsupported file references instead of silently dropping them", () => {
    const result = normalizeResponsesRequest({ model: "gpt-5", input: [{ type: "input_image", image_url: "file_id_123" }] }, input);
    expect(result.ok).toBe(false);
  });
});

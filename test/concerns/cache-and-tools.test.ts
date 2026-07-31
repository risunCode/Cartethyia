/**
 * Unit tests for translate/concerns/cache.ts and translate/concerns/tools.ts.
 * Both modules have zero explicit test coverage — this file closes the gap.
 */

import { describe, expect, test } from "bun:test";
import {
  looksCacheable,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  estimateUsageFromText,
  applyCacheBreakpoint,
} from "../../src/translate/concerns/cache";
import {
  anthropicToolToUnified,
  unifiedToolToAnthropic,
  openAIChatToolToUnified,
  unifiedToolToOpenAIChat,
  openAIResponsesToolToUnified,
  unifiedToolToOpenAIResponses,
  parseToolArguments,
  stringifyToolArguments,
} from "../../src/translate/concerns/tools";
import type { UnifiedMessage } from "../../src/translate/concerns/blocks";

// ─── cache.ts ────────────────────────────────────────────────────────────────

describe("looksCacheable", () => {
  const LONG = "a".repeat(1024 * 4); // exactly at MIN_CACHEABLE_CHARS
  const SHORT = "a".repeat(1024 * 4 - 1);

  test("returns true for text at the minimum length threshold", () => {
    expect(looksCacheable(LONG)).toBe(true);
  });

  test("returns false for text below the minimum length", () => {
    expect(looksCacheable(SHORT)).toBe(false);
  });

  test("returns false when text contains an ISO timestamp", () => {
    expect(looksCacheable(LONG + " 2025-07-31T12:00:00")).toBe(false);
  });

  test("returns false when text contains a UUID", () => {
    expect(looksCacheable(LONG + " id=a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(false);
  });

  test("returns true for long stable text with no timestamps or UUIDs", () => {
    const stable = "The quick brown fox jumps over the lazy dog. ".repeat(300);
    expect(looksCacheable(stable)).toBe(true);
  });
});

describe("estimateUsageFromText", () => {
  test("returns 0 for empty string", () => expect(estimateUsageFromText("")).toBe(0));
  test("returns at least 1 for non-empty string", () => expect(estimateUsageFromText("hi")).toBeGreaterThanOrEqual(1));
  test("estimates ~1 token per 4 chars", () => {
    expect(estimateUsageFromText("a".repeat(400))).toBe(100);
  });
  test("rounds up fractional tokens", () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateUsageFromText("abcde")).toBe(2);
  });
});

describe("normalizeAnthropicUsage", () => {
  test("returns estimated usage when usage is undefined", () => {
    const result = normalizeAnthropicUsage(undefined, "hello");
    expect(result.estimated).toBe(true);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.freshInputTokens).toBe(0);
  });

  test("maps cache_creation_input_tokens to cacheWriteTokens", () => {
    const result = normalizeAnthropicUsage({
      input_tokens: 100, output_tokens: 50,
      cache_creation_input_tokens: 25, cache_read_input_tokens: 10,
    });
    expect(result.cacheWriteTokens).toBe(25);
    expect(result.cacheReadTokens).toBe(10);
    expect(result.freshInputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.estimated).toBe(false);
  });

  test("defaults cache fields to 0 when absent", () => {
    const result = normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 5 });
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
  });
});

describe("normalizeOpenAIUsage", () => {
  test("returns estimated usage when usage is undefined", () => {
    const result = normalizeOpenAIUsage(undefined, "response text");
    expect(result.estimated).toBe(true);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  test("derives freshInputTokens as prompt_tokens minus cached_tokens", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 100, completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(result.cacheReadTokens).toBe(30);
    expect(result.freshInputTokens).toBe(70);
    expect(result.outputTokens).toBe(40);
    expect(result.estimated).toBe(false);
  });

  test("clamps freshInputTokens to 0 when cached > prompt", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 10, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    expect(result.freshInputTokens).toBe(0);
  });

  test("maps cache_write_tokens when present", () => {
    const result = normalizeOpenAIUsage({
      prompt_tokens: 100, completion_tokens: 50, cache_write_tokens: 80,
    });
    expect(result.cacheWriteTokens).toBe(80);
  });
});

describe("applyCacheBreakpoint", () => {
  const longSystem = "a".repeat(1024 * 4);
  const longMsg: UnifiedMessage = { role: "user", blocks: [{ type: "text", text: "a".repeat(1024 * 4), cache: false }] };

  test("marks systemCached=true when system prompt is long and stable", () => {
    const result = applyCacheBreakpoint(longSystem, []);
    expect(result.systemCached).toBe(true);
    expect(result.system).toBe(longSystem);
  });

  test("does not cache a short system prompt", () => {
    const result = applyCacheBreakpoint("short", [longMsg]);
    expect(result.systemCached).toBe(false);
  });

  test("falls back to tagging the last stable message block when system is short", () => {
    const result = applyCacheBreakpoint("short", [longMsg]);
    expect(result.messages[0]!.blocks[0]!.cache).toBe(true);
  });

  test("does not tag any block when all text is too short", () => {
    const shortMsg: UnifiedMessage = { role: "user", blocks: [{ type: "text", text: "hi", cache: false }] };
    const result = applyCacheBreakpoint("short", [shortMsg]);
    expect(result.systemCached).toBe(false);
    expect(result.messages[0]!.blocks[0]!.cache).toBe(false);
  });

  test("does not modify system prompt when undefined", () => {
    const result = applyCacheBreakpoint(undefined, []);
    expect(result.system).toBeUndefined();
  });
});

// ─── tools.ts ────────────────────────────────────────────────────────────────

describe("parseToolArguments", () => {
  test("parses valid JSON object", () => {
    expect(parseToolArguments('{"key":"value"}')).toEqual({ key: "value" });
  });
  test("returns {} for empty string", () => {
    expect(parseToolArguments("")).toEqual({});
  });
  test("returns {} for malformed JSON", () => {
    expect(parseToolArguments("{not valid}")).toEqual({});
  });
  test("returns {} for JSON array (not an object)", () => {
    expect(parseToolArguments("[1,2,3]")).toEqual({});
  });
  test("returns {} for JSON null", () => {
    expect(parseToolArguments("null")).toEqual({});
  });
  test("returns {} for JSON string primitive", () => {
    expect(parseToolArguments('"a string"')).toEqual({});
  });
});

describe("stringifyToolArguments", () => {
  test("serializes an object to JSON", () => {
    expect(stringifyToolArguments({ a: 1 })).toBe('{"a":1}');
  });
  test("serializes empty object", () => {
    expect(stringifyToolArguments({})).toBe("{}");
  });
});

describe("tool conversion round-trips", () => {
  const unified = { name: "get_weather", description: "Returns weather", schema: { type: "object", properties: {} } };

  test("anthropic → unified → anthropic round-trip", () => {
    const anthropic = { name: "get_weather", description: "Returns weather", input_schema: { type: "object", properties: {} } };
    expect(unifiedToolToAnthropic(anthropicToolToUnified(anthropic))).toEqual(anthropic);
  });

  test("openai-chat → unified → openai-chat round-trip", () => {
    const chatTool = { type: "function" as const, function: { name: "get_weather", description: "Returns weather", parameters: { type: "object", properties: {} } } };
    expect(unifiedToolToOpenAIChat(openAIChatToolToUnified(chatTool))).toEqual(chatTool);
  });

  test("openai-responses → unified → openai-responses round-trip", () => {
    const respTool = { type: "function" as const, name: "get_weather", description: "Returns weather", parameters: { type: "object", properties: {} } };
    expect(unifiedToolToOpenAIResponses(openAIResponsesToolToUnified(respTool))).toEqual(respTool);
  });

  test("omits description when undefined (anthropic)", () => {
    const result = unifiedToolToAnthropic({ ...unified, description: undefined });
    expect("description" in result).toBe(false);
  });

  test("omits description when undefined (openai-chat)", () => {
    const result = unifiedToolToOpenAIChat({ ...unified, description: undefined });
    expect("description" in result.function).toBe(false);
  });

  test("omits description when undefined (openai-responses)", () => {
    const result = unifiedToolToOpenAIResponses({ ...unified, description: undefined });
    expect("description" in result).toBe(false);
  });
});

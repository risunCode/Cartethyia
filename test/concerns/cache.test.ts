import { describe, expect, test } from "bun:test";
import { applyCacheBreakpoint, looksCacheable, normalizeAnthropicUsage, normalizeOpenAIUsage } from "../../src/translate/concerns/cache";
import type { UnifiedMessage } from "../../src/translate/concerns/blocks";
import { textBlock } from "../../src/translate/concerns/blocks";

const LONG_STABLE_TEXT = "You are a helpful assistant. ".repeat(200); // well over 4096 chars, no timestamp/uuid
const SHORT_TEXT = "hi there";

describe("cache concern — looksCacheable", () => {
  test("rejects text under the ~1024 token (4096 char) minimum", () => {
    expect(looksCacheable(SHORT_TEXT)).toBe(false);
  });

  test("accepts long, stable text with no timestamp or uuid", () => {
    expect(looksCacheable(LONG_STABLE_TEXT)).toBe(true);
  });

  test("rejects otherwise-long text containing an ISO timestamp", () => {
    const withTimestamp = LONG_STABLE_TEXT + "Generated at 2026-07-28T12:00:00";
    expect(looksCacheable(withTimestamp)).toBe(false);
  });

  test("rejects otherwise-long text containing a UUID", () => {
    const withUuid = LONG_STABLE_TEXT + "request-id: 550e8400-e29b-41d4-a716-446655440000";
    expect(looksCacheable(withUuid)).toBe(false);
  });
});

describe("cache concern — usage normalization", () => {
  test("normalizeAnthropicUsage maps cache_read/cache_creation onto the common shape", () => {
    expect(normalizeAnthropicUsage({ input_tokens: 50, cache_creation_input_tokens: 1200, cache_read_input_tokens: 300 })).toEqual({
      cacheReadTokens: 300,
      cacheWriteTokens: 1200,
      freshInputTokens: 50,
    });
  });

  test("normalizeAnthropicUsage defaults missing cache fields to 0", () => {
    expect(normalizeAnthropicUsage({ input_tokens: 50 })).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 50 });
  });

  test("normalizeOpenAIUsage derives freshInputTokens as prompt_tokens minus cached_tokens", () => {
    expect(
      normalizeOpenAIUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 400 }, cache_write_tokens: 100 })
    ).toEqual({ cacheReadTokens: 400, cacheWriteTokens: 100, freshInputTokens: 600 });
  });

  test("normalizeOpenAIUsage never returns negative freshInputTokens", () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 999 } })).toEqual({
      cacheReadTokens: 999,
      cacheWriteTokens: 0,
      freshInputTokens: 0,
    });
  });
});

describe("cache concern — applyCacheBreakpoint", () => {
  test("prefers a cacheable system prompt over any message block", () => {
    const messages: UnifiedMessage[] = [{ role: "user", blocks: [textBlock(LONG_STABLE_TEXT)] }];
    const result = applyCacheBreakpoint(LONG_STABLE_TEXT, messages);
    expect(result.systemCached).toBe(true);
    // Messages are untouched when the system prompt itself is the breakpoint.
    expect(result.messages).toBe(messages);
  });

  test("falls back to the last cacheable text block of the last message when system is not cacheable", () => {
    const messages: UnifiedMessage[] = [
      { role: "user", blocks: [textBlock(SHORT_TEXT)] },
      { role: "assistant", blocks: [textBlock(LONG_STABLE_TEXT)] },
    ];
    const result = applyCacheBreakpoint(SHORT_TEXT, messages);
    expect(result.systemCached).toBe(false);
    expect(result.messages[1]!.blocks[0]).toEqual(textBlock(LONG_STABLE_TEXT, true));
    // Original messages array/object are not mutated in place.
    expect(messages[1]!.blocks[0]!.cache).toBe(false);
  });

  test("tags exactly one block even when multiple are cacheable", () => {
    const messages: UnifiedMessage[] = [
      { role: "user", blocks: [textBlock(LONG_STABLE_TEXT)] },
      { role: "assistant", blocks: [textBlock(LONG_STABLE_TEXT)] },
    ];
    const result = applyCacheBreakpoint(undefined, messages);
    const cachedBlocks = result.messages.flatMap((m) => m.blocks).filter((b) => b.cache);
    expect(cachedBlocks).toHaveLength(1);
    // The LAST message's block is preferred (closest to the end, per scan direction).
    expect(result.messages[1]!.blocks[0]!.cache).toBe(true);
    expect(result.messages[0]!.blocks[0]!.cache).toBe(false);
  });

  test("no cacheable content anywhere leaves messages untouched", () => {
    const messages: UnifiedMessage[] = [{ role: "user", blocks: [textBlock(SHORT_TEXT)] }];
    const result = applyCacheBreakpoint(SHORT_TEXT, messages);
    expect(result.systemCached).toBe(false);
    expect(result.messages).toBe(messages);
  });
});

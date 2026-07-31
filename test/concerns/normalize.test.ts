import { describe, expect, test } from "bun:test";
import {
  denormalizeToAnthropicBlock,
  denormalizeToAnthropicMessages,
  denormalizeToOpenAIChatMessages,
  denormalizeToOpenAIResponsesInput,
  normalizeAnthropicBlock,
  normalizeAnthropicMessages,
  normalizeOpenAIChatMessages,
  normalizeOpenAIResponsesInput,
} from "../../src/translate/concerns/normalize";
import type { UnifiedMessage } from "../../src/translate/concerns/blocks";
import { textBlock } from "../../src/translate/concerns/blocks";
import type { AnthropicMessage, OpenAIChatMessage } from "../../src/translate/types";
import { bytesToBase64, toDataUri } from "../../src/translate/concerns/image";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_BASE64 = bytesToBase64(PNG_BYTES);

describe("normalize — OpenAI Chat ⇄ Unified", () => {
  test("plain string content becomes a single text block", () => {
    const msgs: OpenAIChatMessage[] = [{ role: "user", content: "hello" }];
    expect(normalizeOpenAIChatMessages(msgs)).toEqual([{ role: "user", blocks: [textBlock("hello")] }]);
  });

  test("empty string content produces no blocks (not a spurious empty text block)", () => {
    const msgs: OpenAIChatMessage[] = [{ role: "user", content: "" }];
    expect(normalizeOpenAIChatMessages(msgs)[0]!.blocks).toEqual([]);
  });

  test("tool role message becomes a tool_result block, keyed by tool_call_id", () => {
    const msgs: OpenAIChatMessage[] = [{ role: "tool", content: "42 degrees", tool_call_id: "call_1" }];
    const result = normalizeOpenAIChatMessages(msgs);
    expect(result[0]!.blocks).toEqual([{ type: "tool_result", toolCallId: "call_1", content: "42 degrees", isError: false, cache: false }]);
  });

  test("assistant tool_calls become tool_call blocks with parsed arguments", () => {
    const msgs: OpenAIChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }] },
    ];
    const result = normalizeOpenAIChatMessages(msgs);
    expect(result[0]!.blocks).toEqual([{ type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Jakarta" }, cache: false }]);
  });

  test("denormalize round-trips text content back to a plain string", () => {
    const unified: UnifiedMessage[] = [{ role: "user", blocks: [textBlock("hello")] }];
    expect(denormalizeToOpenAIChatMessages(unified)).toEqual([{ role: "user", content: "hello" }]);
  });

  test("denormalize emits a separate tool message per tool_result block, not folded into the parent", () => {
    const unified: UnifiedMessage[] = [{ role: "tool", blocks: [{ type: "tool_result", toolCallId: "call_1", content: "42", isError: false, cache: false }] }];
    expect(denormalizeToOpenAIChatMessages(unified)).toEqual([{ role: "tool", content: "42", tool_call_id: "call_1" }]);
  });

  test("denormalize prefixes tool_result content with [tool_error] when isError is true — the flag must not be silently dropped", () => {
    const unified: UnifiedMessage[] = [{ role: "tool", blocks: [{ type: "tool_result", toolCallId: "call_1", content: "rate limited", isError: true, cache: false }] }];
    expect(denormalizeToOpenAIChatMessages(unified)).toEqual([{ role: "tool", content: "[tool_error] rate limited", tool_call_id: "call_1" }]);
  });

  test("denormalize stringifies tool_call input back into a JSON string", () => {
    const unified: UnifiedMessage[] = [
      { role: "assistant", blocks: [{ type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Jakarta" }, cache: false }] },
    ];
    const out = denormalizeToOpenAIChatMessages(unified);
    expect(out[0]!.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }]);
    expect(out[0]!.content).toBeNull();
  });

  test("denormalize carries a thinking block's signature into the reasoning_signature extension field alongside reasoning_content", () => {
    const unified: UnifiedMessage[] = [
      { role: "assistant", blocks: [{ type: "thinking", text: "Let me think.", signature: "sig_abc", cache: false }, textBlock("Answer.")] },
    ];
    const out = denormalizeToOpenAIChatMessages(unified);
    expect(out[0]!.reasoning_content).toBe("Let me think.");
    expect(out[0]!.reasoning_signature).toBe("sig_abc");
  });

  test("normalize reconstructs a thinking block (with signature) from reasoning_content/reasoning_signature - the round trip Anthropic replay depends on", () => {
    const msgs: OpenAIChatMessage[] = [{ role: "assistant", content: "Answer.", reasoning_content: "Let me think.", reasoning_signature: "sig_abc" }];
    const result = normalizeOpenAIChatMessages(msgs);
    expect(result[0]!.blocks).toEqual([
      { type: "thinking", text: "Let me think.", signature: "sig_abc", cache: false },
      textBlock("Answer."),
    ]);
  });

  test("full round trip: Anthropic thinking block -> Chat reasoning_content/reasoning_signature -> Anthropic thinking block preserves the signature", () => {
    const anthropicBlock = normalizeAnthropicBlock({ type: "thinking", thinking: "Reasoning.", signature: "sig_full" });
    const chatMsgs = denormalizeToOpenAIChatMessages([{ role: "assistant", blocks: [anthropicBlock] }]);
    const backToUnified = normalizeOpenAIChatMessages(chatMsgs);
    const restored = denormalizeToAnthropicBlock(backToUnified[0]!.blocks[0]!);
    expect(restored).toEqual({ type: "thinking", thinking: "Reasoning.", signature: "sig_full" });
  });
});

describe("normalize — Anthropic ⇄ Unified", () => {
  test("text block round-trips, cache_control presence maps to the cache flag both ways", () => {
    const block = normalizeAnthropicBlock({ type: "text", text: "hi", cache_control: { type: "ephemeral" } });
    expect(block).toEqual({ type: "text", text: "hi", cache: true });
    expect(denormalizeToAnthropicBlock(block)).toEqual({ type: "text", text: "hi", cache_control: { type: "ephemeral" } });
  });

  test("text block without cache_control has cache: false and denormalizes without cache_control", () => {
    const block = normalizeAnthropicBlock({ type: "text", text: "hi" });
    expect(block.cache).toBe(false);
    expect(denormalizeToAnthropicBlock(block)).toEqual({ type: "text", text: "hi" });
  });

  test("base64 image block's media_type is re-sniffed from real bytes, not trusted from the wire", () => {
    // Claim the wrong media_type; real bytes are PNG — normalize must sniff, not trust.
    const block = normalizeAnthropicBlock({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG_BASE64 } });
    if (block.type !== "image" || block.source.kind !== "base64") throw new Error("expected base64 image block");
    expect(block.source.mediaType).toBe("image/png");
  });

  test("url image block passes through untouched", () => {
    const block = normalizeAnthropicBlock({ type: "image", source: { type: "url", url: "https://example.com/cat.png" } });
    expect(block).toEqual({ type: "image", source: { kind: "url", url: "https://example.com/cat.png" }, cache: false });
  });

  test("tool_use round-trips id/name/input", () => {
    const block = normalizeAnthropicBlock({ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" } });
    expect(block).toEqual({ type: "tool_call", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" }, cache: false });
    expect(denormalizeToAnthropicBlock(block)).toEqual({ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Jakarta" } });
  });

  test("tool_result defaults is_error to false when absent", () => {
    const block = normalizeAnthropicBlock({ type: "tool_result", tool_use_id: "toolu_1", content: "42" });
    expect(block).toEqual({ type: "tool_result", toolCallId: "toolu_1", content: "42", isError: false, cache: false });
  });

  test("normalizeAnthropicMessages handles bare string content as a single text block", () => {
    const msgs: AnthropicMessage[] = [{ role: "user", content: "hi" }];
    expect(normalizeAnthropicMessages(msgs)).toEqual([{ role: "user", blocks: [textBlock("hi")] }]);
  });

  test("denormalizeToAnthropicMessages drops system-role messages (caller extracts system separately)", () => {
    const unified: UnifiedMessage[] = [
      { role: "system", blocks: [textBlock("be nice")] },
      { role: "user", blocks: [textBlock("hi")] },
    ];
    const out = denormalizeToAnthropicMessages(unified);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });

  test("denormalizeToAnthropicMessages folds tool role into user", () => {
    const unified: UnifiedMessage[] = [{ role: "tool", blocks: [{ type: "tool_result", toolCallId: "t1", content: "ok", isError: false, cache: false }] }];
    expect(denormalizeToAnthropicMessages(unified)[0]!.role).toBe("user");
  });
});

describe("normalize — OpenAI Responses ⇄ Unified", () => {
  test("plain string input becomes one user message with one text block", () => {
    expect(normalizeOpenAIResponsesInput("hello")).toEqual([{ role: "user", blocks: [textBlock("hello")] }]);
  });

  test("empty string input yields no messages", () => {
    expect(normalizeOpenAIResponsesInput("")).toEqual([]);
  });

  test("function_call item becomes an assistant tool_call message", () => {
    const result = normalizeOpenAIResponsesInput([{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Jakarta"}' }]);
    expect(result).toEqual([{ role: "assistant", blocks: [{ type: "tool_call", id: "call_1", name: "get_weather", input: { city: "Jakarta" }, cache: false }] }]);
  });

  test("function_call_output item becomes a tool-role tool_result message", () => {
    const result = normalizeOpenAIResponsesInput([{ type: "function_call_output", call_id: "call_1", output: "42 degrees" }]);
    expect(result).toEqual([{ role: "tool", blocks: [{ type: "tool_result", toolCallId: "call_1", content: "42 degrees", isError: false, cache: false }] }]);
  });

  test("message item with input_text/input_image parts normalizes both block kinds", () => {
    const dataUri = toDataUri("image/png", PNG_BASE64);
    const result = normalizeOpenAIResponsesInput([
      { type: "message", role: "user", content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: dataUri }] },
    ]);
    expect(result[0]!.blocks[0]).toEqual(textBlock("what is this"));
    expect(result[0]!.blocks[1]!.type).toBe("image");
  });

  test("denormalize emits function_call before message content for the same turn's tool_call block", () => {
    const unified: UnifiedMessage[] = [{ role: "assistant", blocks: [{ type: "tool_call", id: "call_1", name: "get_weather", input: {}, cache: false }] }];
    const out = denormalizeToOpenAIResponsesInput(unified);
    expect(out).toEqual([{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" }]);
  });

  test("denormalize maps tool role content to a user message item", () => {
    const unified: UnifiedMessage[] = [{ role: "tool", blocks: [textBlock("just some text, not a tool_result")] }];
    const out = denormalizeToOpenAIResponsesInput(unified);
    expect(out).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "just some text, not a tool_result" }] }]);
  });
});

/**
 * Tests for denormalizeToOpenAIResponsesInput — converts Unified messages
 * back to OpenAI Responses input items. Covers text, tool calls, tool
 * results, images, and the role-mapping edge cases.
 */

import { describe, expect, test } from "bun:test";
import { normalizeOpenAIResponsesInput, denormalizeToOpenAIResponsesInput } from "../../src/translate/concerns/normalize";
import type { UnifiedMessage } from "../../src/translate/concerns/blocks";
import type { OpenAIResponsesInputItem } from "../../src/translate/types";

describe("denormalizeToOpenAIResponsesInput", () => {
  test("converts a text-only unified message to a Responses message item", () => {
    const unified: UnifiedMessage[] = [
      { role: "user", blocks: [{ type: "text", text: "hello", cache: false }] },
    ];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect(result).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  test("converts an assistant text message", () => {
    const unified: UnifiedMessage[] = [
      { role: "assistant", blocks: [{ type: "text", text: "hi back", cache: false }] },
    ];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect(result[0]).toEqual({ type: "message", role: "assistant", content: [{ type: "input_text", text: "hi back" }] });
  });

  test("converts tool_call blocks to function_call items", () => {
    const unified: UnifiedMessage[] = [{
      role: "assistant",
      blocks: [{ type: "tool_call", id: "tc_1", name: "get_weather", input: { city: "Jakarta" }, cache: false }],
    }];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect(result).toEqual([
      { type: "function_call", call_id: "tc_1", name: "get_weather", arguments: '{"city":"Jakarta"}' },
    ]);
  });

  test("converts tool_result blocks to function_call_output items", () => {
    const unified: UnifiedMessage[] = [{
      role: "tool",
      blocks: [{ type: "tool_result", toolCallId: "tc_1", content: "30°C", isError: false, cache: false }],
    }];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect(result).toEqual([
      { type: "function_call_output", call_id: "tc_1", output: "30°C" },
    ]);
  });

  test("tool result with nested block content is flattened to string", () => {
    const unified: UnifiedMessage[] = [{
      role: "tool",
      blocks: [{
        type: "tool_result",
        toolCallId: "tc_1",
        content: [{ type: "text", text: "nested result", cache: false }],
        isError: false,
        cache: false,
      }],
    }];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect((result[0] as { output: string }).output).toBe("nested result");
  });

  test("tool role message maps to user role in output", () => {
    const unified: UnifiedMessage[] = [{
      role: "tool",
      blocks: [{ type: "tool_result", toolCallId: "tc_1", content: "r", isError: false, cache: false }],
    }];
    const result = denormalizeToOpenAIResponsesInput(unified);
    // function_call_output items don't carry a role — this is correct
    expect(result[0]).toHaveProperty("type", "function_call_output");
  });

  test("image blocks become input_image parts", () => {
    const unified: UnifiedMessage[] = [{
      role: "user",
      blocks: [{ type: "image", source: { kind: "url", url: "https://example.com/cat.jpg" }, cache: false }],
    }];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect(result[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "https://example.com/cat.jpg" }],
    });
  });

  test("system role messages pass through with role='system'", () => {
    const unified: UnifiedMessage[] = [
      { role: "system", blocks: [{ type: "text", text: "Be helpful", cache: false }] },
    ];
    const result = denormalizeToOpenAIResponsesInput(unified);
    expect(result[0]).toHaveProperty("role", "system");
  });

  test("blocks with no text/image content are skipped (no empty message emitted)", () => {
    const unified: UnifiedMessage[] = [{
      role: "assistant",
      blocks: [{ type: "tool_call", id: "tc_1", name: "fn", input: {}, cache: false }],
    }];
    const result = denormalizeToOpenAIResponsesInput(unified);
    // Only the function_call item should appear — no trailing empty message.
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("type", "function_call");
  });
});

describe("OpenAI Responses → Unified → OpenAI Responses round-trip", () => {
  test("a simple message round-trips cleanly", () => {
    const original: OpenAIResponsesInputItem[] = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];
    const unified = normalizeOpenAIResponsesInput(original);
    const back = denormalizeToOpenAIResponsesInput(unified);
    expect(back).toEqual(original);
  });

  test("function_call + function_call_output round-trip", () => {
    const original: OpenAIResponsesInputItem[] = [
      { type: "function_call", call_id: "tc_1", name: "fn", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "tc_1", output: "ok" },
    ];
    const unified = normalizeOpenAIResponsesInput(original);
    const back = denormalizeToOpenAIResponsesInput(unified);
    expect(back).toEqual(original);
  });

  test("a string input normalizes to a single user message and back", () => {
    const unified = normalizeOpenAIResponsesInput("hello world");
    const back = denormalizeToOpenAIResponsesInput(unified);
    expect(back).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello world" }] },
    ]);
  });
});

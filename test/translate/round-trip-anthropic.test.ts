/**
 * Bidirectional round-trip tests for OpenAI Chat ↔ Anthropic Messages
 * translation through the Unified block model. Verifies that converting
 * in one direction and back preserves message structure, tool calls,
 * tool results, and image blocks.
 */

import { describe, expect, test } from "bun:test";
import type { AnthropicMessage } from "../../src/translate/types";
import { normalizeAnthropicMessages, denormalizeToAnthropicMessages, denormalizeToAnthropicBlock } from "../../src/translate/concerns/normalize";
import { translateChatRequestToAnthropic } from "../../src/translate/openai-anthropic";
import type { UnifiedMessage } from "../../src/translate/concerns/blocks";
import type { OpenAIChatRequest } from "../../src/translate/types";

const base: OpenAIChatRequest = {
  model: "claude-test",
  messages: [{ role: "user", content: "hi" }],
};

describe("Anthropic → Unified → Anthropic round-trip (messages only)", () => {
  test("text-only messages survive a round-trip", () => {
    const original = [
      { role: "user" as const, content: "What is the weather?" },
      { role: "assistant" as const, content: "It is sunny today." },
    ];
    const unified = normalizeAnthropicMessages(original);
    const back = denormalizeToAnthropicMessages(unified);
    // String content is normalized to content-block arrays by the round-trip.
    // This is correct and expected — the message text is preserved.
    expect(back).toEqual([
      { role: "user", content: [{ type: "text", text: "What is the weather?" }] },
      { role: "assistant", content: [{ type: "text", text: "It is sunny today." }] },
    ]);
  });

  test("multi-part content blocks survive a round-trip", () => {
    // Use a minimal valid base64 payload (1x1 transparent PNG) instead of
    // a truncated one — the normalizer validates and decodes base64.
    const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const original = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Look at this:" },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: VALID_PNG_BASE64 } },
      ],
    }];
    const unified = normalizeAnthropicMessages(original);
    const back = denormalizeToAnthropicMessages(unified);
    expect(back).toEqual(original);
  });

  test("tool_use + tool_result blocks survive a round-trip", () => {
    const original = [
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "tu_1", name: "get_weather", input: { city: "Jakarta" } }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "tu_1", content: "30°C and sunny", is_error: false }] },
    ];
    const unified = normalizeAnthropicMessages(original);
    const back = denormalizeToAnthropicMessages(unified);
    expect(back).toEqual(original);
  });

  test("system messages are dropped by denormalize (caller extracts separately)", () => {
    // normalizeAnthropicMessages accepts role:string so 'system' passes at runtime
    // even though AnthropicMessage's type only allows 'user'|'assistant'.
    const original = [{ role: "system" as AnthropicMessage["role"], content: "You are helpful." }];
    const unified = normalizeAnthropicMessages(original);
    expect(unified[0]!.role).toBe("system");
    const back = denormalizeToAnthropicMessages(unified);
    expect(back).toEqual([]);
  });

  test("tool role messages map to user role in Anthropic output", () => {
    // normalizeAnthropicMessages accepts role:string so 'tool' passes at runtime.
    const original = [{
      role: "tool" as AnthropicMessage["role"],
      content: [{ type: "tool_result" as const, tool_use_id: "tu_1", content: "result" }],
    }];
    const unified = normalizeAnthropicMessages(original);
    const back = denormalizeToAnthropicMessages(unified);
    expect(back[0]!.role).toBe("user");
  });

  test("string content (shorthand) normalizes to a text block", () => {
    const original = [{ role: "user" as const, content: "hello" }];
    const unified = normalizeAnthropicMessages(original);
    expect(unified[0]!.blocks[0]).toEqual({ type: "text", text: "hello", cache: false });
  });
});

describe("OpenAI Chat → Anthropic — translateChatRequestToAnthropic structural checks", () => {
  test("a simple user message translates to Anthropic's messages format", () => {
    const out = translateChatRequestToAnthropic(base);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe("user");
    // Anthropic content is always an array of content blocks, even for plain text.
    const content = out.messages[0]!.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toBe("hi");
  });

  test("a system message is extracted from messages into the system field", () => {
    const req: OpenAIChatRequest = {
      ...base,
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "hi" },
      ],
    };
    const out = translateChatRequestToAnthropic(req);
    expect(out.system).toBe("Be helpful");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe("user");
  });

  test("multiple user/assistant turns preserve order", () => {
    const req: OpenAIChatRequest = {
      ...base,
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    };
    const out = translateChatRequestToAnthropic(req);
    expect(out.messages).toHaveLength(3);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("tool_calls in an assistant message become tool_use content blocks", () => {
    const req: OpenAIChatRequest = {
      ...base,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Jakarta"}' } }],
        },
      ],
    };
    const out = translateChatRequestToAnthropic(req);
    const block = (out.messages[0]!.content as Array<{ type: string }>)[0];
    expect(block!.type).toBe("tool_use");
  });

  test("tool role messages become user messages with tool_result blocks", () => {
    const req: OpenAIChatRequest = {
      ...base,
      messages: [
        { role: "tool", tool_call_id: "tc_1", content: "30°C" },
      ],
    };
    const out = translateChatRequestToAnthropic(req);
    expect(out.messages[0]!.role).toBe("user");
    const block = (out.messages[0]!.content as Array<{ type: string }>)[0];
    expect(block!.type).toBe("tool_result");
  });
});

describe("denormalizeToAnthropicBlock — edge cases", () => {
  test("thinking block with text becomes Anthropic thinking block", () => {
    const result = denormalizeToAnthropicBlock({ type: "thinking", text: "reasoning...", cache: false });
    expect(result).toEqual({ type: "thinking", thinking: "reasoning..." });
  });

  test("redacted thinking block (with redactedData) becomes redacted_thinking", () => {
    const result = denormalizeToAnthropicBlock({ type: "thinking", redactedData: "encrypted-payload", cache: false });
    expect(result).toEqual({ type: "redacted_thinking", data: "encrypted-payload" });
  });

  test("opaque block passes through raw verbatim", () => {
    const raw = { type: "server_tool_use", id: "stu_1" };
    const result = denormalizeToAnthropicBlock({ type: "opaque", raw, originalType: "server_tool_use", cache: false });
    expect(result).toBe(raw);
  });
});

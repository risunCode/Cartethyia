import { describe, expect, test } from "bun:test";
import { fixMissingToolResults, sanitizeAnthropicToolIds } from "../../src/translate/concerns/tools";
import { isToolResultBlock } from "../../src/translate/concerns/blocks";
import type { UnifiedMessage, UnifiedToolCallBlock, UnifiedToolResultBlock } from "../../src/translate/concerns/blocks";

function toolCall(id: string, name = "get_weather"): UnifiedToolCallBlock {
  return { type: "tool_call", id, name, input: {}, cache: false };
}

function toolResult(toolCallId: string, content = "ok", isError = false): UnifiedToolResultBlock {
  return { type: "tool_result", toolCallId, content, isError, cache: false };
}

describe("toolIntegrity — fixMissingToolResults (regression: Anthropic 400 on missing tool_result)", () => {
  test("leaves a properly answered tool_call untouched", () => {
    const messages: UnifiedMessage[] = [
      { role: "assistant", blocks: [toolCall("call_1")] },
      { role: "tool", blocks: [toolResult("call_1")] },
    ];
    expect(fixMissingToolResults(messages)).toEqual(messages);
  });

  test("merges a synthetic empty tool_result into the front of the next message when it doesn't answer everything — never a standalone user-role message beside it", () => {
    const messages: UnifiedMessage[] = [
      { role: "assistant", blocks: [toolCall("call_1")] },
      { role: "user", blocks: [{ type: "text", text: "hi", cache: false }] },
    ];
    const fixed = fixMissingToolResults(messages);
    // MUST stay 2 messages: assistant, then ONE merged next turn — never two
    // consecutive non-assistant messages, which Anthropic rejects with its
    // own "roles must alternate" 400.
    expect(fixed).toHaveLength(2);
    expect(fixed[1]!.role).toBe("user");
    expect(fixed[1]!.blocks).toEqual([
      { type: "tool_result", toolCallId: "call_1", content: "", isError: false, cache: false },
      { type: "text", text: "hi", cache: false },
    ]);
  });

  test("inserts a synthetic tool_result when a tool_call is the very last message (no next message at all)", () => {
    const messages: UnifiedMessage[] = [{ role: "assistant", blocks: [toolCall("call_1")] }];
    const fixed = fixMissingToolResults(messages);
    expect(fixed).toHaveLength(2);
    expect(fixed[1]!.role).toBe("tool");
    expect(fixed[1]!.blocks).toEqual([{ type: "tool_result", toolCallId: "call_1", content: "", isError: false, cache: false }]);
  });

  test("fixes only the specific missing id when a multi-tool-call turn is partially answered — merged into the existing tool-role message, not a new one", () => {
    const messages: UnifiedMessage[] = [
      { role: "assistant", blocks: [toolCall("call_1"), toolCall("call_2")] },
      { role: "tool", blocks: [toolResult("call_1")] },
    ];
    const fixed = fixMissingToolResults(messages);
    expect(fixed).toHaveLength(2);
    expect(fixed[1]!.role).toBe("tool");
    expect(fixed[1]!.blocks).toEqual([
      { type: "tool_result", toolCallId: "call_2", content: "", isError: false, cache: false },
      toolResult("call_1"),
    ]);
  });

  test("messages with no tool_call blocks pass through unchanged", () => {
    const messages: UnifiedMessage[] = [{ role: "user", blocks: [{ type: "text", text: "hi", cache: false }] }];
    expect(fixMissingToolResults(messages)).toEqual(messages);
  });
});

describe("toolIntegrity — sanitizeAnthropicToolIds (regression: Anthropic 400 on invalid tool_use.id pattern)", () => {
  test("leaves already-valid ids untouched", () => {
    const messages: UnifiedMessage[] = [
      { role: "assistant", blocks: [toolCall("call_1")] },
      { role: "tool", blocks: [toolResult("call_1")] },
    ];
    expect(sanitizeAnthropicToolIds(messages)).toEqual(messages);
  });

  test("strips characters outside [a-zA-Z0-9_-] from an invalid id", () => {
    const messages: UnifiedMessage[] = [{ role: "assistant", blocks: [toolCall("call/1+2=")] }];
    const [sanitized] = sanitizeAnthropicToolIds(messages);
    const id = (sanitized!.blocks[0] as UnifiedToolCallBlock).id;
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(id).toBe("call12");
  });

  test("propagates the SAME replacement id to the referencing tool_result — sanitizing only the call side would orphan the result reference (id drift)", () => {
    const messages: UnifiedMessage[] = [
      { role: "assistant", blocks: [toolCall("call/1+2=")] },
      { role: "tool", blocks: [toolResult("call/1+2=")] },
    ];
    const [call, result] = sanitizeAnthropicToolIds(messages);
    const callId = (call!.blocks[0] as UnifiedToolCallBlock).id;
    const resultId = (result!.blocks.find(isToolResultBlock) as UnifiedToolResultBlock).toolCallId;
    expect(callId).toBe(resultId);
  });

  test("a sanitized id never collides with an already-valid id elsewhere in the request", () => {
    // Two different invalid ids that would both sanitize to the literal string "call1" if collisions weren't tracked —
    // AND a pre-existing valid id "call1" already present elsewhere in the request.
    const messages: UnifiedMessage[] = [
      { role: "assistant", blocks: [toolCall("call1")] }, // already valid — must stay "call1"
      { role: "assistant", blocks: [toolCall("call/1")] }, // sanitizes to "call1" naively — must be renamed
      { role: "assistant", blocks: [toolCall("call+1")] }, // also sanitizes to "call1" naively — must be renamed, distinctly
    ];
    const sanitized = sanitizeAnthropicToolIds(messages);
    const ids = sanitized.map((m) => (m.blocks[0] as UnifiedToolCallBlock).id);
    expect(ids[0]).toBe("call1");
    expect(new Set(ids).size).toBe(3); // all three ids are distinct — no collision
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  test("an id that sanitizes to an empty string gets a fallback placeholder id", () => {
    const messages: UnifiedMessage[] = [{ role: "assistant", blocks: [toolCall("+++")] }];
    const [sanitized] = sanitizeAnthropicToolIds(messages);
    const id = (sanitized!.blocks[0] as UnifiedToolCallBlock).id;
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  test("non-tool blocks pass through unchanged", () => {
    const messages: UnifiedMessage[] = [{ role: "user", blocks: [{ type: "text", text: "hi", cache: false }] }];
    expect(sanitizeAnthropicToolIds(messages)).toEqual(messages);
  });
});

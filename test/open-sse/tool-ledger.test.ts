import { describe, expect, test } from "bun:test";
import type { ProxyRequest } from "../../src/application/contracts";
import { repairToolCallRequest, stringifyToolArguments } from "../../src/open-sse/translate/concerns/tools";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

function request(messages: ProxyRequest["messages"]): ProxyRequest {
  return {
    model: "gpt-4.1",
    messages,
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: TRANSLATION_FIXTURE_LIMITS,
  };
}

describe("shared tool-call ledger", () => {
  test("sanitizes IDs, stringifies arguments, and inserts missing results", () => {
    const repaired = repairToolCallRequest(request([
      { role: "assistant", content: [{ type: "tool_use", toolCallId: "bad id/with spaces", toolName: "Read", toolArguments: JSON.stringify({ file: "README.md" }) }] },
    ]));

    expect(repaired.request.messages).toHaveLength(2);
    expect(repaired.request.messages[0]?.content[0]).toMatchObject({ type: "tool_use", toolCallId: "bad_id_with_spaces", toolArguments: '{"file":"README.md"}' });
    expect(repaired.request.messages[1]?.content).toEqual([{ type: "tool_result", toolCallId: "bad_id_with_spaces", text: "" }]);
    expect(repaired.changes.map((change) => change.kind)).toContain("sanitized-id");
    expect(repaired.changes.map((change) => change.kind)).toContain("missing-result");
  });

  test("deduplicates repeated results while preserving structured errors", () => {
    const repaired = repairToolCallRequest(request([
      { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_read", toolName: "Read", toolArguments: "{}" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_read", text: "missing", toolResultIsError: true }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call_read", text: "duplicate" }] },
    ]));

    const results = repaired.request.messages.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "call_read", text: "missing", toolResultIsError: true });
    expect(repaired.changes.map((change) => change.kind)).toContain("duplicate-result");
  });

  test("merges adjacent same-role messages without mutating the input", () => {
    const original = request([
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "two" }] },
    ]);
    const repaired = repairToolCallRequest(original);

    expect(repaired.request.messages).toHaveLength(1);
    expect(repaired.request.messages[0]?.content.map((block) => block.text)).toEqual(["one", "two"]);
    expect(original.messages).toHaveLength(2);
    expect(repaired.changes.map((change) => change.kind)).toContain("merged-message");
  });

  test("stringifies object arguments and rejects oversized values", () => {
    expect(stringifyToolArguments({ city: "Tokyo" })).toBe('{"city":"Tokyo"}');
    expect(() => stringifyToolArguments("x".repeat(128_001))).toThrow("tool arguments exceed");
  });
});

import { describe, expect, test } from "bun:test";
import { normalizeMessagesRequest, buildMessagesPayload } from "../../src/open-sse/translate/request/anthropic";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

const input = { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS } as const;
const caps = { surfaces: ["anthropic-messages"], streaming: true, reasoning: true, toolCalls: true, images: true, mediaGeneration: [], explicitCache: false, promptCacheKey: false } as const;

describe("Claude tool-loop edge contracts", () => {
  test("keeps parallel tool results in one user message", () => {
    const normalized = normalizeMessagesRequest({
      model: "claude-opus-5", max_tokens: 256,
      tools: [
        { name: "Read", input_schema: { type: "object" } },
        { name: "Glob", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: "inspect files" },
        { role: "assistant", content: [
          { type: "tool_use", id: "toolu_read", name: "Read", input: { path: "a.ts" } },
          { type: "tool_use", id: "toolu_glob", name: "Glob", input: { pattern: "src/**/*.ts" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_read", content: "file" },
          { type: "tool_result", tool_use_id: "toolu_glob", content: "paths" },
        ] },
      ],
    }, input);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const payload = buildMessagesPayload(normalized.request, caps);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const toolMessage = messages.at(-1)!;
    expect(toolMessage.role).toBe("user");
    expect(toolMessage.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_read", content: "file" },
      { type: "tool_result", tool_use_id: "toolu_glob", content: "paths" },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { buildGeminiPayload } from "../../src/open-sse/translate/request/gemini";
import { normalizeMessagesRequest } from "../../src/open-sse/translate/request/anthropic";
import { translateGeminiResponse } from "../../src/open-sse/translate/response/gemini";
import type { ProxyRequest } from "../../src/application/contracts";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

const input = { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS } as const;

function request(messages: ProxyRequest["messages"]): ProxyRequest {
  return {
    model: "gemini-3-flash-preview", messages, tools: [], stream: false, responseFormat: "text", reasoning: "enabled",
    maxOutputTokens: 256, images: [], sourceSurface: "anthropic-messages", signal: input.signal, limits: input.limits,
  };
}

describe("Gemini thought signatures", () => {
  test("sends exact signatures as siblings of functionCall parts", () => {
    const payload = buildGeminiPayload(request([
      { role: "user", content: [{ type: "text", text: "read" }] },
      { role: "assistant", content: [{ type: "tool_use", toolCallId: "call_1", toolName: "Read", toolArguments: "{}", reasoningSignature: "sig-A" }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", toolName: "Read", text: "ok" }] },
    ]));
    const contents = payload.contents as Array<Record<string, unknown>>;
    const modelPart = (contents[1]!.parts as Array<Record<string, unknown>>)[0]!;
    expect(modelPart.functionCall).toEqual({ name: "Read", args: {}, id: "call_1" });
    expect(modelPart.thoughtSignature).toBe("sig-A");
  });

  test("returns Gemini signatures to Anthropic tool_use history", () => {
    const result = translateGeminiResponse({
      responseId: "gemini-1",
      candidates: [{ content: { parts: [{ functionCall: { name: "Read", id: "call_1", args: {} }, thoughtSignature: "sig-B" }] }, finishReason: "STOP" }],
    }, "anthropic-messages", "gemini-3-flash-preview");
    expect(result.content).toEqual([{ type: "tool_use", id: "call_1", name: "Read", input: {}, signature: "sig-B" }]);
  });
  test("does not silently drop native web-search results in Gemini history", () => {
    const nativePayload = { type: "web_search_tool_result", tool_use_id: "search_1", content: [{ type: "web_search_result", title: "Docs" }] };
    const payload = buildGeminiPayload(request([{ role: "user", content: [{ type: "native", nativeType: "web_search_tool_result", nativePayload }] }]));
    expect(((payload.contents as Array<Record<string, unknown>>)[0]!.parts as Array<Record<string, unknown>>)[0]!.text).toContain("web_search_tool_result");
  });

  test("parses Anthropic tool_use signatures before Gemini translation", () => {
    const normalized = normalizeMessagesRequest({
      model: "claude-opus-5", max_tokens: 128, messages: [
        { role: "user", content: "read" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "Read", input: {}, signature: "sig-C" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "ok" }] },
      ],
    }, input);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const payload = buildGeminiPayload(normalized.request);
    const modelPart = ((payload.contents as Array<Record<string, unknown>>)[1]!.parts as Array<Record<string, unknown>>)[0]!;
    expect(modelPart.thoughtSignature).toBe("sig-C");
  });
});

import { describe, expect, test } from "bun:test";
import { buildChatPayload, normalizeChatRequest } from "../../src/open-sse/translate/request/openai-chat";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

describe("OpenAI Chat controls", () => {
  test("preserves response schema, sampling, stop, tool, and metadata controls", () => {
    const result = normalizeChatRequest({
      model: "gpt-4.1",
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      stop: ["DONE", "STOP"],
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "weather" } },
      metadata: { trace: "fixture" },
      response_format: { type: "json_schema", json_schema: { name: "status", schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
      messages: [
        { role: "developer", content: "Follow the repository rules." },
        { role: "user", content: "Check the status." },
        { role: "assistant", tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: { city: "Tokyo" } } }], content: null },
        { role: "tool", tool_call_id: "call_weather", content: "sunny" },
      ],
      tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object" } } }],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.responseFormatSchema).toEqual({ name: "status", schema: { type: "object", properties: { ok: { type: "boolean" } } } });
    expect(result.request.temperature).toBe(0.2);
    expect(result.request.topP).toBe(0.9);
    expect(result.request.stop).toEqual(["DONE", "STOP"]);
    expect(result.request.parallelToolCalls).toBe(false);
    expect(result.request.toolChoice).toEqual({ type: "function", function: { name: "weather" } });
    expect(result.request.metadata).toEqual({ trace: "fixture" });
    expect(result.request.messages[0]?.role).toBe("developer");
    expect(result.request.messages[2]?.content[0]?.toolArguments).toBe('{"city":"Tokyo"}');

    const payload = buildChatPayload(result.request);
    expect(payload.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "status",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
    expect(payload.temperature).toBe(0.2);
    expect(payload.top_p).toBe(0.9);
    expect(payload.stop).toEqual(["DONE", "STOP"]);
    expect(payload.parallel_tool_calls).toBe(false);
    expect(payload.tool_choice).toEqual({ type: "function", function: { name: "weather" } });
    expect(payload.metadata).toEqual({ trace: "fixture" });
    expect((payload.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: "developer", content: "Follow the repository rules." });
  });

  test("omits tool_choice when cross-surface translation has no tools", () => {
    const result = normalizeChatRequest({
      model: "gpt-5.6-sol",
      tool_choice: "auto",
      messages: [{ role: "user", content: "Reply OK." }],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = buildChatPayload({ ...result.request, sourceSurface: "openai-responses" });
    expect(payload.tool_choice).toBeUndefined();
  });

  test("rejects invalid control bounds", () => {
    const result = normalizeChatRequest({ model: "gpt-4.1", temperature: 3, messages: [{ role: "user", content: "hello" }] }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });
    expect(result.ok).toBe(false);
  });
});

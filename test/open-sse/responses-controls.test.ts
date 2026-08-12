import { describe, expect, test } from "bun:test";
import { buildResponsesPayload, normalizeResponsesRequest } from "../../src/open-sse/translate/request/openai-responses";
import { TRANSLATION_FIXTURE_LIMITS } from "./fixtures/compatibility-fixtures";

describe("OpenAI Responses hybrid controls", () => {
  test("preserves schema and converts structured function arguments and outputs", () => {
    const result = normalizeResponsesRequest({
      model: "gpt-5",
      temperature: 0.1,
      top_p: 0.8,
      parallel_tool_calls: false,
      tool_choice: "required",
      metadata: { trace: "responses-fixture" },
      text: { format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } } },
      input: [
        { type: "function_call", call_id: "call_1", name: "Read", arguments: { file_path: "README.md" } },
        { type: "function_call_output", call_id: "call_1", output: { content: [{ type: "text", text: "ok" }] } },
      ],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.messages[0]?.content[0]?.toolArguments).toBe('{"file_path":"README.md"}');
    expect(result.request.messages[1]?.content[0]?.text).toBe('{"content":[{"type":"text","text":"ok"}]}');
    expect(result.request.responseFormatSchema).toEqual({ name: "answer", schema: { type: "object" } });
    expect(result.request.temperature).toBe(0.1);
    expect(result.request.topP).toBe(0.8);
    expect(result.request.parallelToolCalls).toBe(false);
    expect(result.request.toolChoice).toBe("required");
    expect(result.request.metadata).toEqual({ trace: "responses-fixture" });

    const payload = buildResponsesPayload(result.request);
    expect(payload.text).toEqual({ format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } } });
    expect(payload.temperature).toBe(0.1);
    expect(payload.top_p).toBe(0.8);
    expect(payload.parallel_tool_calls).toBe(false);
    expect(payload.tool_choice).toBe("required");
    expect(payload.metadata).toEqual({ trace: "responses-fixture" });
  });

  test("accepts Codex additional_tools items and preserves them on Responses output", () => {
    const result = normalizeResponsesRequest({
      model: "gpt-5.6-sol",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "custom", name: "shell" }, { type: "namespace", tools: ["exec"] }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Reply OK." }] },
      ],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(buildResponsesPayload(result.request).input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "custom", name: "shell" }, { type: "namespace", tools: ["exec"] }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Reply OK." }] },
    ]);
  });

  test("rejects unresolved file references instead of forwarding a file ID as a URL", () => {
    const result = normalizeResponsesRequest({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: { file_id: "file_123" } }] }],
    }, { signal: new AbortController().signal, limits: TRANSLATION_FIXTURE_LIMITS });

    expect(result.ok).toBe(false);
  });
});

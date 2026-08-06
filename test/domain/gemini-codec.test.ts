import { describe, expect, test } from "bun:test";
import { buildGeminiPayload, geminiCandidate, responseParts, translateGeminiResponse, mapGeminiUsage } from "../../src/domain/protocols/gemini-generate-content";
import type { ContentBlock, NormalizedProviderRequest, ProviderSurface } from "../../src/domain/contracts";

function baseRequest(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "gemini-2.0-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: {
      maxBodyBytes: 1_000_000,
      connectTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    },
    ...overrides,
  };
}

describe("buildGeminiPayload", () => {
  test("maps a simple user text message to contents with user role", () => {
    const payload = buildGeminiPayload(baseRequest());
    expect(payload).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
  });

  test("maps assistant role to model", () => {
    const request = baseRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello back" }] },
      ],
    });
    const contents = buildGeminiPayload(request).contents as { role: string }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model"]);
  });

  test("maps tool role to user", () => {
    const request = baseRequest({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "calling" }] },
        { role: "tool", content: [{ type: "tool_result", text: '{"result":42}', toolCallId: "call_1" }] },
      ],
    });
    const contents = buildGeminiPayload(request).contents as { role: string }[];
    expect(contents.map((c) => c.role)).toEqual(["model", "user"]);
  });

  test("extracts system messages into systemInstruction and excludes them from contents", () => {
    const request = baseRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "be helpful" }] },
        { role: "developer", content: [{ type: "text", text: "extra rules" }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    });
    const payload = buildGeminiPayload(request);
    expect(payload).toMatchObject({
      systemInstruction: { role: "user", parts: [{ text: "be helpful" }, { text: "extra rules" }] },
    });
    expect((payload.contents as unknown[]).length).toBe(1);
  });

  test("omits systemInstruction when there are no system/developer messages", () => {
    expect(buildGeminiPayload(baseRequest()).systemInstruction).toBeUndefined();
  });

  test("maps image content part with data URI into inlineData stripping the data prefix", () => {
    const block: ContentBlock = {
      type: "image",
      image: { kind: "data", value: "data:image/png;base64,iVBOR=", mediaType: "image/png" },
    };
    const request = baseRequest({ messages: [{ role: "user", content: [block] }] });
    expect(buildGeminiPayload(request)).toMatchObject({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "iVBOR=" } }] }],
    });
  });

  test("maps image content part with url kind into fileData", () => {
    const block: ContentBlock = {
      type: "image",
      image: { kind: "url", value: "https://example.com/cat.png", mediaType: null },
    };
    const request = baseRequest({ messages: [{ role: "user", content: [block] }] });
    expect(buildGeminiPayload(request)).toMatchObject({
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://example.com/cat.png", mimeType: "application/octet-stream" } }] }],
    });
  });

  test("maps tool_use block to functionCall part with parsed args", () => {
    const block: ContentBlock = {
      type: "tool_use",
      toolName: "get_weather",
      toolCallId: "call_1",
      toolArguments: '{"city":"SF"}',
    };
    const request = baseRequest({ messages: [{ role: "assistant", content: [block] }] });
    expect(buildGeminiPayload(request)).toMatchObject({
      contents: [{ role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "SF" }, id: "call_1" } }] }],
    });
  });

  test("maps tool_result block to functionResponse part", () => {
    const block: ContentBlock = {
      type: "tool_result",
      toolName: "get_weather",
      toolCallId: "call_1",
      text: '{"temp":72}',
    };
    const request = baseRequest({ messages: [{ role: "tool", content: [block] }] });
    expect(buildGeminiPayload(request)).toMatchObject({
      contents: [{ role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: 72 } } }] }],
    });
  });

  test("maps tools into functionDeclarations", () => {
    const request = baseRequest({
      tools: [{ name: "search", description: "Search the web", inputSchema: { type: "object", properties: {} } }],
    });
    expect(buildGeminiPayload(request).tools).toEqual([
      { functionDeclarations: [{ name: "search", description: "Search the web", parameters: { type: "object", properties: {} } }] },
    ]);
  });

  test("uses empty string description when tool description is null", () => {
    const request = baseRequest({
      tools: [{ name: "noop", description: null, inputSchema: {} }],
    });
    expect(buildGeminiPayload(request).tools).toEqual([
      { functionDeclarations: [{ name: "noop", description: "", parameters: {} }] },
    ]);
  });

  test("omits tools when none provided", () => {
    expect(buildGeminiPayload(baseRequest()).tools).toBeUndefined();
  });

  test("sets maxOutputTokens in generationConfig when provided", () => {
    const payload = buildGeminiPayload(baseRequest({ maxOutputTokens: 512 }));
    expect(payload).toMatchObject({ generationConfig: { maxOutputTokens: 512 } });
  });

  test("omits generationConfig when no config options apply", () => {
    expect(buildGeminiPayload(baseRequest()).generationConfig).toBeUndefined();
  });

  test("sets responseMimeType to application/json when responseFormat is json_object", () => {
    const payload = buildGeminiPayload(baseRequest({ responseFormat: "json_object" }));
    expect(payload).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
  });

  test("enables thinkingConfig when reasoning is enabled", () => {
    const payload = buildGeminiPayload(baseRequest({ reasoning: "enabled", maxOutputTokens: 1024 }));
    expect(payload).toMatchObject({ generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } });
  });

  test("thinkingConfig defaults to 8192 when maxOutputTokens is null", () => {
    const payload = buildGeminiPayload(baseRequest({ reasoning: "enabled" }));
    expect(payload).toMatchObject({ generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } });
  });

  test("thinkingConfig caps at 32768 when maxOutputTokens exceeds", () => {
    const payload = buildGeminiPayload(baseRequest({ reasoning: "enabled", maxOutputTokens: 100_000 }));
    expect(payload).toMatchObject({ generationConfig: { thinkingConfig: { thinkingBudget: 32768 } } });
  });

  test("sets responseModalities for image source surface", () => {
    const payload = buildGeminiPayload(baseRequest({ sourceSurface: "images" }));
    expect(payload).toMatchObject({ generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });
  });

  test("handles empty messages array", () => {
    const payload = buildGeminiPayload(baseRequest({ messages: [] }));
    expect(payload.contents).toEqual([]);
    expect(payload.systemInstruction).toBeUndefined();
  });

  test("handles multi-turn conversation with mixed roles", () => {
    const request = baseRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    });
    const contents = buildGeminiPayload(request).contents as { role: string; parts: { text: string }[] }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents.map((c) => c.parts[0]?.text)).toEqual(["q1", "a1", "q2"]);
  });
});

describe("geminiCandidate", () => {
  test("extracts first candidate and its parts from a standard response", () => {
    const body = {
      candidates: [{ content: { parts: [{ text: "hi" }, { functionCall: { name: "f" } }] }, finishReason: "STOP" }],
    };
    const result = geminiCandidate(body);
    expect(result.candidate).toMatchObject({ finishReason: "STOP" });
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toEqual({ text: "hi" });
  });

  test("returns empty candidate and parts when no candidates", () => {
    const result = geminiCandidate({});
    expect(result.candidate).toEqual({});
    expect(result.parts).toEqual([]);
  });

  test("returns empty parts when content is missing", () => {
    const result = geminiCandidate({ candidates: [{ finishReason: "STOP" }] });
    expect(result.parts).toEqual([]);
  });

  test("unwraps a nested response wrapper", () => {
    const result = geminiCandidate({ response: { candidates: [{ content: { parts: [{ text: "nested" }] } }] } });
    expect(result.parts).toEqual([{ text: "nested" }]);
  });

  test("filters non-record parts from the parts array", () => {
    const result = geminiCandidate({ candidates: [{ content: { parts: [{ text: "ok" }, null, 42, "bad"] } }] });
    expect(result.parts).toEqual([{ text: "ok" }]);
  });
});

describe("responseParts", () => {
  test("extracts text parts and joins them", () => {
    const result = responseParts(geminiCandidate({ candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] }).parts);
    expect(result.text).toBe("hello world");
  });

  test("extracts function call parts with id, name, and args", () => {
    const body = {
      candidates: [{ content: { parts: [{ functionCall: { id: "call_1", name: "get_weather", args: { city: "SF" } } }] } }],
    };
    expect(responseParts(geminiCandidate(body).parts).calls).toEqual([{ id: "call_1", name: "get_weather", args: { city: "SF" } }]);
  });

  test("generates a fallback id when functionCall has no id", () => {
    const body = {
      candidates: [{ content: { parts: [{ functionCall: { name: "do_thing", args: {} } }] } }],
    };
    const calls = responseParts(geminiCandidate(body).parts).calls;
    expect(calls[0]?.id).toMatch(/^call_/);
    expect(calls[0]?.name).toBe("do_thing");
  });

  test("defaults args to empty object when not a record", () => {
    const body = {
      candidates: [{ content: { parts: [{ functionCall: { name: "f", args: "not-an-object" } }] } }],
    };
    expect(responseParts(geminiCandidate(body).parts).calls[0]?.args).toEqual({});
  });

  test("separates thought parts from text parts", () => {
    const body = {
      candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "answer", thought: false }] } }],
    };
    const result = responseParts(geminiCandidate(body).parts);
    expect(result.thought).toBe("thinking");
    expect(result.text).toBe("answer");
  });

  test("returns empty text and calls for response with no parts", () => {
    const result = responseParts(geminiCandidate({}).parts);
    expect(result.text).toBe("");
    expect(result.calls).toEqual([]);
    expect(result.thought).toBe("");
  });
});

describe("mapGeminiUsage", () => {
  test("maps all token counts from usageMetadata", () => {
    const body = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30, cachedContentTokenCount: 5 } };
    expect(mapGeminiUsage(body)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: null,
      source: "provider",
    });
  });

  test("returns nulls when usageMetadata is missing", () => {
    expect(mapGeminiUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      source: "provider",
    });
  });

  test("returns nulls when usageMetadata is not a record", () => {
    const usage = mapGeminiUsage({ usageMetadata: "bad" });
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
  });

  test("handles zero values as valid numbers", () => {
    const body = { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } };
    const usage = mapGeminiUsage(body);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  test("returns null for cachedContentTokenCount when not present", () => {
    const body = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } };
    expect(mapGeminiUsage(body).cacheReadTokens).toBeNull();
  });

  test("returns null for non-finite numbers", () => {
    const body = { usageMetadata: { promptTokenCount: Infinity, candidatesTokenCount: NaN, totalTokenCount: 30 } };
    const usage = mapGeminiUsage(body);
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBe(30);
  });
});

describe("translateGeminiResponse", () => {
  const geminiBody = {
    responseId: "resp-123",
    candidates: [{ content: { parts: [{ text: "Hello there" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
  };

  test("translates to openai-chat surface with choices and usage", () => {
    const result = translateGeminiResponse(geminiBody, "openai-chat" as ProviderSurface, "gemini-2.0-flash");
    expect(result).toMatchObject({
      id: "resp-123",
      object: "chat.completion",
      model: "gemini-2.0-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });
  });

  test("maps finishReason MAX_TOKENS to length stop on openai-chat", () => {
    const body = { candidates: [{ content: { parts: [{ text: "trun" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: {} };
    const result = translateGeminiResponse(body, "openai-chat" as ProviderSurface, "m");
    expect(result).toMatchObject({ choices: [{ finish_reason: "length" }] });
  });

  test("maps tool calls to finish_reason tool_calls on openai-chat", () => {
    const body = {
      candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "f", args: {} } }] }, finishReason: "STOP" }],
    };
    const result = translateGeminiResponse(body, "openai-chat" as ProviderSurface, "m");
    expect(result).toMatchObject({
      choices: [{
        finish_reason: "tool_calls",
        message: { tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      }],
    });
  });

  test("translates to anthropic-messages surface with content blocks and stop_reason", () => {
    const result = translateGeminiResponse(geminiBody, "anthropic-messages" as ProviderSurface, "gemini-2.0-flash");
    expect(result).toMatchObject({
      id: "resp-123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
  });

  test("maps tool calls to stop_reason tool_use on anthropic-messages", () => {
    const body = {
      candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "f", args: { x: 1 } } }] }, finishReason: "STOP" }],
    };
    const result = translateGeminiResponse(body, "anthropic-messages" as ProviderSurface, "m");
    expect(result).toMatchObject({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "c1", name: "f", input: { x: 1 } }],
    });
  });

  test("maps MAX_TOKENS to stop_reason max_tokens on anthropic-messages", () => {
    const body = { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] };
    const result = translateGeminiResponse(body, "anthropic-messages" as ProviderSurface, "m");
    expect(result).toMatchObject({ stop_reason: "max_tokens" });
  });

  test("translates to openai-responses surface with output array and output_text", () => {
    const result = translateGeminiResponse(geminiBody, "openai-responses" as ProviderSurface, "gemini-2.0-flash");
    expect(result).toMatchObject({
      object: "response",
      status: "completed",
      output_text: "Hello there",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello there", annotations: [] }] }],
      usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
    });
  });

  test("maps tool calls to function_call items on openai-responses", () => {
    const body = {
      candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "f", args: { x: 1 } } }] }, finishReason: "STOP" }],
    };
    const result = translateGeminiResponse(body, "openai-responses" as ProviderSurface, "m");
    const output = result.output as unknown[];
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "c1", name: "f", arguments: '{"x":1}' }),
      ]),
    );
  });

  test("generates a fallback id when responseId is missing", () => {
    const body = { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] };
    const result = translateGeminiResponse(body, "openai-chat" as ProviderSurface, "m");
    const id = typeof result.id === "string" ? result.id : "";
    expect(id).not.toBe("");
    expect(id.startsWith("gemini-")).toBe(true);
  });

  test("includes thinking block on anthropic-messages when thought parts present", () => {
    const body = {
      candidates: [{ content: { parts: [{ text: "reasoning", thought: true }, { text: "answer" }] }, finishReason: "STOP" }],
    };
    const result = translateGeminiResponse(body, "anthropic-messages" as ProviderSurface, "m");
    expect(result).toMatchObject({
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
      ],
    });
  });

  test("handles empty candidates gracefully on openai-chat", () => {
    const result = translateGeminiResponse({}, "openai-chat" as ProviderSurface, "m");
    expect(result).toMatchObject({
      choices: [{ message: { content: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
});

import { describe, expect, test } from "bun:test";
import { wireSurfaceFor, translateNonStreamResponse } from "../../src/domain/protocols/translation";
import type { ProviderCapabilities, ProviderMetadata, ProviderSurface } from "../../src/domain/contracts";

function meta(protocol: ProviderMetadata["protocol"]): ProviderMetadata {
  return { id: `prov-${protocol}`, displayName: `Prov ${protocol}`, protocol, credentialKind: "api_key" };
}

function caps(surfaces: readonly ProviderSurface[]): ProviderCapabilities {
  return {
    surfaces,
    streaming: true,
    reasoning: false,
    toolCalls: true,
    images: false,
    explicitCache: false,
    promptCacheKey: false,
  };
}

describe("wireSurfaceFor", () => {
  test("returns the client surface directly when the provider supports it", () => {
    const m = meta("openai");
    expect(wireSurfaceFor(m, caps(["openai-chat", "openai-responses"]), "openai-chat")).toBe("openai-chat");
    expect(wireSurfaceFor(m, caps(["openai-chat", "openai-responses"]), "openai-responses")).toBe("openai-responses");
  });

  test("returns anthropic-messages directly for anthropic provider when supported", () => {
    const m = meta("anthropic");
    expect(wireSurfaceFor(m, caps(["anthropic-messages"]), "anthropic-messages")).toBe("anthropic-messages");
  });

  test("returns images surface directly when the provider supports it", () => {
    expect(wireSurfaceFor(meta("openai"), caps(["images", "openai-chat"]), "images")).toBe("images");
  });

  test("returns null for images when the provider does not support images", () => {
    expect(wireSurfaceFor(meta("openai"), caps(["openai-chat"]), "images")).toBeNull();
  });

  test("returns web-search directly when the provider supports it", () => {
    expect(wireSurfaceFor(meta("exa"), caps(["web-search"]), "web-search")).toBe("web-search");
  });

  test("returns null for web-search when not supported", () => {
    expect(wireSurfaceFor(meta("openai"), caps(["openai-chat"]), "web-search")).toBeNull();
  });

  test("maps cross-protocol request on anthropic provider to anthropic-messages when requested surface is unavailable", () => {
    const m = meta("anthropic");
    expect(wireSurfaceFor(m, caps(["anthropic-messages", "openai-responses"]), "openai-chat")).toBe("anthropic-messages");
    expect(wireSurfaceFor(m, caps(["anthropic-messages", "openai-chat"]), "openai-responses")).toBe("anthropic-messages");
  });

  test("returns null for anthropic provider that supports neither the requested surface nor anthropic-messages", () => {
    const m = meta("anthropic");
    expect(wireSurfaceFor(m, caps(["openai-responses"]), "openai-chat")).toBeNull();
  });

  test("maps cross-protocol request on gemini provider to openai-chat", () => {
    const m = meta("gemini");
    expect(wireSurfaceFor(m, caps(["openai-chat"]), "anthropic-messages")).toBe("openai-chat");
  });

  test("gemini provider falls back to first non-images surface when openai-chat is not available", () => {
    const m = meta("gemini");
    expect(wireSurfaceFor(m, caps(["openai-responses", "images"]), "anthropic-messages")).toBe("openai-responses");
  });

  test("exa provider maps to web-search when supported", () => {
    const m = meta("exa");
    expect(wireSurfaceFor(m, caps(["web-search"]), "openai-chat")).toBe("web-search");
  });

  test("exa provider returns null when web-search not available and requested surface is unsupported", () => {
    const m = meta("exa");
    expect(wireSurfaceFor(m, caps(["openai-responses"]), "openai-chat")).toBeNull();
  });

  test("native/openai provider defaults to openai-chat when available", () => {
    const m = meta("native");
    expect(wireSurfaceFor(m, caps(["openai-chat", "openai-responses"]), "anthropic-messages")).toBe("openai-chat");
  });

  test("falls back to openai-responses when only openai-responses is available", () => {
    const m = meta("native");
    expect(wireSurfaceFor(m, caps(["openai-responses"]), "anthropic-messages")).toBe("openai-responses");
  });

  test("returns null when the provider supports no compatible surfaces", () => {
    const m = meta("native");
    expect(wireSurfaceFor(m, caps(["images"]), "openai-chat")).toBeNull();
  });
});

describe("translateNonStreamResponse — pass-through cases", () => {
  test("returns body unchanged when wireSurface equals clientSurface", () => {
    const body = { choices: [{ message: { role: "assistant", content: "hi" } }] };
    expect(translateNonStreamResponse(body, "openai", "openai-chat", "openai-chat")).toBe(body);
  });

  test("returns body unchanged for images client surface", () => {
    const body = { data: [{ url: "img" }] };
    expect(translateNonStreamResponse(body, "openai", "images", "images")).toBe(body);
  });

  test("returns body unchanged for gemini protocol regardless of surfaces", () => {
    const body = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
    expect(translateNonStreamResponse(body, "gemini", "openai-chat", "openai-responses")).toBe(body);
  });
});

describe("translateNonStreamResponse — anthropic protocol", () => {
  test("translates anthropic-messages body to openai-chat via anthropicToChat", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "claude-3",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });
  });

  test("translates anthropic-messages body to openai-responses via chat intermediate", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-responses");
    expect(result).toMatchObject({
      object: "response",
      model: "claude-3",
      output_text: "hello",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
    });
  });
});

describe("translateNonStreamResponse — openai-responses wire surface", () => {
  test("translates openai-responses body to openai-chat via responsesToChat", () => {
    const body = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      output_text: "hi",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  test("translates openai-responses body to anthropic-messages via chat intermediate", () => {
    const body = {
      id: "resp_1",
      model: "gpt-4o",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      output_text: "hi",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "anthropic-messages");
    expect(result).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });
});

describe("translateNonStreamResponse — openai-chat wire to client surfaces", () => {
  test("translates openai-chat body to anthropic-messages via chatToAnthropic", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  test("translates openai-chat body to openai-responses via chatToResponses", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    expect(result).toMatchObject({
      object: "response",
      model: "gpt-4o",
      output_text: "hi",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  });

  test("returns body unchanged when clientSurface is openai-chat (same as wire)", () => {
    const body = { choices: [{ message: { content: "hi" } }] };
    expect(translateNonStreamResponse(body, "openai", "openai-chat", "openai-chat")).toBe(body);
  });
});

describe("chatToAnthropic (via translateNonStreamResponse)", () => {
  test("maps text content to text block", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  });

  test("maps tool_calls to tool_use blocks with id, name, and input", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }],
    });
  });

  test("maps reasoning_content to thinking block", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "answer", reasoning_content: "because" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({
      content: [
        { type: "thinking", thinking: "because" },
        { type: "text", text: "answer" },
      ],
    });
  });

  test("maps finish_reason length to stop_reason max_tokens", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "trunc" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({ stop_reason: "max_tokens" });
  });

  test("maps finish_reason content_filter to stop_reason refusal", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({ stop_reason: "refusal" });
  });

  test("includes cache_read_input_tokens when prompt_tokens_details.cached_tokens is present", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } });
  });

  test("falls back to empty text block when message has no content", () => {
    const body = {
      id: "c1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({ content: [{ type: "text", text: "" }] });
  });

  test("generates a fallback message id when body id is missing", () => {
    const body = {
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "anthropic-messages");
    const id = typeof result.id === "string" ? result.id : "";
    expect(id).not.toBe("");
    expect(id.startsWith("msg-")).toBe(true);
  });
});

describe("anthropicToChat (via translateNonStreamResponse)", () => {
  test("maps text content blocks to message content string", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });
  });

  test("maps multiple text blocks by joining", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({ choices: [{ message: { content: "part1part2" } }] });
  });

  test("maps tool_use blocks to tool_calls array", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({
      choices: [{
        message: {
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    });
  });

  test("maps thinking blocks to reasoning_content", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "thinking", thinking: "reasoning here" }, { type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({
      choices: [{ message: { content: "answer", reasoning_content: "reasoning here" } }],
    });
  });

  test("maps stop_reason max_tokens to finish_reason length", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [{ type: "text", text: "trunc" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({ choices: [{ finish_reason: "length" }] });
  });

  test("handles empty content array producing empty message content", () => {
    const body = {
      id: "msg_1",
      model: "claude-3",
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = translateNonStreamResponse(body, "anthropic", "anthropic-messages", "openai-chat");
    expect(result).toMatchObject({ choices: [{ message: { content: "" } }] });
  });
});

describe("chatToResponses (via translateNonStreamResponse)", () => {
  test("maps text content to message output with output_text", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    expect(result).toMatchObject({
      object: "response",
      status: "completed",
      output_text: "hello",
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  });

  test("maps tool_calls to function_call output items", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    expect(result).toMatchObject({
      output: [{ type: "function_call", call_id: "call_1", name: "f", arguments: '{"x":1}', status: "completed" }],
    });
  });

  test("maps reasoning_content to reasoning output item", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "answer", reasoning_content: "because" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    const output = result.output as unknown[];
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", summary: [{ type: "summary_text", text: "because" }] }),
      ]),
    );
  });

  test("prefixes id with resp_ when original starts with chatcmpl-", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    expect(result.id).toBe("resp_chatcmpl-1");
  });

  test("handles empty content producing empty output_text and no message item", () => {
    const body = {
      id: "resp-1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    expect(result).toMatchObject({ output_text: "" });
    const output = result.output as unknown[];
    expect(output).toEqual([]);
  });

  test("uses provided total_tokens when present", () => {
    const body = {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 99 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-chat", "openai-responses");
    expect(result).toMatchObject({ usage: { total_tokens: 99 } });
  });
});

describe("responsesToChat (via translateNonStreamResponse)", () => {
  test("maps message output item to choices message content", () => {
    const body = {
      id: "resp_1",
      object: "response",
      model: "gpt-4o",
      output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
      output_text: "hello",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  test("maps function_call items to tool_calls with finish_reason tool_calls", () => {
    const body = {
      id: "resp_1",
      model: "gpt-4o",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "f", arguments: '{"x":1}' }],
      output_text: "",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
        },
      }],
    });
  });

  test("maps reasoning output item to reasoning_content", () => {
    const body = {
      id: "resp_1",
      model: "gpt-4o",
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "because" }] }, { type: "message", content: [{ type: "output_text", text: "answer" }] }],
      output_text: "answer",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({
      choices: [{ message: { content: "answer", reasoning_content: "because" } }],
    });
  });

  test("handles empty output array by using output_text as content", () => {
    const body = {
      id: "resp_1",
      model: "gpt-4o",
      output: [],
      output_text: "fallback",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({ choices: [{ message: { content: "fallback" } }] });
  });

  test("prefers call_id over id for the tool_call id", () => {
    const body = {
      id: "resp_1",
      model: "gpt-4o",
      output: [{ type: "function_call", id: "fc_1", call_id: "preferred_id", name: "f", arguments: "{}" }],
      output_text: "",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({
      choices: [{ message: { tool_calls: [{ id: "preferred_id" }] } }],
    });
  });

  test("handles missing usage fields by defaulting to zero", () => {
    const body = {
      id: "resp_1",
      model: "gpt-4o",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      output_text: "hi",
    };
    const result = translateNonStreamResponse(body, "openai", "openai-responses", "openai-chat");
    expect(result).toMatchObject({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  });
});

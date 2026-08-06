import { describe, expect, test } from "bun:test";
import { runProxyRequest } from "../../src/app/request";
import type { ProviderCapabilities, ProviderMetadata } from "../../src/domain/contracts";
import { createBenchmarkAdapter, createBenchmarkDependencies } from "../bench/helpers";
import { capabilitiesOf } from "../../src/providers/shared";
import { translateNonStreamResponse, wireSurfaceFor } from "../../src/domain/protocols/translation";

const openaiMetadata: ProviderMetadata = { id: "openai", displayName: "OpenAI", protocol: "openai", credentialKind: "api_key" };
const anthropicMetadata: ProviderMetadata = { id: "anthropic", displayName: "Anthropic", protocol: "anthropic", credentialKind: "api_key" };
const nativeMetadata: ProviderMetadata = { id: "openrouter", displayName: "OpenRouter", protocol: "native", credentialKind: "api_key" };
const openaiCapabilities: ProviderCapabilities = capabilitiesOf({ surfaces: ["openai-chat", "openai-responses"] });
const anthropicCapabilities: ProviderCapabilities = capabilitiesOf({ surfaces: ["anthropic-messages"] });
const nativeCapabilities: ProviderCapabilities = capabilitiesOf({ surfaces: ["openai-chat"] });

const chatBody = {
  id: "chat-1",
  model: "gpt-test",
  choices: [{ index: 0, message: { role: "assistant", content: "hello", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

const anthropicBody = {
  id: "msg-1",
  model: "claude-test",
  content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "tool-1", name: "lookup", input: { q: "x" } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 4, output_tokens: 3 },
};

describe("cross-protocol translation", () => {
  test("selects native OpenAI chat wire for an Anthropic client", () => {
    expect(wireSurfaceFor(openaiMetadata, openaiCapabilities, "anthropic-messages")).toBe("openai-chat");
    expect(wireSurfaceFor(anthropicMetadata, anthropicCapabilities, "openai-responses")).toBe("anthropic-messages");
    expect(wireSurfaceFor(nativeMetadata, nativeCapabilities, "anthropic-messages")).toBe("openai-chat");
  });

  test("translates a compatible-provider response through the runtime", async () => {
    const adapter = createBenchmarkAdapter("openrouter");
    const result = await runProxyRequest({
      request: {
        endpoint: "/v1/messages",
        surface: "anthropic-messages",
        headers: new Headers(),
        body: { model: "bench-model", max_tokens: 32, messages: [{ role: "user", content: "hello" }] },
        signal: new AbortController().signal,
      },
      authorization: { apiKeyId: null, trustedIdentity: "translation-test" },
    }, createBenchmarkDependencies([adapter]));
    expect(result.status).toBe(200);
    if (result.body.mode !== "json") throw new Error("expected JSON response");
    expect(result.body.value).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] });
  });

  test("converts OpenAI Chat response to Anthropic Messages", () => {
    const result = translateNonStreamResponse(chatBody, "openai", "openai-chat", "anthropic-messages");
    expect(result).toMatchObject({ type: "message", role: "assistant", stop_reason: "tool_use" });
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } },
    ]);
  });

  test("preserves reasoning across Chat, Anthropic, and Responses surfaces", () => {
    const reasoningBody = {
      ...chatBody,
      choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "think", tool_calls: chatBody.choices[0]?.message.tool_calls }, finish_reason: "tool_calls" }],
    };
    const anthropic = translateNonStreamResponse(reasoningBody, "openai", "openai-chat", "anthropic-messages");
    expect(anthropic.content).toEqual([{ type: "thinking", thinking: "think" }, { type: "text", text: "answer" }, { type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }]);

    const responses = translateNonStreamResponse(anthropic, "anthropic", "anthropic-messages", "openai-responses");
    const responseOutput = Array.isArray(responses.output) ? responses.output : [];
    expect(responseOutput[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "think" }] });

    const chat = translateNonStreamResponse(responses, "openai", "openai-responses", "openai-chat");
    const chatChoices = Array.isArray(chat.choices) ? chat.choices : [];
    expect(chatChoices[0]).toMatchObject({ message: { reasoning_content: "think" } });
  });

  test("converts Anthropic Messages response to OpenAI Chat and Responses", () => {
    const chat = translateNonStreamResponse(anthropicBody, "anthropic", "anthropic-messages", "openai-chat");
    expect(chat).toMatchObject({ object: "chat.completion", model: "claude-test" });
    expect(chat.choices).toEqual([{ index: 0, message: { role: "assistant", content: "hello", tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: "tool_calls" }]);

    const responses = translateNonStreamResponse(anthropicBody, "anthropic", "anthropic-messages", "openai-responses");
    expect(responses).toMatchObject({ object: "response", model: "claude-test", status: "completed" });
    expect(responses.output).toEqual([
      { type: "message", id: "msg_msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] },
      { type: "function_call", id: "tool-1", call_id: "tool-1", name: "lookup", arguments: "{\"q\":\"x\"}", status: "completed" },
    ]);
  });
});

/** Missing-usage fallback (REQ-4.4): upstream responses without a usage block get an estimated, clearly marked count instead of NaN/crash. */

import { describe, expect, test } from "bun:test";
import { translateAnthropicResponseToChat, translateChatResponseToMessages } from "../../src/translate/openai-anthropic";
import type { AnthropicResponse, OpenAIChatResponse } from "../../src/translate/types";

describe("translateAnthropicResponseToChat — usage passthrough vs estimate", () => {
  const base: Omit<AnthropicResponse, "usage"> = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude",
    content: [{ type: "text", text: "hello there" }],
    stop_reason: "end_turn",
    stop_sequence: null,
  };

  test("passes real usage through unchanged", () => {
    const resp: AnthropicResponse = { ...base, usage: { input_tokens: 12, output_tokens: 3 } };
    const chat = translateAnthropicResponseToChat(resp);
    expect(chat.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } });
  });

  test("estimates usage and marks it when the upstream omits the usage block", () => {
    const resp = { ...base, usage: undefined } as unknown as AnthropicResponse;
    const chat = translateAnthropicResponseToChat(resp);
    expect(chat.usage.estimated).toBe(true);
    expect(chat.usage.completion_tokens).toBeGreaterThan(0);
  });
});

describe("translateChatResponseToMessages — usage passthrough vs estimate", () => {
  const base: Omit<OpenAIChatResponse, "usage"> = {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "gpt",
    choices: [{ index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
  };

  test("passes real usage through unchanged", () => {
    const resp: OpenAIChatResponse = { ...base, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } };
    const anthropic = translateChatResponseToMessages(resp);
    expect(anthropic.usage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test("estimates usage and marks it when the upstream omits the usage block", () => {
    const resp = { ...base, usage: undefined } as unknown as OpenAIChatResponse;
    const anthropic = translateChatResponseToMessages(resp);
    expect(anthropic.usage.estimated).toBe(true);
    expect(anthropic.usage.output_tokens).toBeGreaterThan(0);
    expect(anthropic.usage.input_tokens).toBe(0);
  });
});

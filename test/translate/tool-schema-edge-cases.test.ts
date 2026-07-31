/**
 * Cross-surface tool-array edge cases (found by direct execution, not just
 * reading): a zero-argument tool that omits its schema field entirely, and
 * a request that mixes custom function tools with a provider's own built-in
 * tools (web_search, computer_use, ...). Before the fix, the first case
 * silently dropped `input_schema` from the wire (Anthropic then rejects the
 * WHOLE request with a 400 covering every tool, not just the under-specified
 * one) and the second crashed the translator outright with a raw TypeError
 * on `t.function.name` / `t.name` for the four request-translation
 * functions below (Chat<->Anthropic, Chat<->Responses).
 */

import { describe, expect, test } from "bun:test";
import { translateChatRequestToAnthropic, translateMessagesRequestToChat } from "../../src/translate/openai-anthropic";
import { translateChatRequestToResponses, translateResponsesRequestToChat } from "../../src/translate/openai-responses";
import type { AnthropicRequest, OpenAIChatRequest, OpenAIResponsesRequest } from "../../src/translate/types";

const EMPTY_SCHEMA = { type: "object", properties: {} };

describe("tool schema edge cases — zero-argument tool without an explicit schema", () => {
  test("Chat -> Anthropic: a tool with no `parameters` still carries a present, valid input_schema", () => {
    const req: OpenAIChatRequest = {
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "list_files", description: "Lists files" } }],
    };
    const out = translateChatRequestToAnthropic(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.input_schema).toEqual(EMPTY_SCHEMA);
    // The field must actually serialize onto the wire, not just exist as an undefined key.
    expect(JSON.stringify(out.tools)).toContain('"input_schema"');
  });

  test("Anthropic -> Chat: a tool with no input_schema still carries a present, valid parameters object", () => {
    const req: AnthropicRequest = {
      model: "claude-test",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "list_files", description: "Lists files" }],
    };
    const out = translateMessagesRequestToChat(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.function!.parameters).toEqual(EMPTY_SCHEMA);
  });

  test("Chat -> Responses: a tool with no `parameters` still carries a present, valid parameters object", () => {
    const req: OpenAIChatRequest = {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "list_files" } }],
    };
    const out = translateChatRequestToResponses(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.parameters).toEqual(EMPTY_SCHEMA);
  });

  test("Responses -> Chat: a tool with no `parameters` still carries a present, valid parameters object", () => {
    const req: OpenAIResponsesRequest = {
      model: "gpt-test",
      input: "hi",
      tools: [{ type: "function", name: "list_files" }],
    };
    const out = translateResponsesRequestToChat(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.function!.parameters).toEqual(EMPTY_SCHEMA);
  });
});

describe("tool schema edge cases — built-in / non-function tools mixed with custom function tools", () => {
  test("Chat -> Anthropic: a Responses-family built-in tool (no `.function`) is dropped, not a crash", () => {
    const req: OpenAIChatRequest = {
      model: "claude-test",
      messages: [{ role: "user", content: "search the web" }],
      tools: [{ type: "web_search" } as never, { type: "function", function: { name: "get_status", parameters: EMPTY_SCHEMA } }],
    };
    expect(() => translateChatRequestToAnthropic(req)).not.toThrow();
    const out = translateChatRequestToAnthropic(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.name).toBe("get_status");
  });

  test("Anthropic -> Chat: an Anthropic server-side tool (computer_20250124, no input_schema) is dropped, not forwarded with a synthesized schema", () => {
    const req: AnthropicRequest = {
      model: "claude-test",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "computer", type: "computer_20250124" },
        { name: "get_status", input_schema: EMPTY_SCHEMA },
      ],
    };
    const out = translateMessagesRequestToChat(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.function!.name).toBe("get_status");
  });

  test("Chat -> Responses: a built-in tool (no `.function`) is dropped, not a crash", () => {
    const req: OpenAIChatRequest = {
      model: "gpt-test",
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "code_interpreter" } as never, { type: "function", function: { name: "get_status", parameters: EMPTY_SCHEMA } }],
    };
    expect(() => translateChatRequestToResponses(req)).not.toThrow();
    const out = translateChatRequestToResponses(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.name).toBe("get_status");
  });

  test("Responses -> Chat: a built-in tool (web_search_preview, no name/parameters) is dropped, not forwarded as a garbage function named \"undefined\"", () => {
    const req: OpenAIResponsesRequest = {
      model: "gpt-test",
      input: "search",
      tools: [{ type: "web_search_preview" } as never, { type: "function", name: "get_status", parameters: EMPTY_SCHEMA }],
    };
    const out = translateResponsesRequestToChat(req);
    expect(out.tools).toHaveLength(1);
    expect(out.tools![0]!.function!.name).toBe("get_status");
  });

  test("a tools array made up ENTIRELY of built-in tools drops the `tools` key rather than sending an empty array (some providers reject empty tools[])", () => {
    const req: OpenAIChatRequest = {
      model: "claude-test",
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search" } as never],
    };
    const out = translateChatRequestToAnthropic(req);
    expect(out.tools).toBeUndefined();
  });
});

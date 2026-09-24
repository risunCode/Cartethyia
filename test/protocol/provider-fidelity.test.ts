/**
 * Regression coverage for the provider-fidelity fixes: parameters and content
 * shapes that the surface parsers / wire builders previously dropped or
 * mis-shaped. One test per fixed contract.
 */
import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";
import { canonicalToChatPayload } from "../../src/protocol/request/chat";
import { canonicalToResponsesPayload } from "../../src/protocol/request/responses";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { parseResponsesResponseToEvents, decodeResponsesSseStream } from "../../src/protocol/response/responses";
import { parseClaudeSseStream } from "../../src/protocol/response/messages";
import { MessagesAdapter } from "../../src/transport/surface/messages/adapter";
import { ResponsesAdapter } from "../../src/transport/surface/responses/adapter";
import { ChatAdapter } from "../../src/transport/surface/chat/adapter";
import { normalizeUsage, usageToChatWire } from "../../src/providers/usage";
import { collect, streamOf } from "../helpers/sse-fixtures";


function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  } as CanonicalRequest;
}



describe("F1 chat reasoning_effort forwarding", () => {
  test("emits the caller's effort as the top-level Chat parameter", () => {
    const payload = canonicalToChatPayload(request({ reasoning: { effort: "high" } }));
    expect(payload.reasoning_effort).toBe("high");
  });

  test("omits reasoning_effort when the caller did not request it", () => {
    const payload = canonicalToChatPayload(request());
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});

describe("cross-provider reasoning replay", () => {
  test("preserves reasoning in the Chat-native reasoning_content side channel", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              {
                kind: "reasoning",
                payload: "private DeepSeek reasoning",
                summary: "private DeepSeek reasoning",
                signature: "",
              },
              { kind: "text", text: "public answer" },
            ],
          },
        ],
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe("public answer");
    expect(messages[0]?.reasoning_content).toBe("private DeepSeek reasoning");
  });
});

describe("F5 chat image detail", () => {
  test("preserves image_url.detail on the outbound part", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "image",
                payload: { type: "image_url", image_url: { url: "https://x/y.png", detail: "high" } },
              },
            ],
          },
        ],
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://x/y.png", detail: "high" } },
    ]);
  });

  test("resolves Responses input_image shapes (image_url string + detail)", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "user",
            content: [
              { kind: "image", payload: { type: "input_image", image_url: "https://x/z.png", detail: "low" } },
            ],
          },
        ],
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://x/z.png", detail: "low" } },
    ]);
  });
});

describe("F7 custom tools and tool_choice", () => {
  test("emits custom tool definitions and custom tool_choice", () => {
    const payload = canonicalToChatPayload(
      request({
        tools: [
          {
            name: "my_custom",
            description: "d",
            jsonSchema: { type: "object" },
            tool_type: "custom",
          },
        ],
        tool_choice: { type: "custom", name: "my_custom" },
      }),
    );
    expect(payload.tools).toEqual([
      { type: "custom", custom: { name: "my_custom", description: "d", format: { type: "object" } } },
    ]);
    expect(payload.tool_choice).toEqual({ type: "custom", custom: { name: "my_custom" } });
  });

  test("emits a named function tool_choice in the documented shape", () => {
    const payload = canonicalToChatPayload(
      request({ tool_choice: { type: "tool", name: "lookup" } }),
    );
    expect(payload.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
  });

  test("surface parses allowed_callers and custom tool choice", () => {
    const adapter = new ChatAdapter();
    const parsed = adapter.parse({
      model: "gpt-chat",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
          allowed_callers: ["direct", "programmatic"],
        },
      ],
      tool_choice: { type: "custom", custom: { name: "my_custom" } },
    });
    expect(parsed.tools?.[0]?.allowed_callers).toEqual(["direct", "programmatic"]);
    expect(parsed.tool_choice).toEqual({ type: "custom", name: "my_custom" });
  });
});

describe("F9 chat input_audio format", () => {
  test("maps a MIME media_type to the discrete wire format", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          { role: "user", content: [{ kind: "audio", data: "AAA", media_type: "audio/wav" }] },
        ],
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      { type: "input_audio", input_audio: { data: "AAA", format: "wav" } },
    ]);
  });
});

describe("F12 chat json_schema name/description", () => {
  test("emits the nested json_schema envelope with name and description", () => {
    const payload = canonicalToChatPayload(
      request({
        response_format: {
          type: "json_schema",
          name: "person",
          description: "a person",
          schema: { type: "object" },
          strict: true,
        },
      }),
    );
    expect(payload.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "person", description: "a person", schema: { type: "object" }, strict: true },
    });
  });
});

describe("F14/F21 explicit prompt-cache breakpoints", () => {
  test("chat payload marks the latest stable block before the last user turn", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          { role: "system", content: [{ kind: "text", text: "sys" }] },
          { role: "user", content: [{ kind: "text", text: "first" }] },
          { role: "assistant", content: [{ kind: "text", text: "ok" }] },
          { role: "user", content: [{ kind: "text", text: "second" }] },
        ],
        cache_hint: { kind: "breakpoint", list: [1] },
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    const marked = (messages[1]?.content as Array<Record<string, unknown>>)[0];
    expect(marked?.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(payload).not.toHaveProperty("prompt_cache_breakpoint");
  });

  test("responses payload marks the latest stable input block", () => {
    const payload = canonicalToResponsesPayload(
      request({
        source_surface: "responses",
        messages: [
          { role: "system", content: [{ kind: "text", text: "sys" }] },
          { role: "user", content: [{ kind: "text", text: "first" }] },
          { role: "assistant", content: [{ kind: "text", text: "ok" }] },
          { role: "user", content: [{ kind: "text", text: "second" }] },
        ],
        cache_hint: { kind: "breakpoint", list: [1] },
      }),
    );
    const input = payload.input as Array<Record<string, unknown>>;
    const marked = (input[1]?.content as Array<Record<string, unknown>>)[0];
    expect(marked?.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
  });
});

describe("F8 computer_call decoding", () => {
  test("non-stream response surfaces a computer tool call", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_1",
        output: [
          {
            type: "computer_call",
            id: "cc_1",
            call_id: "call_1",
            actions: [{ type: "click", x: 1, y: 2 }],
            status: "completed",
          },
        ],
        status: "completed",
        usage: {},
      },
      request({ source_surface: "responses" }),
    );
    const toolCall = events.find(
      (event): event is Extract<CanonicalEvent, { type: "tool_call_delta" }> =>
        event.type === "tool_call_delta",
    );
    expect(toolCall).toMatchObject({ call_id: "call_1", name: "computer" });
    expect(JSON.parse(toolCall?.arguments_delta ?? "{}")).toEqual({
      actions: [{ type: "click", x: 1, y: 2 }],
    });
  });

  test("streaming decoder surfaces a computer_call output item", async () => {
    const sse =
      `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"computer_call","id":"cc_1","call_id":"call_1","actions":[{"type":"screenshot"}]}}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n`;
    const events = await collect(
      decodeResponsesSseStream(streamOf(sse), request({ source_surface: "responses" })),
    );
    const toolCall = events.find(
      (event): event is Extract<CanonicalEvent, { type: "tool_call_delta" }> =>
        event.type === "tool_call_delta",
    );
    expect(toolCall).toMatchObject({ call_id: "call_1", name: "computer" });
    expect(JSON.parse(toolCall?.arguments_delta ?? "{}")).toEqual({
      actions: [{ type: "screenshot" }],
    });
  });

  test("non-stream response surfaces a computer_call_output as a tool result", () => {
    const events = parseResponsesResponseToEvents(
      {
        id: "resp_2",
        output: [
          {
            type: "computer_call_output",
            call_id: "call_1",
            output: { type: "computer_screenshot", image_url: "https://x/shot.png" },
          },
        ],
        status: "completed",
        usage: {},
      },
      request({ source_surface: "responses" }),
    );
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult).toMatchObject({ call_id: "call_1" });
  });
});

describe("F15 prediction-token usage", () => {
  test("normalizes and re-emits prediction token details", () => {
    const usage = normalizeUsage({
      input_tokens: 10,
      output_tokens: 20,
      completion_tokens_details: {
        reasoning_tokens: 5,
        accepted_prediction_tokens: 3,
        rejected_prediction_tokens: 1,
      },
    });
    expect(usage.details?.accepted_prediction_tokens).toBe(3);
    expect(usage.details?.rejected_prediction_tokens).toBe(1);
    const wire = usageToChatWire(usage);
    expect(wire.completion_tokens_details).toMatchObject({
      reasoning_tokens: 5,
      accepted_prediction_tokens: 3,
      rejected_prediction_tokens: 1,
    });
  });
});

describe("F17 Responses temperature/top_p", () => {
  test("parses temperature and top_p into generation controls", () => {
    const adapter = new ResponsesAdapter();
    const parsed = adapter.parse({ model: "m", input: "hi", temperature: 0.3, top_p: 0.9 });
    expect(parsed.generation_controls.temperature).toBe(0.3);
    expect(parsed.generation_controls.top_p).toBe(0.9);
  });
});

describe("document/file fidelity across wires", () => {
  test("Chat surface parses the nested OpenAI file part", () => {
    const adapter = new ChatAdapter();
    const parsed = adapter.parse({
      model: "gpt-chat",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { file_data: "QUJD", filename: "a.pdf", file_id: "file_1" },
            },
          ],
        },
      ],
    });
    expect(parsed.messages[0]?.content[0]).toMatchObject({
      kind: "file",
      data: "QUJD",
      filename: "a.pdf",
      file_id: "file_1",
    });
  });

  test("Chat surface parses the nested OpenAI input_audio part", () => {
    const adapter = new ChatAdapter();
    const parsed = adapter.parse({
      model: "gpt-chat",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }],
        },
      ],
    });
    expect(parsed.messages[0]?.content[0]).toMatchObject({
      kind: "audio",
      data: "AAA",
      media_type: "audio/wav",
    });
  });

  test("Messages document preserves source_type/url/file_id and re-encodes them", () => {
    const adapter = new MessagesAdapter();
    const parsed = adapter.parse({
      model: "claude-4-6-sonnet",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "url", url: "https://x/doc.pdf" } },
            { type: "document", source: { type: "file", file_id: "file_9" } },
          ],
        },
      ],
    });
    expect(parsed.messages[0]?.content[0]).toMatchObject({
      kind: "document",
      source_type: "url",
      url: "https://x/doc.pdf",
    });
    expect(parsed.messages[0]?.content[1]).toMatchObject({
      kind: "document",
      source_type: "file",
      file_id: "file_9",
    });
    const payload = canonicalToClaudeMessagesPayload(parsed);
    const blocks = (payload.messages as Array<Record<string, unknown>>)[0]?.content as Array<
      Record<string, unknown>
    >;
    expect(blocks[0]?.source).toEqual({ type: "url", url: "https://x/doc.pdf" });
    expect(blocks[1]?.source).toEqual({ type: "file", file_id: "file_9" });
  });

  test("Chat carries a document as a file part, preferring file_id", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "document",
                data: "QUJD",
                media_type: "application/pdf",
                title: "a.pdf",
                source_type: "file",
                file_id: "file_1",
              },
            ],
          },
        ],
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      { type: "file", file: { file_id: "file_1", filename: "a.pdf" } },
    ]);
  });

  test("Chat degrades a URL-only document to text instead of an empty file block", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "document",
                data: "https://x/doc.pdf",
                media_type: "application/pdf",
                source_type: "url",
                url: "https://x/doc.pdf",
              },
            ],
          },
        ],
      }),
    );
    const messages = payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "[file: https://x/doc.pdf]" },
    ]);
  });

  test("Responses carries a URL document as input_file.file_url", () => {
    const payload = canonicalToResponsesPayload(
      request({
        source_surface: "responses",
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "document",
                data: "https://x/doc.pdf",
                media_type: "application/pdf",
                source_type: "url",
                url: "https://x/doc.pdf",
              },
            ],
          },
        ],
      }),
    );
    const input = payload.input as Array<Record<string, unknown>>;
    expect((input[0]?.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "input_file",
      file_url: "https://x/doc.pdf",
    });
  });

  test("Responses surface parses input_file.file_url into a canonical file", () => {
    const adapter = new ResponsesAdapter();
    const parsed = adapter.parse({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_file", file_url: "https://x/doc.pdf", filename: "d.pdf" }],
        },
      ],
    });
    expect(parsed.messages[0]?.content[0]).toMatchObject({
      kind: "file",
      url: "https://x/doc.pdf",
      filename: "d.pdf",
    });
  });
});

describe("F2/F3/F4/F19 Messages thinking", () => {
  const adapter = new MessagesAdapter();

  test("rejects an adaptive budget that is not below max_tokens", () => {
    expect(() =>
      adapter.parse({
        model: "claude-4-6-sonnet",
        max_tokens: 4096,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "adaptive", budget_tokens: 4096 },
      }),
    ).toThrow(/less than max_tokens/);
  });

  test("preserves thinking.display and block_binding", () => {
    const parsed = adapter.parse({
      model: "claude-4-6-sonnet",
      max_tokens: 8192,
      messages: [{ role: "user", content: "hi" }],
      thinking: {
        type: "adaptive",
        display: "omitted",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
    });
    expect(parsed.reasoning).toMatchObject({
      thinking_type: "adaptive",
      display: "omitted",
      prefix_mismatch_behavior: "drop_block",
    });
  });

  test("folds output_config effort/task_budget into the reasoning intent", () => {
    const parsed = adapter.parse({
      model: "claude-4-6-sonnet",
      max_tokens: 8192,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high", task_budget: 1000 },
    });
    expect(parsed.reasoning).toMatchObject({ effort: "high", task_budget: 1000 });
  });

  test("payload emits thinking.block_binding and never output_config.thinking_display", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        model: "claude-4-6-sonnet",
        reasoning: {
          thinking_type: "adaptive",
          display: "summarized",
          prefix_mismatch_behavior: "error",
          effort: "high",
        },
      }),
    );
    expect(payload.thinking).toMatchObject({
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "error" },
    });
    expect(payload.output_config).toEqual({ effort: "high" });
  });
});

describe("T0-2 OAuth tool name unprefixed in first delta", () => {
  test("OAuth stream unprefixed the first tool name delta", async () => {
    // Simulate an OAuth stream where the first delta carries a prefixed name
    const sse =
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"_search","input":{"query":"test"}}}\n\n` +
      `data: {"type":"content_block_stop","index":0}\n\n` +
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n` +
      `data: {"type":"message_stop"}`;
    
    const events = await collect(
      parseClaudeSseStream(streamOf(sse), undefined, true), // isOAuth=true
    );
    
    // Find the first tool_call_delta event
    const firstToolCall = events.find(
      (event): event is Extract<CanonicalEvent, { type: "tool_call_delta" }> =>
        event.type === "tool_call_delta",
    );
    
    // The name should be unprefixed (canonical) even in the first delta
    expect(firstToolCall?.name).toBe("search");
    expect(firstToolCall?.name).not.toBe("_search");
  });
});

describe("F2 chat emits Messages-homed tool results as role:tool", () => {
  test("user-homed toolResult reaches the chat wire with its call id", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "call_1", name: "read", arguments: "{}" }],
          },
          { role: "user", content: [{ kind: "toolResult", call_id: "call_1", content: "file bytes" }] },
        ],
      }),
    );
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "call_1", content: "file bytes" });
  });

  test("error results keep the visible error flag on the chat wire", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "call_2", name: "bash", arguments: "{}" }],
          },
          {
            role: "user",
            content: [{ kind: "toolResult", call_id: "call_2", content: "boom", is_error: true }],
          },
        ],
      }),
    );
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_2",
      content: "[tool_error] boom",
    });
  });

  test("mixed user text is preserved alongside the emitted tool result", () => {
    const payload = canonicalToChatPayload(
      request({
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "call_3", name: "read", arguments: "{}" }],
          },
          {
            role: "user",
            content: [
              { kind: "text", text: "done" },
              { kind: "toolResult", call_id: "call_3", content: "ok" },
            ],
          },
        ],
      }),
    );
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "call_3", content: "ok" });
    expect(messages).toContainEqual({ role: "user", content: "done\n" });
  });
  });

import { describe, expect, test } from "bun:test";
import { canonicalToResponsesPayload } from "../../../src/protocol/request/responses";
import { MessagesAdapter } from "../../../src/transport/surface/messages/adapter";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

describe("canonicalToResponsesPayload", () => {
  test("emits function_call_output when a Messages session carries role:user tool results", () => {
    const req = new MessagesAdapter().parse({
      model: "grok-4.6",
      max_tokens: 100,
      messages: [
        { role: "user", content: "what is 2+2? use calc" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "calculator", input: { expr: "2+2" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "4" }] },
      ],
      tools: [
        {
          name: "calculator",
          input_schema: { type: "object", properties: { expr: { type: "string" } } },
        },
      ],
    });

    const payload = canonicalToResponsesPayload(req as unknown as CanonicalRequest);
    const input = payload.input as Array<Record<string, unknown>>;

    expect(input.find((item) => item.type === "function_call_output")).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "4",
    });
    // The result must not be swallowed into an empty user message.
    const emptyUserMessages = input.filter(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        Array.isArray(item.content) &&
        (item.content as unknown[]).length === 0,
    );
    expect(emptyUserMessages).toEqual([]);
  });

  test("still emits function_call_output for role:tool results (OpenAI Chat)", () => {
    const req = {
      model: "m",
      stream: false,
      generation_controls: {},
      messages: [
        { role: "user", content: [{ kind: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ kind: "toolCall", call_id: "c1", name: "f", arguments: "{}" }],
        },
        { role: "tool", content: [{ kind: "toolResult", call_id: "c1", content: "done" }] },
      ],
    } as unknown as CanonicalRequest;

    const input = canonicalToResponsesPayload(req).input as Array<Record<string, unknown>>;
    expect(input.find((item) => item.type === "function_call_output")).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: "done",
    });
  });

  test("replays a Messages thinking block as a reasoning item", () => {
    const req = new MessagesAdapter().parse({
      model: "grok-4.7",
      max_tokens: 100,
      messages: [
        { role: "user", content: "what is 17 times 23?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "17*20=340, 17*3=51, total 391" },
            { type: "text", text: "391" },
          ],
        },
        { role: "user", content: "now add 9" },
      ],
    });

    const payload = canonicalToResponsesPayload(req as unknown as CanonicalRequest);
    const input = payload.input as Array<Record<string, unknown>>;
    const reasoning = input.find((item) => item.type === "reasoning");
    expect(reasoning).toBeDefined();
    const summary = reasoning?.summary as Array<Record<string, unknown>>;
    expect(summary[0]).toMatchObject({ type: "summary_text", text: "17*20=340, 17*3=51, total 391" });
  });
});
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

  /**
   * `image_url` is a *string* on the Responses wire. A canonical image part is
   * an opaque origin payload, so the computer-use screenshot renderer must
   * resolve it — forwarding the object makes the provider reject the request
   * with "expected an image URL, but got an object instead".
   */
  describe("computer-use screenshots resolve the image part", () => {
    function screenshotFor(payload: unknown): Record<string, unknown> | undefined {
      const req = {
        model: "gpt-5",
        generation_controls: {},
        stream: false,
        source_surface: "responses",
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "c1", name: "computer", call_kind: "computer" }],
          },
          {
            role: "user",
            content: [
              {
                kind: "toolResult",
                call_id: "c1",
                call_kind: "computer",
                content: [{ kind: "image", payload }],
              },
            ],
          },
        ],
      } as unknown as CanonicalRequest;
      const payloadBody = canonicalToResponsesPayload(req);
      const input = payloadBody.input as Array<Record<string, unknown>>;
      const output = input.find((item) => item.type === "computer_call_output");
      return output?.["output"] as Record<string, unknown> | undefined;
    }

    test("a nested Chat image_url object becomes its URL", () => {
      const output = screenshotFor({ image_url: { url: "https://x/shot.png" } });
      expect(output?.["type"]).toBe("computer_screenshot");
      expect(output?.["image_url"]).toBe("https://x/shot.png");
    });

    test("an Anthropic base64 source becomes a data URL", () => {
      const output = screenshotFor({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      });
      expect(output?.["image_url"]).toBe("data:image/png;base64,AAAA");
    });

    test("no screenshot puts a non-string image_url on the wire", () => {
      const shapes: unknown[] = [
        { image_url: { url: "https://x/a.png" } },
        { url: "https://x/a.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "image", source: { type: "url", url: "https://x/b.png" } },
      ];
      for (const shape of shapes) {
        const output = screenshotFor(shape);
        const imageUrl = output?.["image_url"];
        if (imageUrl === undefined) continue;
        expect({ shape, imageUrl: typeof imageUrl }).toEqual({ shape, imageUrl: "string" });
      }
    });
  });
});

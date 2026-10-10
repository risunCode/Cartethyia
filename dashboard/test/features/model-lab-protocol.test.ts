import { describe, expect, test } from "bun:test";
import { buildLabRequest, reasoningDelta, takeSseEvents, textDelta, type LabRequestSettings } from "../../src/features/studio/protocol";

const settings = (patch: Partial<LabRequestSettings> = {}): LabRequestSettings => ({
  protocol: "chat",
  mode: "agentic",
  model: "openai/gpt-4.1",
  systemPrompt: "",
  temperature: "",
  topP: "",
  effort: "auto",
  ...patch,
});

describe("buildLabRequest", () => {
  test("chat puts the system prompt ahead of the turns and omits empty sampling", () => {
    const built = buildLabRequest(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "" },
      ],
      settings({ systemPrompt: "be brief", temperature: "0.4" }),
    );
    expect(built.path).toBe("/v1/chat/completions");
    expect(built.body).toEqual({
      model: "openai/gpt-4.1",
      stream: true,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.4,
    });
  });

  test("responses uses input and messages uses a top-level system field", () => {
    const turns = [{ role: "user" as const, text: "draw a cat" }];
    const responses = buildLabRequest(turns, settings({ protocol: "responses", topP: "0.9", effort: "high" }));
    expect(responses.path).toBe("/v1/responses");
    expect(responses.body.input).toEqual([{ role: "user", content: "draw a cat" }]);
    expect(responses.body.top_p).toBe(0.9);
    expect(responses.body.reasoning).toEqual({ effort: "high" });

    const messages = buildLabRequest(turns, settings({ protocol: "messages", systemPrompt: "stay on topic" }));
    expect(messages.path).toBe("/v1/messages");
    expect(messages.body.system).toBe("stay on topic");
    expect(messages.body.max_tokens).toBe(4096);
    expect(messages.body.messages).toEqual([{ role: "user", content: "draw a cat" }]);
  });

  test("a blank sampling field is not sent as zero", () => {
    const built = buildLabRequest([{ role: "user", text: "hi" }], settings({ temperature: "  ", topP: "nope" }));
    expect(built.body.temperature).toBeUndefined();
    expect(built.body.top_p).toBeUndefined();
  });

  test("an attached image is a wire image part, and a blank turn is kept", () => {
    const image = { name: "cat.png", dataUrl: "data:image/png;base64,Y2F0" };
    const chat = buildLabRequest([{ role: "user", text: "", images: [image] }], settings());
    expect(chat.body.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: image.dataUrl } }] },
    ]);
    const messages = buildLabRequest(
      [{ role: "user", text: "look", images: [image] }],
      settings({ protocol: "messages" }),
    );
    expect(messages.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "url", url: image.dataUrl } },
        ],
      },
    ]);
  });
});

describe("stream text", () => {
  test("a split SSE frame waits for the blank line", () => {
    const first = takeSseEvents('data: {"choices":[{"delta":{"content":"hel"');
    expect(first.events).toEqual([]);
    expect(first.rest.startsWith("data:")).toBe(true);
    const second = takeSseEvents(`${first.rest}lo"}}]}\n\ndata: [DONE]\n\n`);
    expect(second.events.map((event) => event.data)).toEqual(['{"choices":[{"delta":{"content":"hel"lo"}}]}', "[DONE]"]);
  });

  test("each wire contributes only its own text delta", () => {
    expect(textDelta("chat", "message", { choices: [{ delta: { content: "yo" } }] })).toBe("yo");
    expect(textDelta("responses", "response.output_text.delta", { delta: "yo" })).toBe("yo");
    expect(textDelta("responses", "response.created", { delta: "yo" })).toBe("");
    expect(textDelta("messages", "content_block_delta", { delta: { text: "yo" } })).toBe("yo");
    expect(textDelta("chat", "message", { choices: [{ delta: { reasoning_content: "hmm" } }] })).toBe("");
    expect(reasoningDelta("chat", "message", { choices: [{ delta: { reasoning_content: "hmm" } }] })).toBe("hmm");
    expect(reasoningDelta("messages", "content_block_delta", { delta: { type: "thinking_delta", thinking: "hmm" } })).toBe("hmm");
    expect(reasoningDelta("responses", "response.reasoning_text.delta", { delta: "hmm" })).toBe("hmm");
  });
});

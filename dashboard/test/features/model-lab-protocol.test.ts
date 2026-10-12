import { describe, expect, test } from "bun:test";
import { buildLabRequest, reasoningDelta, takeSseEvents, textDelta, type LabRequestSettings } from "../../src/features/studio/protocol";
import { readLabStream } from "../../src/features/studio/stream";

const settings = (patch: Partial<LabRequestSettings> = {}): LabRequestSettings => ({
  protocol: "chat",
  persona: "cartethyia",
  model: "openai/gpt-4.1",
  systemPrompt: "",
  temperature: "",
  topP: "",
  effort: "auto",
  ...patch,
});

function systemText(body: Record<string, unknown>): string | undefined {
  if (typeof body.system === "string") return body.system;
  const turns = body.input ?? body.messages;
  if (!Array.isArray(turns)) return undefined;
  const systemTurn = turns.find((turn) =>
    turn !== null && typeof turn === "object" && (turn as Record<string, unknown>).role === "system",
  );
  if (systemTurn === null || typeof systemTurn !== "object") return undefined;
  const content = (systemTurn as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

describe("buildLabRequest", () => {
  test("chat puts the system prompt ahead of the turns and omits empty sampling", () => {
    const built = buildLabRequest(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "" },
      ],
      settings({ persona: "unset", systemPrompt: "be brief", temperature: "0.4" }),
    );
    expect(built.path).toBe("/v1/chat/completions");
    expect(built.body.model).toBe("openai/gpt-4.1");
    expect(built.body.stream).toBe(true);
    expect(built.body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(built.body.temperature).toBe(0.4);
    expect(built.body.tools).toBeUndefined();
  });

  test("responses uses input and messages uses a top-level system field", () => {
    const turns = [{ role: "user" as const, text: "draw a cat" }];
    const responses = buildLabRequest(turns, settings({ protocol: "responses", persona: "unset", topP: "0.9", effort: "high" }));
    expect(responses.path).toBe("/v1/responses");
    expect(responses.body.input).toEqual([{ role: "user", content: "draw a cat" }]);
    expect(responses.body.top_p).toBe(0.9);
    expect(responses.body.reasoning).toEqual({ effort: "high" });

    const messages = buildLabRequest(turns, settings({ protocol: "messages", persona: "unset", systemPrompt: "stay on topic" }));
    expect(messages.path).toBe("/v1/messages");
    expect(messages.body.system).toBe("stay on topic");
    expect(messages.body.max_tokens).toBe(4096);
    expect(messages.body.messages).toEqual([{ role: "user", content: "draw a cat" }]);
  });

  test("the default persona includes send-time context and combines the user's prompt across all wires", () => {
    for (const protocol of ["chat", "responses", "messages"] as const) {
      const built = buildLabRequest(
        [{ role: "user", text: "hello" }],
        settings({ protocol, systemPrompt: "Keep answers concise." }),
      );
      const system = systemText(built.body);
      expect(system).toContain("Cartethyia Model Lab");
      expect(system).toContain("Local date and time:");
      expect(system).toContain("Selected model: openai/gpt-4.1");
      expect(system).toContain(`Selected protocol: ${protocol}`);
      expect(system).toContain("## User system prompt\nKeep answers concise.");
      expect(system).toContain("You do not have web search or other external tools");
      expect(system).toContain("access to the local filesystem");
      expect(system).toContain("inspect the user's device or runtime");
      expect(system).toContain("Image understanding depends on whether the selected model supports it");
      expect(system).toContain("Your knowledge may not be current");
      if (protocol === "messages") {
        expect(typeof built.body.system).toBe("string");
      } else {
        const field = protocol === "responses" ? built.body.input : built.body.messages;
        expect(Array.isArray(field)).toBe(true);
        expect((field as readonly Record<string, unknown>[])[0]?.role).toBe("system");
      }
    }
  });

  test("unset suppresses only the built-in persona and preserves the explicit system prompt", () => {
    for (const protocol of ["chat", "responses", "messages"] as const) {
      const built = buildLabRequest(
        [{ role: "user", text: "hello" }],
        settings({ protocol, persona: "unset", systemPrompt: "Only use bullet points." }),
      );
      expect(systemText(built.body)).toBe("Only use bullet points.");
      if (protocol === "messages") {
        expect(built.body.system).toBe("Only use bullet points.");
      } else {
        const field = protocol === "responses" ? built.body.input : built.body.messages;
        expect((field as readonly Record<string, unknown>[])[0]?.role).toBe("system");
      }
    }
  });

  test("a blank sampling field is not sent as zero", () => {
    const built = buildLabRequest([{ role: "user", text: "hi" }], settings({ temperature: "  ", topP: "nope" }));
    expect(built.body.temperature).toBeUndefined();
    expect(built.body.top_p).toBeUndefined();
  });

  test("never adds web search tools to any protocol", () => {
    const turns = [{ role: "user" as const, text: "hi" }];
    for (const protocol of ["chat", "responses", "messages"] as const) {
      const built = buildLabRequest(turns, settings({ protocol }));
      expect(built.body.tools).toBeUndefined();
    }
  });

  test("an attached image is a wire image part, and a blank turn is kept", () => {
    const image = { name: "cat.png", dataUrl: "data:image/png;base64,Y2F0" };
    const chat = buildLabRequest([{ role: "user", text: "", images: [image] }], settings({ persona: "unset" }));
    expect(chat.body.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: image.dataUrl } }] },
    ]);
    const messages = buildLabRequest(
      [{ role: "user", text: "look", images: [image] }],
      settings({ protocol: "messages", persona: "unset" }),
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
    expect(textDelta("chat", "message", { choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }] })).toBe("answer");
    expect(textDelta("responses", "response.output_text.delta", { delta: "yo" })).toBe("yo");
    expect(textDelta("responses", "response.created", { delta: "yo" })).toBe("");
    expect(textDelta("messages", "content_block_delta", { delta: { text: "yo" } })).toBe("yo");
    expect(textDelta("chat", "message", { choices: [{ delta: { reasoning_content: "hmm" } }] })).toBe("");
    expect(reasoningDelta("chat", "message", { choices: [{ delta: { reasoning_content: "hmm" } }] })).toBe("hmm");
    expect(reasoningDelta("messages", "content_block_delta", { delta: { type: "thinking_delta", thinking: "hmm" } })).toBe("hmm");
    expect(reasoningDelta("responses", "response.reasoning_text.delta", { delta: "hmm" })).toBe("hmm");
  });

  test("emits thinking and answer deltas together before the stream closes", async () => {
    const encoder = new TextEncoder();
    const { promise: firstDelta, resolve: resolveFirstDelta } = Promise.withResolvers<void>();
    let closeStream: (() => void) | undefined;
    let answer = "";
    let thought = "";
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => controller.close();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"hmm","content":"hello"}}]}\n\n'));
      },
    }));
    const reading = readLabStream(
      response,
      "chat",
      (delta) => {
        answer += delta;
        resolveFirstDelta();
      },
      (delta) => {
        thought += delta;
      },
      () => {},
      () => {},
      new AbortController().signal,
    );

    await firstDelta;
    expect(answer).toBe("hello");
    expect(thought).toBe("hmm");
    closeStream?.();
    await reading;
  });

  test("flushes a complete final SSE frame when the stream ends without a blank line", async () => {
    const encoder = new TextEncoder();
    let answer = "";
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"last token"}}]}'));
        controller.close();
      },
    }));

    await readLabStream(
      response,
      "chat",
      (delta) => {
        answer += delta;
      },
      () => {},
      () => {},
      () => {},
      new AbortController().signal,
    );

    expect(answer).toBe("last token");
  });
});

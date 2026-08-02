import { describe, expect, test } from "bun:test";
import { translateChatRequestToGemini, translateGeminiResponseToChat } from "../../src/translate/google-gemini";
import { decodeGoogleGeminiStream } from "../../src/upstream/providers/google-gemini-handler";

const envelope = {
  project: "project-1",
  requestId: "agent/a/t/r/2",
  model: "gemini-3.1-pro",
  labels: { trajectory_id: "t", last_step_index: "1" },
  sessionId: "session-1",
};

describe("Gemini translation", () => {
  test("maps system, multimodal content, tools, and tool results", () => {
    const result = translateChatRequestToGemini({
      model: "gemini-3.1-pro",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Read this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call.1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"latest\"}" } }] },
        { role: "tool", tool_call_id: "call.1", content: "{\"ok\":true}" },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Look up data", parameters: { type: "object" } } }],
    }, envelope);

    expect(result.request.systemInstruction?.parts).toEqual([{ text: "Be concise." }]);
    expect(result.request.contents[0]?.parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
    expect(result.request.contents[1]?.parts[0]).toMatchObject({ functionCall: { id: "call_1", name: "lookup" } });
    expect(result.request.contents[2]?.parts[0]).toMatchObject({ functionResponse: { name: "call_1" } });
    expect(result.request.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("lookup");
  });

  test("maps a Gemini response to Chat Completions", () => {
    const result = translateGeminiResponseToChat({ responseId: "resp-1", candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }, "gemini-3.1-pro");
    expect(result).toMatchObject({ id: "resp-1", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  });
});

describe("Gemini stream handler", () => {
  test("emits thinking, text, tool, usage, and finish events", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"think","thought":true},{"text":"answer"},{"functionCall":{"id":"call-1","name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"thoughtsTokenCount":1}}}\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of decodeGoogleGeminiStream(body)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["thinking_delta", "text_delta", "tool_call_start", "tool_call_args_delta", "tool_call_end", "usage", "finish"]);
  });
});

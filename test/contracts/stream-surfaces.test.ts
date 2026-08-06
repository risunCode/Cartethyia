import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../../src/domain/contracts";
import { encodeSurfaceStream } from "../../src/providers/surfaces";

async function collectText(events: readonly StreamEvent[], surface: "openai-chat" | "openai-responses" | "anthropic-messages"): Promise<string> {
  const chunks: Uint8Array[] = [];
  async function* source(): AsyncGenerator<StreamEvent> {
    yield* events;
  }
  for await (const chunk of encodeSurfaceStream(surface, source(), "demo-model")) chunks.push(chunk);
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider" as const };

describe("surface stream encoding", () => {
  test("encodes OpenAI Chat text, tools, usage, and done", async () => {
    const output = await collectText([
      { type: "message_start", id: "chat-1" },
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", callId: "call-1", name: "lookup" },
      { type: "tool_call_delta", callId: "call-1", delta: "{\"q\":\"x\"}" },
      { type: "tool_call_end", callId: "call-1" },
      { type: "usage", usage },
      { type: "message_stop", reason: "tool_call" },
    ], "openai-chat");
    expect(output).toContain('"id":"chat-1"');
    expect(output).toContain('"content":"hello"');
    expect(output).toContain('"name":"lookup"');
    expect(output).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output).toContain("data: [DONE]");
  });

  test("encodes Anthropic message lifecycle and stream error", async () => {
    const output = await collectText([
      { type: "message_start", id: "msg-1" },
      { type: "text_delta", text: "partial" },
      { type: "message_stop", reason: "error" },
    ], "anthropic-messages");
    expect(output).toContain("event: message_start");
    expect(output).toContain('"id":"msg-1"');
    expect(output).toContain("event: error");
    expect(output).not.toContain('"stop_reason":"end_turn"');
  });

  test("encodes Responses completion and sequence numbers", async () => {
    const output = await collectText([
      { type: "message_start", id: "resp-1" },
      { type: "thinking_delta", text: "plan" },
      { type: "text_delta", text: "done" },
      { type: "usage", usage },
      { type: "message_stop", reason: "completed" },
    ], "openai-responses");
    expect(output).toContain("response.created");
    expect(output).toContain("response.reasoning_summary_text.delta");
    expect(output).toContain("response.output_text.delta");
    expect(output).toContain("response.completed");
    expect(output).toContain("data: [DONE]");
    expect(output).toMatch(/sequence_number":0/);
  });
});

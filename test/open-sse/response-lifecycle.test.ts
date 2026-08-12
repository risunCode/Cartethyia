import { describe, expect, test } from "bun:test";
import { encodeSurfaceStream } from "../../src/open-sse/transport/surface-encoder";
import type { StreamEvent } from "../../src/application/contracts";

async function collect(events: readonly StreamEvent[]): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of encodeSurfaceStream("openai-responses", (async function* () { yield* events; })(), "gpt-5")) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  return chunks.flatMap((chunk) => chunk.split("\n\n").filter(Boolean));
}

describe("OpenAI Responses response lifecycle", () => {
  test("emits complete message and tool output item lifecycles", async () => {
    const frames = await collect([
      { type: "message_start", id: "resp_fixture" },
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", callId: "call_read", name: "Read" },
      { type: "tool_call_delta", callId: "call_read", delta: "{}" },
      { type: "tool_call_end", callId: "call_read" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, source: "provider" } },
      { type: "message_stop", reason: "tool_call" },
    ]);
    const payloads = frames.filter((frame) => frame.startsWith("data: ") && !frame.endsWith("[DONE]"))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
    const types = payloads.map((payload) => payload.type);
    expect(types).toContain("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types).toContain("response.completed");
    expect(frames.at(-1)).toBe("data: [DONE]");

    const sequenceNumbers = payloads.map((payload) => payload.sequence_number).filter((value): value is number => typeof value === "number");
    expect(sequenceNumbers).toEqual([...sequenceNumbers].sort((left, right) => left - right));
    expect(new Set(sequenceNumbers).size).toBe(sequenceNumbers.length);
  });
});

import { describe, expect, test } from "bun:test";
import { encodeSurfaceStream } from "../../src/open-sse/transport/surface-encoder";
import { appendTerminalError } from "../../src/open-sse/handlers";
import type { StreamEvent } from "../../src/application/contracts";

async function collect(events: readonly StreamEvent[]): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of encodeSurfaceStream("anthropic-messages", (async function* () { yield* events; })(), "claude-sonnet")) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  return chunks.flatMap((chunk) => chunk.split("\n\n").filter(Boolean));
}

function dataFrames(frames: readonly string[]): Array<Record<string, unknown>> {
  return frames
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}") as Record<string, unknown>);
}

describe("Anthropic Messages response lifecycle", () => {
  test("nests thinking, text, tool, usage, compaction, and pause events", async () => {
    const frames = await collect([
      { type: "message_start", id: "msg_fixture" },
      { type: "thinking_delta", text: "plan" },
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", callId: "call_read", name: "Read" },
      { type: "tool_call_delta", callId: "call_read", delta: "{\"path\":\"a.ts\"}" },
      { type: "tool_call_end", callId: "call_read" },
      { type: "compaction_start" },
      { type: "compaction_delta", text: "summarizing" },
      { type: "compaction_stop" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3, source: "provider" } },
      { type: "message_stop", reason: "pause_turn" },
    ]);
    const payloads = dataFrames(frames);
    const types = payloads.map((payload) => payload.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    const terminalDelta = payloads.findLast((payload) => payload.type === "message_delta");
    expect((terminalDelta?.delta as Record<string, unknown>)?.stop_reason).toBe("pause_turn");
    expect(frames.filter((frame) => frame.startsWith("event: message_stop")).length).toBe(1);
  });


  test("uses one terminal error event for an interrupted stream", async () => {
    const frames = await collect([
      { type: "message_start", id: "msg_error" },
      { type: "text_delta", text: "partial" },
      { type: "message_stop", reason: "error", error: { statusCode: 504, kind: "stream_timeout", message: "provider timed out", retryAt: null } },
    ]);
    const errorFrames = frames.filter((frame) => frame.startsWith("event: error"));
    expect(errorFrames).toHaveLength(1);
    expect(frames.filter((frame) => frame.startsWith("event: message_stop"))).toHaveLength(0);
    expect(errorFrames[0]).not.toContain("authorization");
    expect(errorFrames[0]).not.toContain("raw");
  });
  test("surfaces structured terminal errors from a broken upstream stream", async () => {
    const events = appendTerminalError((async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", id: "msg_structured_error" };
      yield { type: "text_delta", text: "partial" };
      throw { error: { message: "upstream connection reset" } };
    })());
    const frames: string[] = [];
    for await (const chunk of encodeSurfaceStream("anthropic-messages", events, "claude-opus-5")) {
      frames.push(new TextDecoder().decode(chunk));
    }
    const errorFrame = frames.find((frame) => frame.startsWith("event: error"));
    expect(errorFrame).toContain("upstream connection reset");
    expect(errorFrame).not.toContain("no error detail");
  });
});

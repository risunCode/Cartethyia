import { describe, expect, test } from "bun:test";
import { decodeCommandCodeNdjsonStream } from "../../../../src/upstream/providers/commandcode/transport";
import { ProviderCallError } from "../../../../src/upstream/providers/index";

function bodyFrom(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

async function collectEvents(body: ReadableStream<Uint8Array>) {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const ev of decodeCommandCodeNdjsonStream(body)) {
    events.push(ev);
  }
  return events;
}

describe("decodeCommandCodeNdjsonStream", () => {
  test("decodes a simple text-delta stream", async () => {
    const events = await collectEvents(bodyFrom([
      '{"type":"text-delta","text":"hello"}\n',
      '{"type":"text-delta","text":" world"}\n',
      '{"type":"finish","finishReason":"stop"}\n',
    ]));

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text_delta", text: "hello" });
    expect(events[1]).toEqual({ type: "text_delta", text: " world" });
    expect(events[2]).toEqual({ type: "finish", stopReason: "end_turn" });
  });

  test("decodes tool-input events into tool_call deltas", async () => {
    const events = await collectEvents(bodyFrom([
      '{"type":"tool-input-start","id":"call_1","toolName":"get_weather"}\n',
      '{"type":"tool-input-delta","id":"call_1","delta":"{\\"city\\": \\""}\n',
      '{"type":"tool-input-delta","id":"call_1","delta":"Paris"}\n',
      '{"type":"tool-input-delta","id":"call_1","delta":"\\"}"}\n',
      '{"type":"finish","finishReason":"tool_calls"}\n',
    ]));

    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_1", name: "get_weather" });
    expect(events[1]).toEqual({ type: "tool_call_args_delta", id: "call_1", argumentsDelta: '{"city": "' });
    expect(events[2]).toEqual({ type: "tool_call_args_delta", id: "call_1", argumentsDelta: "Paris" });
    expect(events[3]).toEqual({ type: "tool_call_args_delta", id: "call_1", argumentsDelta: '\"}' });
    expect(events[events.length - 1]).toEqual({ type: "finish", stopReason: "tool_use" });
  });

  test("decodes a consolidated tool-call event", async () => {
    const events = await collectEvents(bodyFrom([
      '{"type":"tool-call","toolCallId":"call_2","toolName":"search","input":"{\\"q\\":\\"x\\"}"}\n',
      '{"type":"finish","finishReason":"stop"}\n',
    ]));

    expect(events[0]).toEqual({ type: "tool_call_start", id: "call_2", name: "search" });
    expect(events[1]).toEqual({ type: "tool_call_args_delta", id: "call_2", argumentsDelta: '{"q":"x"}' });
    expect(events[2]).toEqual({ type: "finish", stopReason: "end_turn" });
  });

  test("emits usage from finish-step state", async () => {
    const events = await collectEvents(bodyFrom([
      '{"type":"text-delta","text":"ok"}\n',
      '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":5,"cacheWriteTokens":1}}\n',
      '{"type":"finish","finishReason":"stop"}\n',
    ]));

    expect(events[events.length - 2]).toEqual({ type: "finish", stopReason: "end_turn" });
    expect(events[events.length - 1]).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
    });
  });

  test("handles arbitrary chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const payload = '{"type":"text-delta","text":"split"}\n{"type":"finish","finishReason":"stop"}\n';
    const chunks = [payload.slice(0, 7), payload.slice(7, 18), payload.slice(18)];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    const events = await collectEvents(body);
    expect(events[0]).toEqual({ type: "text_delta", text: "split" });
    expect(events[1]).toEqual({ type: "finish", stopReason: "end_turn" });
  });

  test("throws a sanitized error for upstream error events", async () => {
    const body = bodyFrom(['{"type":"error","error":"model unavailable"}\n']);
    await expect(collectEvents(body)).rejects.toThrow(ProviderCallError);
  });
});

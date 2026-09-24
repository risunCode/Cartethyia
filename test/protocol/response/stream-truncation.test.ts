import { describe, expect, test } from "bun:test";
import { decodeChatSseStream } from "../../../src/protocol/response/chat";
import { CodexStreamFrameProcessor } from "../../../src/protocol/response/codex";
import { parseClaudeSseStream } from "../../../src/protocol/response/messages";
import { decodeResponsesSseStream } from "../../../src/protocol/response/responses";
import { MessagesStreamEncoder } from "../../../src/transport/surface/messages/stream";
import { CompletionStreamEncoder } from "../../../src/transport/surface/completion";
import { ResponsesEventEncoder } from "../../../src/transport/surface/responses/encode";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import { collect, streamOf } from "../../helpers/sse-fixtures";



function fakeRequest(): CanonicalRequest {
  return { model: "test-model" } as CanonicalRequest;
}


function terminalOf(events: CanonicalEvent[]): Extract<CanonicalEvent, { type: "terminal" }> {
  const terminal = events.find((event) => event.type === "terminal");
  if (terminal?.type !== "terminal") throw new Error("expected a terminal event");
  return terminal;
}

const CHAT_TRUNCATED =
  `data: {"choices":[{"delta":{"content":"hel"},"finish_reason":null}]}\n\n` +
  `data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n`;

const CHAT_COMPLETE =
  CHAT_TRUNCATED +
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n` +
  `data: [DONE]\n\n`;

const RESPONSES_TRUNCATED =
  `data: {"type":"response.output_text.delta","delta":"hel"}\n\n` +
  `data: {"type":"response.output_text.delta","delta":"lo"}\n\n`;

const RESPONSES_COMPLETE =
  RESPONSES_TRUNCATED +
  `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n` +
  `data: [DONE]\n\n`;

const CLAUDE_COMPLETE =
  `data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n` +
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
  `data: {"type":"content_block_stop","index":0}\n\n` +
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n` +
  `data: {"type":"message_stop"}\n\n`;

describe("truncated streams never report complete", () => {
  test("chat: deltas then EOF without finish_reason yields failed", async () => {
    const events = await collect(decodeChatSseStream(streamOf(CHAT_TRUNCATED), fakeRequest()));
    expect(events.some((event) => event.type === "content_delta")).toBe(true);
    expect(terminalOf(events).state).toBe("failed");
  });

  test("chat: finish_reason still yields complete", async () => {
    const events = await collect(decodeChatSseStream(streamOf(CHAT_COMPLETE), fakeRequest()));
    const terminal = terminalOf(events);
    expect(terminal.state).toBe("complete");
    expect(terminal.stop_reason).toBe("stop");
  });

  test("responses: deltas then EOF without terminal envelope yields failed", async () => {
    const events = await collect(decodeResponsesSseStream(streamOf(RESPONSES_TRUNCATED), fakeRequest()));
    expect(events.some((event) => event.type === "content_delta")).toBe(true);
    expect(terminalOf(events).state).toBe("failed");
  });

  test("responses: response.completed still yields complete", async () => {
    const events = await collect(decodeResponsesSseStream(streamOf(RESPONSES_COMPLETE), fakeRequest()));
    expect(terminalOf(events).state).toBe("complete");
  });

  test("codex processor: deltas without terminal frame yields failed", () => {
    const processor = new CodexStreamFrameProcessor(2);
    processor.process({ delta: "hi" } as Record<string, unknown>);
    const terminal = processor.terminalEvent();
    expect(terminal.type).toBe("terminal");
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.state).toBe("failed");
  });

  test("codex processor: response.completed still yields complete", () => {
    const processor = new CodexStreamFrameProcessor(2);
    processor.process({ type: "response.completed" } as Record<string, unknown>);
    const terminal = processor.terminalEvent();
    if (terminal.type !== "terminal") throw new Error("unreachable");
    expect(terminal.state).toBe("complete");
  });
});

describe("[DONE] terminates every decoder without waiting for close", () => {
  test("trailing-space [DONE] terminates cleanly on every wire", async () => {
    const withTrailingSpace = (body: string): string => body.replaceAll("data: [DONE]", "data: [DONE] ");
    const chat = await collect(decodeChatSseStream(streamOf(withTrailingSpace(CHAT_COMPLETE)), fakeRequest()));
    expect(terminalOf(chat).state).toBe("complete");
    const responses = await collect(
      decodeResponsesSseStream(streamOf(withTrailingSpace(RESPONSES_COMPLETE)), fakeRequest()),
    );
    expect(terminalOf(responses).state).toBe("complete");
    const claude = await collect(parseClaudeSseStream(streamOf(`${CLAUDE_COMPLETE}data: [DONE] \n\n`)));
    expect(terminalOf(claude).state).toBe("complete");
  });

  test("responses: frames after [DONE] are ignored, pre-[DONE] terminal wins", async () => {
    const body =
      `data: {"type":"response.output_text.delta","delta":"hi"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n` +
      `data: [DONE]\n\n` +
      `data: {"type":"response.completed","response":{"status":"failed","usage":{"input_tokens":99,"output_tokens":99}}}\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const terminal = terminalOf(events);
    expect(terminal.state).toBe("complete");
    expect(terminal.usage).toMatchObject({ input_tokens: 3, output_tokens: 2 });
  });
});

describe("split usage frames merge instead of overwrite", () => {
  test("chat: prompt-tokens frame plus completion-tokens frame keeps both", async () => {
    const body =
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":4}}}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":5,"total_tokens":15}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeChatSseStream(streamOf(body), fakeRequest()));
    const terminal = terminalOf(events);
    expect(terminal.state).toBe("complete");
    expect(terminal.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(terminal.usage).toMatchObject({ cached_input_tokens: 4 });
  });
});

describe("empty placeholder deltas never become content", () => {
  // Bridges emit `""` deltas between real chunks. Forwarding them as content
  // made downstream encoders open a block per event, fragmenting one answer
  // into alternating text/thinking blocks.
  test("chat: empty content and reasoning deltas are dropped", async () => {
    const body =
      `data: {"choices":[{"delta":{"content":"P"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"reasoning_content":""},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"ONG"},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(decodeChatSseStream(streamOf(body), fakeRequest()));
    const parts = events.filter((event) => event.type === "content_delta");
    expect(parts.map((part) => part.content)).toEqual([
      { kind: "text", text: "P" },
      { kind: "text", text: "ONG" },
    ]);
  });

  test("responses: empty output_text and reasoning deltas are dropped", async () => {
    const body =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n` +
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":""}\n\n` +
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PONG"}\n\n` +
      `event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":""}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\n`;
    const events = await collect(decodeResponsesSseStream(streamOf(body), fakeRequest()));
    const parts = events.filter((event) => event.type === "content_delta");
    expect(parts.map((part) => part.content)).toEqual([{ kind: "text", text: "PONG" }]);
  });

  test("messages: empty text and thinking deltas are dropped", async () => {
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":""}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const events = await collect(parseClaudeSseStream(streamOf(body)));
    const parts = events.filter((event) => event.type === "content_delta");
    expect(parts.map((part) => part.content)).toEqual([{ kind: "text", text: "PONG" }]);
  });

  test("messages: an answer with empty interleaved deltas stays one text block", async () => {
    const streamEncoder = new MessagesStreamEncoder({ model: "test-model" });
    const wire: Array<{ type?: string; index?: number }> = [];
    for (const part of ["P", "", "ONG"]) {
      for (const event of streamEncoder.push({
        type: "content_delta",
        sequence_number: 1,
        content: { kind: "text", text: part },
      } as CanonicalEvent))
        wire.push(event as { type?: string; index?: number });
    }
    for (const event of streamEncoder.push({
      type: "terminal",
      sequence_number: 2,
      state: "complete",
    } as CanonicalEvent))
      wire.push(event as { type?: string; index?: number });
    // Exactly one block open/close pair, and only the non-empty deltas.
    expect(wire.filter((event) => event.type === "content_block_start")).toHaveLength(1);
    expect(wire.filter((event) => event.type === "content_block_stop")).toHaveLength(1);
    expect(wire.filter((event) => event.type === "content_block_delta")).toHaveLength(2);
  });
});

describe("stream identity is stable for the whole response", () => {
  test("completion: every chunk carries the same id and created timestamp", async () => {
    const encoder = new CompletionStreamEncoder({ model: "test-model" });
    const frames: Array<Record<string, unknown>> = [];
    for (const text of ["P", "ONG"]) {
      for (const frame of encoder.push({
        type: "content_delta",
        sequence_number: 1,
        content: { kind: "text", text },
      } as CanonicalEvent))
        frames.push(frame);
    }
    for (const frame of encoder.push({
      type: "terminal",
      sequence_number: 2,
      state: "complete",
    } as CanonicalEvent))
      frames.push(frame);
    expect(frames.length).toBeGreaterThan(1);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(1);
    expect(new Set(frames.map((frame) => frame.created)).size).toBe(1);
  });

  test("responses: response.created and response.completed share one id", async () => {
    const encoder = new ResponsesEventEncoder({ model: "test-model" });
    const frames: Array<Record<string, unknown>> = [];
    const push = (event: CanonicalEvent): void => {
      for (const frame of encoder.push(event)) frames.push(frame as Record<string, unknown>);
    };
    push({ type: "response_start", sequence_number: 1, model: "test-model" } as CanonicalEvent);
    push({
      type: "content_delta",
      sequence_number: 2,
      content: { kind: "text", text: "PONG" },
    } as CanonicalEvent);
    push({ type: "terminal", sequence_number: 3, state: "complete" } as CanonicalEvent);
    const ids = frames
      .map((frame) => (frame.response as Record<string, unknown> | undefined)?.id)
      .filter((id): id is string => typeof id === "string");
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(1);
  });
});

describe("messages tool_use placeholder input never corrupts arguments", () => {
  test("content_block_start input:{} is a placeholder, not an argument fragment", async () => {
    // Anthropic's own wire format: `input: {}` on content_block_start, then
    // the real arguments as input_json_delta fragments. Forwarding the
    // placeholder produced `{}{"city": "Jakarta"}` — invalid JSON — so a
    // replayed tool call could never be parsed.
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\": \\"Jakarta\\"}"}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const events = await collect(parseClaudeSseStream(streamOf(body)));
    const args = events
      .filter((event) => event.type === "tool_call_delta")
      .map((event) => event.arguments_delta)
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Jakarta" });
  });

  test("a bridge that sends complete input on content_block_start still forwards it", async () => {
    const body =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Jakarta"}}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const events = await collect(parseClaudeSseStream(streamOf(body)));
    const args = events
      .filter((event) => event.type === "tool_call_delta")
      .map((event) => event.arguments_delta)
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Jakarta" });
  });
});

describe("messages encoder error handling", () => {
  test("error event followed by terminal closes exactly once with no post-stop frame", () => {
    const wireEvents: unknown[] = [];
    const streamEncoder = new MessagesStreamEncoder({ model: "test-model" });
    const push = (event: CanonicalEvent): void => {
      for (const wire of streamEncoder.push(event)) wireEvents.push(wire);
    };
    push({ type: "response_start", sequence_number: 1, model: "test-model" } as CanonicalEvent);
    push({
      type: "content_delta",
      sequence_number: 2,
      content: { kind: "text", text: "partial" },
    } as CanonicalEvent);
    // Must not throw (previously: terminal push threw "more than one
    // terminal event" and the client received an error frame after
    // message_stop, which Anthropic never sends).
    push({ type: "error", sequence_number: 3, category: "upstream", message: "boom" } as unknown as CanonicalEvent);
    push({ type: "terminal", sequence_number: 4, state: "failed" } as CanonicalEvent);
    const stops = wireEvents.filter(
      (wire) => (wire as { type?: string }).type === "message_stop",
    );
    expect(stops).toHaveLength(1);
    expect((wireEvents.at(-1) as { type?: string }).type).toBe("message_stop");
    expect(
      wireEvents.some((wire) => (wire as { type?: string }).type === "error"),
    ).toBe(false);
  });
});

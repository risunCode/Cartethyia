import { describe, expect, test } from "bun:test";
import { decodeChatSseStream } from "../../../src/protocol/response/chat";
import { decodeResponsesSseStream } from "../../../src/protocol/response/responses";
import { parseClaudeSseStream } from "../../../src/protocol/response/messages";
import { parseChatResponseToEvents } from "../../../src/protocol/response/chat";
import { parseResponsesResponseToEvents } from "../../../src/protocol/response/responses";
import { usageFromProvider } from "../../../src/providers/usage";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import { collect, streamOf } from "../../helpers/sse-fixtures";

/**
 * A provider that reports no usage is *unmeasured*, not a measured zero.
 *
 * The terminal event is the only carrier of a turn's real token count into
 * `completeAttempt`, which commits it against the API key's daily, monthly and
 * lifetime budgets. When a decoder turned a missing (or empty) usage frame into
 * a record of zeros, `terminal.usage ?? estimatedUsage(...)` never fell
 * through — a zero record is not `undefined` — so every turn reconciled to
 * zero and refunded its whole reservation. A key with a one-time (lifetime)
 * budget could therefore be replayed forever: the counter never grew.
 *
 * These tests pin the absence, which is what makes the dispatch fallback to
 * the conservative estimate reachable.
 */

function fakeRequest(): CanonicalRequest {
  return { model: "test-model" } as CanonicalRequest;
}

function terminalOf(events: readonly CanonicalEvent[]): Extract<CanonicalEvent, { type: "terminal" }> {
  const terminal = events.find((event) => event.type === "terminal");
  if (terminal?.type !== "terminal") throw new Error("expected a terminal event");
  return terminal;
}

describe("unreported provider usage stays absent", () => {
  test("usageFromProvider treats a missing payload as unmeasured", () => {
    expect(usageFromProvider(undefined)).toBeUndefined();
    expect(usageFromProvider(null)).toBeUndefined();
    expect(usageFromProvider("not an object")).toBeUndefined();
  });

  test("usageFromProvider treats an empty object as unmeasured", () => {
    // `usage: {}` is the shape bridges emit when they simply omit the counts.
    expect(usageFromProvider({})).toBeUndefined();
  });

  test("usageFromProvider treats an all-zero payload as unmeasured", () => {
    // An all-zero record is indistinguishable from a missing one: no real
    // request has zero prompt tokens, so the only way to reach this shape is a
    // bridge that dropped the counts. The budget must fail closed (charge the
    // conservative estimate) rather than refund the whole reservation, which is
    // exactly the bypass this suite exists for.
    expect(usageFromProvider({ prompt_tokens: 0, completion_tokens: 0 })).toBeUndefined();
  });

  test("usageFromProvider preserves a reported count", () => {
    const usage = usageFromProvider({ prompt_tokens: 12, completion_tokens: 3 });
    expect(usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
  });

  test("chat stream without a usage frame yields a terminal with no usage", async () => {
    const body =
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;
    const terminal = terminalOf(await collect(decodeChatSseStream(streamOf(body), fakeRequest())));
    expect(terminal.usage).toBeUndefined();
  });

  test("chat stream with a usage frame still carries it", async () => {
    const body =
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n` +
      `data: [DONE]\n\n`;
    const terminal = terminalOf(await collect(decodeChatSseStream(streamOf(body), fakeRequest())));
    expect(terminal.usage).toMatchObject({ input_tokens: 10, output_tokens: 4 });
  });

  test("responses stream without a usage frame yields a terminal with no usage", async () => {
    const body =
      `data: {"type":"response.output_text.delta","delta":"hi"}\n\n` +
      `data: {"type":"response.completed","response":{"status":"completed"}}\n\n` +
      `data: [DONE]\n\n`;
    const terminal = terminalOf(
      await collect(decodeResponsesSseStream(streamOf(body), fakeRequest())),
    );
    expect(terminal.usage).toBeUndefined();
  });

  test("responses stream with an empty usage envelope yields no usage", async () => {
    const body =
      `data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n` +
      `data: [DONE]\n\n`;
    const terminal = terminalOf(
      await collect(decodeResponsesSseStream(streamOf(body), fakeRequest())),
    );
    expect(terminal.usage).toBeUndefined();
  });

  test("non-stream chat body without usage yields a terminal with no usage", () => {
    const events = parseChatResponseToEvents(
      { id: "x", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] },
      fakeRequest(),
    );
    expect(terminalOf(events).usage).toBeUndefined();
  });

  test("non-stream responses body with an empty usage object yields no usage", () => {
    const events = parseResponsesResponseToEvents(
      { id: "x", status: "completed", usage: {}, output: [] },
      fakeRequest(),
    );
    expect(terminalOf(events).usage).toBeUndefined();
  });

  test("Claude messages stream without usage yields a terminal with no usage", async () => {
    const body =
      `data: {"type":"message_start","message":{"id":"msg_1"}}\n\n` +
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      `data: {"type":"content_block_stop","index":0}\n\n` +
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
      `data: {"type":"message_stop"}\n\n`;
    const terminal = terminalOf(await collect(parseClaudeSseStream(streamOf(body))));
    expect(terminal.usage).toBeUndefined();
  });
});

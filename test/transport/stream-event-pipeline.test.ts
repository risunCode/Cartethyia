import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../../src/protocol/canonical-model";
import { StreamEventPipeline } from "../../src/transport/dispatch/streaming/encoder";

const EVENT_COUNT = 1_200;
const EVENT_TEXT_LENGTH = 1_024;
const USAGE = {
  input_tokens: 3,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  uncached_input_tokens: 3,
  output_tokens: 2,
  reasoning_tokens: 0,
  estimated_cost: 0,
} as const;

function contentEvent(sequenceNumber: number): CanonicalEvent {
  return {
    type: "content_delta",
    sequence_number: sequenceNumber,
    content: { kind: "text", text: `event-${sequenceNumber}-${"x".repeat(EVENT_TEXT_LENGTH)}` },
  };
}

describe("stream event telemetry transcript", () => {
  test("bounds diagnostic memory but preserves complete client output and terminal accounting", async () => {
    const pipeline = new StreamEventPipeline("chat", { created: 1, include_usage: false }, false);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sequenceNumber = 0; sequenceNumber < EVENT_COUNT; sequenceNumber += 1) {
          pipeline.enqueueEvent(contentEvent(sequenceNumber), controller);
        }
        pipeline.enqueueEvent(
          {
            type: "terminal",
            sequence_number: EVENT_COUNT,
            state: "complete",
            stop_reason: "stop",
            usage: USAGE,
          },
          controller,
        );
        pipeline.finishEncoders(controller);
        controller.close();
      },
    });
    const clientBody = await new Response(stream).text();
    const transcript = pipeline.telemetryEventTranscript;

    expect(pipeline.eventCount).toBe(EVENT_COUNT + 1);
    expect(clientBody).toContain("event-0-");
    expect(clientBody).toContain(`event-${EVENT_COUNT - 1}-`);
    expect(clientBody).toContain("[DONE]");
    expect(pipeline.terminal?.state).toBe("complete");
    expect(pipeline.usage).toEqual(USAGE);
    expect(Array.isArray(transcript)).toBe(false);
    if ("_truncated" in transcript) {
      expect(transcript._truncated).toBe(true);
      expect(transcript._omitted_events).toBeGreaterThan(0);
      expect(transcript.events[0]?.sequence_number).toBe(0);
      expect(transcript.events[transcript.events.length - 1]?.sequence_number).toBe(EVENT_COUNT - 1);
      expect(transcript.terminal?.state).toBe("complete");
      expect(transcript.terminal?.usage).toEqual(USAGE);
      expect(transcript.usage).toEqual(USAGE);
      expect(Buffer.byteLength(JSON.stringify(transcript), "utf8")).toBeLessThan(520 * 1024);
    }
  });
});
import { describe, expect, test } from "bun:test";
import { decodeKiroStream } from "../../src/providers/kiro";
import { AbortCoordinator, ProviderAdapterError } from "../../src/providers/shared";
import type { StreamEvent } from "../../src/domain/contracts";

/** Builds a ReadableStream from a list of byte chunks. */
function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drainEvents(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("decodeKiroStream — buffer cap", () => {
  test("throws stream_truncated when the accumulated buffer exceeds 1 MiB", async () => {
    // Send a single chunk larger than the 1 MiB cap. The decoder accumulates
    // it into the buffer before attempting to parse frames, so the cap fires.
    const oversized = new Uint8Array(1_048_577);
    const body = byteStream([oversized]);
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const error = await drainEvents(decodeKiroStream(body, coordinator)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).kind).toBe("stream_truncated");
  });

  test("does not throw for a buffer under the cap", async () => {
    // An empty-but-valid stream (EOF immediately) should not trip the cap.
    const body = byteStream([]);
    const coordinator = new AbortCoordinator(new AbortController().signal);
    const events = await drainEvents(decodeKiroStream(body, coordinator));
    // EOF without a terminal event synthesizes a message_stop.
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  });
});

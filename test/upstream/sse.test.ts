import { describe, expect, test } from "bun:test";
import { formatSSEFrame, parseSSEStream, sseDataOnly, toSSEResponseStream, SSE_DONE } from "../../src/upstream/sse";
import type { SSEFrame } from "../../src/upstream/sse";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe("sse concern — parseSSEStream", () => {
  test("parses a single event+data frame", async () => {
    const frames = await collect(parseSSEStream(streamOf("event: message_start\ndata: {\"a\":1}\n\n")));
    expect(frames).toEqual([{ event: "message_start", data: '{"a":1}' }]);
  });

  test("parses a data-only frame (no event line)", async () => {
    const frames = await collect(parseSSEStream(streamOf('data: {"a":1}\n\n')));
    expect(frames).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  test("parses multiple frames from one chunk", async () => {
    const frames = await collect(parseSSEStream(streamOf('data: 1\n\ndata: 2\n\ndata: 3\n\n')));
    expect(frames.map((f) => f.data)).toEqual(["1", "2", "3"]);
  });

  test("joins multi-line data fields with newlines", async () => {
    const frames = await collect(parseSSEStream(streamOf("data: line1\ndata: line2\n\n")));
    expect(frames).toEqual([{ event: undefined, data: "line1\nline2" }]);
  });

  test("reassembles a frame split across multiple stream chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"par'));
        controller.enqueue(encoder.encode('tial":true}\n'));
        controller.enqueue(encoder.encode("\n"));
        controller.close();
      },
    });
    const frames = await collect(parseSSEStream(stream));
    expect(frames).toEqual([{ event: undefined, data: '{"partial":true}' }]);
  });

  test("ignores a frame with no data lines (e.g. a bare comment/ping)", async () => {
    const frames = await collect(parseSSEStream(streamOf(": ping\n\ndata: real\n\n")));
    expect(frames).toEqual([{ event: undefined, data: "real" }]);
  });

  test("cancels the upstream reader when downstream stops consuming", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const frames = parseSSEStream(stream);

    await frames.next();
    await frames.return(undefined);

    expect(cancelled).toBeTrue();
  });

  test("fails when an upstream stream stalls after emitting data", async () => {
    const previousTimeout = process.env.STREAM_STALL_TIMEOUT_MS;
    process.env.STREAM_STALL_TIMEOUT_MS = "10";
    const encoder = new TextEncoder();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
      },
    });

    try {
      await expect(collect(parseSSEStream(stalled))).rejects.toThrow("stream stalled");
    } finally {
      if (previousTimeout === undefined) delete process.env.STREAM_STALL_TIMEOUT_MS;
      else process.env.STREAM_STALL_TIMEOUT_MS = previousTimeout;
    }
  });

  test("empty stream yields no frames", async () => {
    const frames = await collect(parseSSEStream(streamOf("")));
    expect(frames).toEqual([]);
  });
});

describe("sse concern — formatSSEFrame / sseDataOnly", () => {
  test("formatSSEFrame includes the event line when present", () => {
    expect(formatSSEFrame({ event: "message_stop", data: "{}" })).toBe("event: message_stop\ndata: {}\n\n");
  });

  test("formatSSEFrame omits the event line when absent", () => {
    expect(formatSSEFrame({ data: "{}" })).toBe("data: {}\n\n");
  });

  test("sseDataOnly JSON-encodes the payload with no event line", () => {
    expect(sseDataOnly({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  test("format → parse round-trips a frame", async () => {
    const formatted = formatSSEFrame({ event: "x", data: '{"y":2}' });
    const frames = await collect(parseSSEStream(streamOf(formatted)));
    expect(frames).toEqual([{ event: "x", data: '{"y":2}' } satisfies SSEFrame]);
  });
});

describe("sse concern — toSSEResponseStream", () => {
  async function* gen(frames: string[]): AsyncGenerator<string> {
    for (const f of frames) yield f;
  }

  test("encodes each yielded string to UTF-8 bytes in order", async () => {
    const stream = toSSEResponseStream(gen(["data: 1\n\n", "data: 2\n\n", SSE_DONE]));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    expect(out).toBe("data: 1\n\ndata: 2\n\ndata: [DONE]\n\n");
  });

  test("does not pull an unbounded number of source frames while the consumer is slow", async () => {
    let nextCalls = 0;
    async function* counted(): AsyncGenerator<string> {
      for (;;) {
        nextCalls++;
        yield `data: ${nextCalls}\\n\\n`;
      }
    }
    const stream = toSSEResponseStream(counted());
    const reader = stream.getReader();

    await reader.read();
    await Promise.resolve();
    await Promise.resolve();
    expect(nextCalls).toBeLessThanOrEqual(2);

    await reader.read();
    await Promise.resolve();
    await Promise.resolve();
    expect(nextCalls).toBeLessThanOrEqual(3);
    await reader.cancel();
  });

  test("cancelling the response stream returns the source generator (stops pulling)", async () => {
    let returned = false;
    async function* infinite(): AsyncGenerator<string> {
      try {
        let i = 0;
        for (;;) yield `data: ${i++}\n\n`;
      } finally {
        returned = true;
      }
    }
    const stream = toSSEResponseStream(infinite());
    // Pull once first — a generator's `finally` only runs once its body has
    // actually started executing (i.e. after at least one `next()`/pull).
    const reader = stream.getReader();
    await reader.read();
    reader.releaseLock();
    await stream.cancel();
    expect(returned).toBe(true);
  });
});

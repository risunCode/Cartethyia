import { describe, expect, test } from "bun:test";
import { decodeSseEvents, type SseDecodeOptions } from "../../src/transport/streaming";
import { GatewayError } from "../../src/transport/gateway-error";

/** One readable stream from an explicit list of byte-boundary chunks. */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Drains any async iterable into an array. */
async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/**
 * Decodes a chunked SSE body under explicit bounds, returning the events. This
 * is the stream-plus-options entry point; `collect` drains an already-decoded
 * iterable, which is a different fixture shape.
 */
async function decodeSse(body: ReadableStream<Uint8Array> | null, opts?: SseDecodeOptions) {
  const events = [];
  for await (const event of decodeSseEvents(body, opts)) events.push(event);
  return events;
}

describe("decodeSseEvents large frames and size bounds", () => {
  test("decodes a legitimately large single-line JSON data frame (Responses response.created shape)", async () => {
    // Real upstream Responses providers pack the entire tool schema — every
    // tool description included — into ONE data: line on `response.created`.
    // A client with a dozen richly-documented tools easily exceeds 64 KiB on
    // that single line. The decoder MUST accept it.
    const bigDescription = "x".repeat(200_000);
    const payload = JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_1",
        tools: [{ type: "function", name: "read", description: bigDescription }],
      },
    });
    const events = (await collect(
      decodeSseEvents(streamOf([`data: ${payload}\n\n`, "data: [DONE]\n\n"])),
    )) as Array<{ event: string | null; data: string }>;
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe(payload);
    expect(events[1]?.data).toBe("[DONE]");
  });
  test("still enforces per-event size cap across multi-line data accumulation", async () => {
    // Split the payload across many short data: lines so the per-line guard
    // does not trip; the per-event accumulator MUST still reject once total
    // event bytes exceed the cap. This is the real DoS boundary.
    const shortLine = "y".repeat(64);
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(`data: ${shortLine}\n`);
    lines.push("\n");
    let caught: unknown;
    try {
      await collect(
        decodeSseEvents(streamOf(lines), { maxEventBytes: 1024, maxLineBytes: 512 }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).message).toBe("SSE event exceeds size bound");
  });
});

describe("decodeSseEvents chunked decoding", () => {
  test("decodes data-only events split across chunks", async () => {
    const events = await decodeSse(streamOf(['data: {"a":', "1}\n\ndata: [DONE]\n\n"]));
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: "[DONE]" },
    ]);
  });

  test("preserves event names and joins multi-line data", async () => {
    const events = await decodeSse(streamOf(['event: error\ndata: {"x": 1}\ndata: cont\n\n']));
    expect(events).toEqual([{ event: "error", data: '{"x": 1}\ncont' }]);
  });

  test("ignores comments, ids, and blank dispatches", async () => {
    const events = await decodeSse(streamOf([": keepalive\n\nid: 7\nretry: 100\n\nevent: ping\n\n"]));
    expect(events).toEqual([]);
  });

  test("throws on malformed lines instead of skipping them", async () => {
    await expect(decodeSse(streamOf(["garbage-line\n\n"]))).rejects.toMatchObject({
      code: "platform_unavailable",
      origin: "upstream",
    });
  });

  test("bounds runaway lines and events", async () => {
    // Explicit small bounds prove the mechanism deterministically without
    // allocating multi-MiB fixtures; the 4 MiB defaults are covered in
    // streaming.test.ts (large single-line + per-event accumulation).
    await expect(
      decodeSse(streamOf([`data: ${"x".repeat(1024)}\n\n`]), { maxLineBytes: 512 }),
    ).rejects.toMatchObject({ code: "platform_unavailable", origin: "upstream" });

    const wide: string[] = [];
    for (let i = 0; i < 20; i++) wide.push(`data: ${"y".repeat(64)}\n`);
    wide.push("\n");
    await expect(
      decodeSse(streamOf(wide), { maxEventBytes: 512 }),
    ).rejects.toMatchObject({ code: "platform_unavailable", origin: "upstream" });
  });

  test("stops promptly on abort and rejects null bodies", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodeSse(streamOf(["data: 1\n\n"]), { signal: controller.signal }),
    ).resolves.toEqual([]);
    await expect(decodeSse(null)).rejects.toMatchObject({
      code: "platform_unavailable",
      origin: "upstream",
    });
  });

  test("dispatches a trailing event at EOF without a blank line", async () => {
    const events = await decodeSse(streamOf(['data: {"a":1}\n\n', 'data: {"b":2}']));
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"b":2}' },
    ]);
  });

  test("reassembles splits inside event:/data: prefixes", async () => {
    const events = await decodeSse(streamOf(["event: er", "ror\nda", "ta: {\"x\": 1}\n\n"]));
    expect(events).toEqual([{ event: "error", data: '{"x": 1}' }]);
  });
});

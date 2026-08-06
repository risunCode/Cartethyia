import { describe, expect, test } from "bun:test";
import {
  AbortCoordinator,
  ProviderAdapterError,
  decodeSseEvents,
  parseRetryAfterSeconds,
  readUpstreamError,
} from "../../src/providers/shared";

function streamBody(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

describe("upstream error body hardening", () => {
  test("recover multi-byte UTF-8 split across chunks when reading an error body", async () => {
    const bytes = new TextEncoder().encode('{"error":{"message":"café"}}');
    // Split inside the "é" (2-byte UTF-8 sequence) so the decoder must carry
    // the lead byte across the chunk boundary.
    const splitAt = bytes.indexOf(0xc3);
    const response = new Response(streamBody([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]), { status: 429 });
    const error = await readUpstreamError(response).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect((error as ProviderAdapterError).toProviderCallError().sanitizedMessage).toContain("café");
  });

  test("classifies a proxy 407 as a retryable proxy-scoped network failure", async () => {
    const response = new Response(`{"error":{"message":"proxy credentials required"}}`, {
      status: 407,
      headers: { "content-type": "application/json" },
    });
    const error = await readUpstreamError(response).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderAdapterError);
    const mapped = (error as ProviderAdapterError).toProviderCallError();
    expect(mapped.kind).toBe("network_unavailable");
    expect(mapped.routeScope).toBe("proxy");
    expect(mapped.retryable).toBe(true);
    expect(mapped.statusCode).toBe(407);
  });

  test("maps 429 Retry-After to a bounded retryAt and drops absurd values", async () => {
    const bounded = await readUpstreamError(new Response(`{"error":{"message":"slow down"}}`, { status: 429, headers: { "retry-after": "3600" } })).catch((caught) => caught);
    const mapped = (bounded as ProviderAdapterError).toProviderCallError();
    expect(mapped.retryAt).not.toBeNull();
    const delay = Date.parse(mapped.retryAt as string) - Date.now();
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(30_000);
  });
});

describe("parseRetryAfterSeconds", () => {
  const now = Date.parse("2026-08-04T00:00:00.000Z");

  test("accepts delta-seconds and clamps past the safe maximum", () => {
    expect(parseRetryAfterSeconds("5", now)).toBe(5);
    expect(parseRetryAfterSeconds(" 5.5 ", now)).toBe(5.5);
    expect(parseRetryAfterSeconds("0", now)).toBe(0);
    expect(parseRetryAfterSeconds("999999", now)).toBe(30);
  });

  test("accepts HTTP-date values and clamps past dates to zero", () => {
    expect(parseRetryAfterSeconds("Wed, 04 Aug 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfterSeconds("Wed, 04 Aug 2025 00:00:00 GMT", now)).toBe(0);
  });

  test("rejects absent, empty, and unparseable values", () => {
    expect(parseRetryAfterSeconds(null, now)).toBeNull();
    expect(parseRetryAfterSeconds("   ", now)).toBeNull();
    expect(parseRetryAfterSeconds("garbage", now)).toBeNull();
    expect(parseRetryAfterSeconds("-5", now)).toBeNull();
  });
});

describe("decodeSseEvents bound checks", () => {
  test("accepts a chunk containing many valid short lines", async () => {
    // 500 events in a single chunk: 500 * ~8 bytes > the 1 KiB line cap, but
    // every individual line fits — the decode must not reject the chunk.
    const body = "data: 1\n\n".repeat(500);
    const events: Array<unknown> = [];
    for await (const event of decodeSseEvents({ body: streamBody([body]), coordinator: new AbortCoordinator(new AbortController().signal), maxLineBytes: 1_024 })) {
      events.push(event);
    }
    expect(events).toHaveLength(500);
  });

  test("rejects a single over-long line even when split across chunks", async () => {
    const line = `data: ${"x".repeat(2_048)}\n\n`;
    const consume = async (): Promise<void> => {
      for await (const _ of decodeSseEvents({ body: streamBody([line.slice(0, 700), line.slice(700)]), coordinator: new AbortCoordinator(new AbortController().signal), maxLineBytes: 1_024 })) {
        // discard
      }
    };
    await expect(consume()).rejects.toThrow("SSE line exceeds 1024 bytes");
  });
});
import { describe, expect, test } from "bun:test";
import { readConnectFrames, decompressPayload, parseConnectTrailer } from "../../../../src/upstream/providers/devin/connect";
import { ProviderCallError } from "../../../../src/upstream/providers/index";

function frameFrom(flags: number, payload: Uint8Array): Uint8Array {
  const length = payload.length;
  const frame = new Uint8Array(5 + length);
  frame[0] = flags;
  frame[1] = (length >> 24) & 0xff;
  frame[2] = (length >> 16) & 0xff;
  frame[3] = (length >> 8) & 0xff;
  frame[4] = length & 0xff;
  frame.set(payload, 5);
  return frame;
}

function bodyFrom(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
}

describe("readConnectFrames", () => {
  test("reads a single uncompressed frame", async () => {
    const payload = new TextEncoder().encode("hello");
    const frames = [frameFrom(0x00, payload)];
    const result: Array<{ flags: number; payload: string; isEndStream: boolean }> = [];
    for await (const frame of readConnectFrames(bodyFrom(frames))) {
      result.push({ flags: frame.flags, payload: new TextDecoder().decode(frame.payload), isEndStream: frame.isEndStream });
    }
    expect(result[0]).toEqual({ flags: 0, payload: "hello", isEndStream: false });
  });

  test("reads a compressed frame and decompresses it", async () => {
    const original = new TextEncoder().encode("compressed data");
    const compressed = Bun.gzipSync(original);
    const frames = [frameFrom(0x01, compressed)];
    const result: Array<{ flags: number; payload: string }> = [];
    for await (const frame of readConnectFrames(bodyFrom(frames))) {
      const decompressed = decompressPayload(frame.payload);
      result.push({ flags: frame.flags, payload: new TextDecoder().decode(decompressed) });
    }
    expect(result[0]?.payload).toBe("compressed data");
  });

  test("detects end-stream trailer frames", async () => {
    const payload = new TextEncoder().encode("{}");
    const frames = [frameFrom(0x02, payload)];
    const result: Array<{ isEndStream: boolean }> = [];
    for await (const frame of readConnectFrames(bodyFrom(frames))) {
      result.push({ isEndStream: frame.isEndStream });
    }
    expect(result[0]?.isEndStream).toBe(true);
  });

  test("throws on oversized frame length", async () => {
    const frame = new Uint8Array(5);
    frame[0] = 0;
    frame[1] = 0xff;
    frame[2] = 0xff;
    frame[3] = 0xff;
    frame[4] = 0xff;
    let thrown: unknown;
    try {
      for await (const _ of readConnectFrames(bodyFrom([frame]))) {
        // consume
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderCallError);
  });

  test("throws on incomplete trailing frame", async () => {
    const frame = new Uint8Array(3);
    frame[0] = 0;
    frame[1] = 0;
    frame[2] = 10;
    let thrown: unknown;
    try {
      for await (const _ of readConnectFrames(bodyFrom([frame]))) {
        // consume
      }
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderCallError);
  });
});

describe("parseConnectTrailer", () => {
  test("parses an error trailer", () => {
    const trailer = parseConnectTrailer('{"error":{"code":"invalid_argument","message":"bad"}}');
    expect(trailer).toEqual({ error: { code: "invalid_argument", message: "bad" } });
  });

  test("returns undefined for non-error trailers", () => {
    expect(parseConnectTrailer("{}")).toBeUndefined();
    expect(parseConnectTrailer("not json")).toBeUndefined();
    expect(parseConnectTrailer("")).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { consumeConnectFrames, frameConnectMessage, FrameBuffer } from "../../../src/providers/integrations/connect";

/** Feeds `bytes` to `buffer` in fixed-size reads and returns every payload
 *  `consumeConnectFrames` can decode, mimicking the streaming adapters. */
function drainInChunks(buffer: FrameBuffer, bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    buffer.append(bytes.subarray(offset, offset + chunkSize));
    const buffered = buffer.view();
    const { frames, rest } = consumeConnectFrames(buffered);
    buffer.consume(buffered.length - rest.length);
    for (const frame of frames) payloads.push(frame.payload);
  }
  return payloads;
}

describe("FrameBuffer", () => {
  test("reassembles a frame split across many reads", () => {
    const payload = new Uint8Array(64 * 1024).map((_, index) => index % 251);
    const framed = frameConnectMessage(payload);
    const buffer = new FrameBuffer();

    const payloads = drainInChunks(buffer, framed, 1000);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual(payload);
    expect(buffer.view().length).toBe(0);
  });

  test("holds an incomplete frame until the rest arrives", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const framed = frameConnectMessage(payload);
    const buffer = new FrameBuffer();

    buffer.append(framed.subarray(0, 7));
    expect(consumeConnectFrames(buffer.view()).frames).toHaveLength(0);

    buffer.append(framed.subarray(7));
    const { frames, rest } = consumeConnectFrames(buffer.view());
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toEqual(payload);
    buffer.consume(buffer.view().length - rest.length);
    expect(buffer.view().length).toBe(0);
  });

  test("keeps the tail of a read for the next frame", () => {
    const first = frameConnectMessage(new Uint8Array([9, 9]));
    const second = frameConnectMessage(new Uint8Array([7, 7, 7]));
    const buffer = new FrameBuffer();

    // The second frame is truncated mid-envelope.
    buffer.append(Buffer.concat([first, second.subarray(0, 3)]));
    const buffered = buffer.view();
    const { frames, rest } = consumeConnectFrames(buffered);
    buffer.consume(buffered.length - rest.length);

    expect(frames.map((frame) => [...frame.payload])).toEqual([[9, 9]]);
    expect(buffer.view().length).toBe(3);

    buffer.append(second.subarray(3));
    const complete = consumeConnectFrames(buffer.view());
    expect(complete.frames.map((frame) => [...frame.payload])).toEqual([[7, 7, 7]]);
  });

  test("grows past the spare-capacity ceiling without corrupting data", () => {
    // Larger than FRAME_BUFFER_MIN_BYTES and than the 1 MiB spare ceiling, so
    // the backing store is reallocated several times while reassembling.
    const payload = new Uint8Array(3 * 1024 * 1024);
    for (let index = 0; index < payload.length; index += 4096) payload[index] = index % 97;
    const framed = frameConnectMessage(payload);
    const buffer = new FrameBuffer();

    const payloads = drainInChunks(buffer, framed, 16 * 1024);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual(payload);
  });

  test("append ignores empty chunks and consume clamps to the buffered length", () => {
    const buffer = new FrameBuffer();
    buffer.append(new Uint8Array(0));
    expect(buffer.view().length).toBe(0);

    buffer.append(new Uint8Array([1, 2, 3]));
    buffer.consume(-5);
    expect(buffer.view().length).toBe(3);
    buffer.consume(99);
    expect(buffer.view().length).toBe(0);

    // A consumed buffer still accepts and exposes new bytes.
    buffer.append(new Uint8Array([4, 5]));
    expect([...buffer.view()]).toEqual([4, 5]);
  });
});

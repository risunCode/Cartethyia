import { describe, expect, test } from "bun:test";
import {
  decodeGrokCreditsFrame,
  probeFrameHeader,
} from "../../../../src/providers/integrations/grok/grok-quota-frame";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeFixed32Field(fieldNumber: number, value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  return Buffer.concat([encodeTag(fieldNumber, 5), buf]);
}

function encodeLengthDelimited(fieldNumber: number, body: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(body.length), body]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function encodeTimestampField(fieldNumber: number, seconds: number, nanos: number): Buffer {
  const body = Buffer.concat([
    encodeVarintField(1, seconds),
    encodeVarintField(2, nanos),
  ]);
  return encodeLengthDelimited(fieldNumber, body);
}

function encodeCreditsInfo(shape: {
  usageRatio?: number;
  resetSeconds?: number;
  resetNanos?: number;
}): Buffer {
  const parts: Buffer[] = [];
  if (shape.usageRatio !== undefined) {
    parts.push(encodeFixed32Field(1, shape.usageRatio));
  }
  if (shape.resetSeconds !== undefined) {
    parts.push(encodeTimestampField(5, shape.resetSeconds, shape.resetNanos ?? 0));
  }
  return Buffer.concat(parts);
}

function frameData(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function frameTrailer(statusText = "grpc-status:0\r\n"): Buffer {
  const payload = Buffer.from(statusText, "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(0x80, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

describe("decodeGrokCreditsFrame", () => {
  test("decodes full frame with data and trailer", () => {
    const creditsInfo = encodeCreditsInfo({
      usageRatio: 0.42,
      resetSeconds: 1784825940,
      resetNanos: 867850000,
    });
    const topLevel = encodeLengthDelimited(1, creditsInfo);
    const stream = Buffer.concat([frameData(topLevel), frameTrailer()]);

    const decoded = decodeGrokCreditsFrame(stream);
    expect(decoded).not.toBeNull();
    expect(decoded!.percentUsed).toBe(42);
    expect(decoded!.resetAt).toBe(
      new Date(1784825940 * 1000 + Math.round(867850000 / 1_000_000)).toISOString(),
    );
  });

  test("returns 0% when usage ratio is omitted (proto3 default)", () => {
    const creditsInfo = encodeCreditsInfo({
      resetSeconds: 1784825940,
    });
    const topLevel = encodeLengthDelimited(1, creditsInfo);
    const stream = frameData(topLevel);

    const decoded = decodeGrokCreditsFrame(stream);
    expect(decoded).not.toBeNull();
    expect(decoded!.percentUsed).toBe(0);
  });

  test("handles empty or invalid inputs safely", () => {
    expect(decodeGrokCreditsFrame(null)).toBeNull();
    expect(decodeGrokCreditsFrame(new Uint8Array([]))).toBeNull();
    expect(decodeGrokCreditsFrame(Buffer.from([0, 0, 0, 0]))).toBeNull();
  });
});

describe("probeFrameHeader", () => {
  test("parses 5-byte header correctly", () => {
    const buf = Buffer.alloc(10);
    buf.writeUInt8(0x80, 0);
    buf.writeUInt32BE(128, 1);
    const res = probeFrameHeader(buf);
    expect(res).toEqual({ flag: 0x80, payloadStart: 5, payloadLength: 128 });
  });
});

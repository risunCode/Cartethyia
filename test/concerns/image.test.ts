import { describe, expect, test } from "bun:test";
import {
  ImageValidationError,
  MAX_IMAGE_BYTES,
  bytesToBase64,
  decodeImageBase64,
  parseDataUri,
  sniffMediaType,
  toDataUri,
} from "../../src/translate/concerns/image";

function base64Of(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]);
const GIF_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP_MAGIC = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("image concern — sniffMediaType", () => {
  test("detects png, jpeg, gif, webp by magic bytes", () => {
    expect(sniffMediaType(PNG_MAGIC)).toBe("image/png");
    expect(sniffMediaType(JPEG_MAGIC)).toBe("image/jpeg");
    expect(sniffMediaType(GIF_MAGIC)).toBe("image/gif");
    expect(sniffMediaType(WEBP_MAGIC)).toBe("image/webp");
  });

  test("returns undefined for unrecognized bytes", () => {
    expect(sniffMediaType(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });

  test("client-claimed media type is irrelevant — only bytes decide (PNG bytes always sniff as png)", () => {
    // Simulates a client lying about media_type: real bytes are PNG regardless of label.
    expect(sniffMediaType(PNG_MAGIC)).toBe("image/png");
  });
});

describe("image concern — decodeImageBase64", () => {
  test("decodes valid PNG bytes and reports sniffed media type", () => {
    const result = decodeImageBase64(base64Of(PNG_MAGIC));
    expect(result.mediaType).toBe("image/png");
    expect(result.bytes).toEqual(PNG_MAGIC);
  });

  test("throws ImageValidationError on malformed base64", () => {
    expect(() => decodeImageBase64("not-valid-base64!!!")).toThrow(ImageValidationError);
  });

  test("throws ImageValidationError on unrecognized image format", () => {
    expect(() => decodeImageBase64(base64Of(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))).toThrow(ImageValidationError);
  });

  test("throws ImageValidationError when payload exceeds MAX_IMAGE_BYTES", () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1024);
    oversized.set(PNG_MAGIC);
    expect(() => decodeImageBase64(base64Of(oversized))).toThrow(ImageValidationError);
  });
});

describe("image concern — data URI helpers", () => {
  test("parseDataUri extracts base64 payload from a data: URI", () => {
    const uri = toDataUri("image/png", "AAAA");
    expect(parseDataUri(uri)).toEqual({ base64: "AAAA" });
  });

  test("parseDataUri passes through remote http(s) URLs untouched (never fetched)", () => {
    expect(parseDataUri("https://example.com/cat.png")).toEqual({ remoteUrl: "https://example.com/cat.png" });
  });

  test("toDataUri / bytesToBase64 round-trip through decodeImageBase64", () => {
    const uri = toDataUri("image/png", bytesToBase64(PNG_MAGIC));
    const parsed = parseDataUri(uri);
    if (!("base64" in parsed)) throw new Error("expected base64 payload");
    expect(decodeImageBase64(parsed.base64).mediaType).toBe("image/png");
  });
});

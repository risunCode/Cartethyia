import { describe, expect, it } from "bun:test";
import { dropCorruptAttachments } from "../../src/transport/translation/attachment-integrity";
import type { CanonicalRequest, ContentPart } from "../../src/transport/canonical-model";
import { readFileSync } from "node:fs";

const CORRUPT_SCREENSHOT = "C:\\Users\\Aria\\Desktop\\awok..txt";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Uint8Array, crc?: number): Uint8Array {
  const head = new Uint8Array(8 + data.length + 4);
  const view = new DataView(head.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i);
  head.set(data, 8);
  if (crc === undefined) {
    const covered = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i += 1) covered[i] = type.charCodeAt(i);
    covered.set(data, 4);
    view.setUint32(8 + data.length, crc32(covered));
  } else {
    view.setUint32(8 + data.length, crc);
  }
  return head;
}

/** A PNG chunk with a valid CRC — the baseline for a well-formed fixture. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  return buildChunk(type, data);
}

/** A PNG chunk whose stored CRC is deliberately wrong. */
function badChunk(type: string, data: Uint8Array): Uint8Array {
  return buildChunk(type, data, 0xdeadbeef);
}

function png(parts: readonly Uint8Array[]): string {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  const pieces = [sig, chunk("IHDR", ihdr), ...parts, chunk("IEND", new Uint8Array())];
  const total = pieces.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return `data:image/png;base64,${Buffer.from(out).toString("base64")}`;
}

function imageRequest(url: string): CanonicalRequest {
  return {
    model: "workbuddy/deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [{ kind: "image", payload: { type: "image_url", image_url: { url } } }],
      },
    ],
    generation_controls: {},
  } as unknown as CanonicalRequest;
}

function texts(request: CanonicalRequest): readonly string[] {
  return request.messages[0]!.content
    .filter((p): p is Extract<ContentPart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text);
}

describe("dropCorruptAttachments", () => {
  it("drops a PNG whose chunk CRC disagrees with its bytes", () => {
    const result = dropCorruptAttachments(imageRequest(png([badChunk("IDAT", new Uint8Array(64))])));
    expect(result.dropped.map((d) => d.defect)).toEqual(["png_crc_mismatch"]);
    expect(texts(result.request)).toEqual([
      "[attachment dropped: the image data is corrupt (a PNG chunk fails its checksum)]",
    ]);
  });

  it("drops a PNG that ends before its IEND marker", () => {
    // Slice the decoded bytes, not the base64 text: cutting the text would
    // leave a length that is not a multiple of four and trip the base64
    // check instead of the framing check this case is about.
    const decoded = Buffer.from(png([]).split(",")[1]!, "base64");
    const url = `data:image/png;base64,${decoded.subarray(0, 40).toString("base64")}`;
    const result = dropCorruptAttachments(imageRequest(url));
    expect(result.dropped.map((d) => d.defect)).toEqual(["png_missing_end"]);
  });

  it("drops a JPEG with no end-of-image marker", () => {
    const url = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0x00, 0x10]).toString("base64")}`;
    const result = dropCorruptAttachments(imageRequest(url));
    expect(result.dropped.map((d) => d.defect)).toEqual(["jpeg_missing_end"]);
  });

  it("drops a base64 payload whose length is not a multiple of four", () => {
    const result = dropCorruptAttachments(imageRequest("data:image/png;base64,AAA"));
    expect(result.dropped.map((d) => d.defect)).toEqual(["truncated_base64"]);
  });

  it("drops bytes that match no image signature", () => {
    const url = `data:image/png;base64,${Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64")}`;
    const result = dropCorruptAttachments(imageRequest(url));
    expect(result.dropped.map((d) => d.defect)).toEqual(["unrecognized_signature"]);
  });

  it("forwards a well-formed PNG untouched", () => {
    // The 1x1 fixture carries real CRCs, so nothing should be dropped.
    const valid =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const result = dropCorruptAttachments(imageRequest(valid));
    expect(result.dropped).toEqual([]);
    expect(result.request.messages[0]!.content[0]!.kind).toBe("image");
  });

  it("forwards a URL reference without inspecting bytes", () => {
    const result = dropCorruptAttachments(imageRequest("https://example.com/shot.png"));
    expect(result.dropped).toEqual([]);
  });

  it("forwards an unrecognized media type untouched", () => {
    const url = `data:image/webp;base64,${Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64")}`;
    const result = dropCorruptAttachments(imageRequest(url));
    expect(result.dropped).toEqual([]);
  });

  it("keeps sibling text parts when an attachment is dropped", () => {
    const request = imageRequest(png([badChunk("IDAT", new Uint8Array(64))]));
    request.messages[0]!.content = [
      { kind: "text", text: "screenshot below" },
      ...request.messages[0]!.content,
    ] as CanonicalRequest["messages"][number]["content"];
    const result = dropCorruptAttachments(request);
    expect(texts(result.request)[0]).toBe("screenshot below");
    expect(texts(result.request)).toHaveLength(2);
  });

  // Regression: the capture that motivated this module. The screenshot at
  // message 637 was written before the writer flushed, so one IDAT chunk's
  // stored CRC does not match its bytes — and the upstream rejected the whole
  // request with an unnamed `model_param_invalid`.
  it("drops the real corrupt screenshot from the captured request", () => {
    const captured = JSON.parse(readFileSync(CORRUPT_SCREENSHOT, "utf-8")) as {
      body: {
        messages: Array<{ role: string; content: Array<{ type?: string; image_url?: { url: string } }> }>;
      };
    };
    const url = captured.body.messages[637]!.content.find((p) => p.type === "image_url")?.image_url
      ?.url;
    expect(url).toBeDefined();
    const result = dropCorruptAttachments(imageRequest(url!));
    expect(result.dropped.map((d) => d.defect)).toEqual(["png_crc_mismatch"]);
  });

  it("accepts the well-formed screenshot from the same capture", () => {
    const captured = JSON.parse(readFileSync(CORRUPT_SCREENSHOT, "utf-8")) as {
      body: {
        messages: Array<{ role: string; content: Array<{ type?: string; image_url?: { url: string } }> }>;
      };
    };
    const url = captured.body.messages[640]!.content.find((p) => p.type === "image_url")?.image_url
      ?.url;
    expect(url).toBeDefined();
    expect(dropCorruptAttachments(imageRequest(url!)).dropped).toEqual([]);
  });
});

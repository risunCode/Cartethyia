import { ProviderCallError } from "../index";

const COMPRESSED_FLAG = 0x01;
const END_STREAM_FLAG = 0x02;
const MAX_PAYLOAD_SIZE = 16 * 1024 * 1024;

export interface ConnectFrame {
  flags: number;
  payload: Uint8Array;
  isEndStream: boolean;
}

export interface ConnectTrailer {
  error?: { code: string; message: string };
}

export async function* readConnectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ConnectFrame> {
  const reader = body.getReader();
  const buffer: number[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        for (const byte of value) buffer.push(byte);
      }
      if (done) break;

      while (buffer.length >= 5) {
        const flags = buffer[0] ?? 0;
        const b1 = buffer[1] ?? 0;
        const b2 = buffer[2] ?? 0;
        const b3 = buffer[3] ?? 0;
        const b4 = buffer[4] ?? 0;
        const length = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
        if (length > MAX_PAYLOAD_SIZE) {
          throw new ProviderCallError(502, "malformed_response", "Connect frame payload exceeds the maximum allowed size.");
        }
        if (buffer.length < 5 + length) break;

        buffer.shift();
        buffer.shift();
        buffer.shift();
        buffer.shift();
        buffer.shift();
        const payload = new Uint8Array(length);
        for (let i = 0; i < length; i++) payload[i] = buffer.shift() ?? 0;
        yield { flags, payload, isEndStream: (flags & END_STREAM_FLAG) !== 0 };
      }
    }

    if (buffer.length > 0) {
      throw new ProviderCallError(502, "malformed_response", "Connect stream ended with an incomplete frame.");
    }
  } finally {
    reader.releaseLock();
  }
}

export function decompressPayload(payload: Uint8Array): Uint8Array {
  try {
    const decompressed = Bun.gunzipSync(payload as Uint8Array<ArrayBuffer>);
    return new Uint8Array(decompressed);
  } catch {
    throw new ProviderCallError(502, "malformed_response", "Failed to decompress Connect frame payload.");
  }
}

export function parseConnectTrailer(text: string): ConnectTrailer | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (!("error" in obj)) return undefined;
  const err = obj.error;
  if (!err || typeof err !== "object" || Array.isArray(err)) return undefined;
  const errObj = err as Record<string, unknown>;
  const code = typeof errObj.code === "string" ? errObj.code : "";
  const message = typeof errObj.message === "string" ? errObj.message : "";
  if (!code && !message) return undefined;
  return { error: { code, message } };
}

export { COMPRESSED_FLAG, END_STREAM_FLAG };

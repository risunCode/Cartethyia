import { mkdir, open, readdir, readFile, stat, truncate, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface PayloadFileReference {
  readonly storage: "jsonb-file";
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  readonly checksum: string;
  readonly version: 1;
}

interface PayloadFrame {
  readonly version: 1;
  readonly id: string;
  readonly expiresAt: string;
  readonly payload: unknown;
}

export function isPayloadFileReference(value: unknown): value is PayloadFileReference {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["storage"] === "jsonb-file" &&
    typeof record["file"] === "string" &&
    typeof record["offset"] === "number" &&
    typeof record["length"] === "number" &&
    typeof record["checksum"] === "string" &&
    record["version"] === 1
  );
}

/**
 * Payload rows store the file reference wrapped as `{ _payload_ref: ... }`
 * (see `TelemetryPayloadCapture.capture`) so the column can later hold either
 * a reference or an inline body. Unwraps both the wrapped and the bare shape;
 * returns undefined for inline bodies, so callers never leak raw ref JSON.
 */
export function extractPayloadFileReference(value: unknown): PayloadFileReference | undefined {
  if (isPayloadFileReference(value)) return value;
  if (typeof value === "object" && value !== null && "_payload_ref" in value) {
    const inner: unknown = (value as { readonly _payload_ref?: unknown })._payload_ref;
    if (isPayloadFileReference(inner)) return inner;
  }
  return undefined;
}

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_DIRECTORY = "./data/telemetry-payloads";
let writeTail: Promise<void> = Promise.resolve();

function payloadDirectory(): string {
  return process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR?.trim() || DEFAULT_DIRECTORY;
}

function maxFileBytes(): number {
  const raw = Number(process.env.CARTETHYIA_TELEMETRY_PAYLOAD_FILE_MAX_BYTES ?? DEFAULT_MAX_FILE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FILE_BYTES;
}

function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fileName(now = new Date()): string {
  return `${now.toISOString().slice(0, 13).replaceAll(":", "-")}-${process.pid}.jsonb`;
}

async function appendFrame(frame: PayloadFrame): Promise<PayloadFileReference> {
  const directory = payloadDirectory();
  await mkdir(directory, { recursive: true });
  const encoded = Buffer.from(JSON.stringify(frame), "utf8");
  if (encoded.byteLength > MAX_FRAME_BYTES) throw new Error("telemetry payload frame exceeds limit");
  const file = fileName();
  const path = join(directory, file);
  const currentSize = await stat(path).then((value) => value.size).catch(() => 0);
  const offset = currentSize;
  if (offset + FRAME_HEADER_BYTES + encoded.byteLength > maxFileBytes()) {
    const rotated = `${Date.now()}-${randomUUID()}.jsonb`;
    return appendFrameToPath(frame, join(directory, rotated));
  }
  return appendFrameToPath(frame, path, file, offset, encoded);
}

async function appendFrameToPath(
  frame: PayloadFrame,
  path: string,
  knownFile = basename(path),
  knownOffset?: number,
  knownEncoded?: Buffer,
): Promise<PayloadFileReference> {
  const encoded = knownEncoded ?? Buffer.from(JSON.stringify(frame), "utf8");
  const offset = knownOffset ?? await stat(path).then((value) => value.size).catch(() => 0);
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(encoded.byteLength, 0);
  const handle = await open(path, "a");
  try {
    await handle.write(Buffer.concat([header, encoded]));
  } finally {
    await handle.close();
  }
  return {
    storage: "jsonb-file",
    file: knownFile,
    offset,
    length: FRAME_HEADER_BYTES + encoded.byteLength,
    checksum: checksum(encoded.toString("utf8")),
    version: 1,
  };
}

export function writePayloadFrame(payload: unknown, expiresAt: Date): Promise<PayloadFileReference> {
  const frame: PayloadFrame = {
    version: 1,
    id: randomUUID(),
    expiresAt: expiresAt.toISOString(),
    payload,
  };
  const task = writeTail.then(() => appendFrame(frame));
  writeTail = task.then(() => undefined, () => undefined);
  return task;
}

export async function readPayloadFrame(reference: PayloadFileReference): Promise<unknown | undefined> {
  const path = join(payloadDirectory(), reference.file);
  const data = await readFile(path);
  if (reference.offset < 0 || reference.offset + reference.length > data.byteLength) return undefined;
  const frame = data.subarray(reference.offset, reference.offset + reference.length);
  const length = frame.readUInt32BE(0);
  if (length + FRAME_HEADER_BYTES !== frame.byteLength) return undefined;
  const json = frame.subarray(FRAME_HEADER_BYTES).toString("utf8");
  if (checksum(json) !== reference.checksum) return undefined;
  const parsed = JSON.parse(json) as PayloadFrame;
  return parsed.version === 1 ? parsed.payload : undefined;
}

export async function prunePayloadFrames(before: Date): Promise<number> {
  const directory = payloadDirectory();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonb")) continue;
    const path = join(directory, entry.name);
    const data = await readFile(path).catch(() => undefined);
    if (!data || data.byteLength < FRAME_HEADER_BYTES) continue;
    let offset = 0;
    let retained = Buffer.alloc(0);
    while (offset + FRAME_HEADER_BYTES <= data.byteLength) {
      const length = data.readUInt32BE(offset);
      const end = offset + FRAME_HEADER_BYTES + length;
      if (length <= 0 || end > data.byteLength) break;
      const frame = JSON.parse(data.subarray(offset + FRAME_HEADER_BYTES, end).toString("utf8")) as PayloadFrame;
      if (new Date(frame.expiresAt).getTime() >= before.getTime()) retained = Buffer.concat([retained, data.subarray(offset, end)]);
      offset = end;
    }
    if (retained.byteLength === 0) {
      await unlink(path).catch(() => undefined);
      deleted += 1;
    } else if (retained.byteLength !== data.byteLength) {
      await truncate(path, 0);
      const handle = await open(path, "a");
      try { await handle.write(retained); } finally { await handle.close(); }
    }
  }
  return deleted;
}

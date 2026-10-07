import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export interface PayloadFileReference {
  /**
   * `jsonb-file` is a frame written before compression existed: plain JSON.
   * New frames are `jsonl-file`: the same JSON, gzipped. The row names its
   * encoding, so a reader never guesses and an old row still resolves.
   */
  readonly storage: "jsonb-file" | "jsonl-file";
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
    (record["storage"] === "jsonb-file" || record["storage"] === "jsonl-file") &&
    typeof record["file"] === "string" &&
    typeof record["offset"] === "number" &&
    typeof record["length"] === "number" &&
    typeof record["checksum"] === "string" &&
    record["version"] === 1
  );
}

/**
 * Builds a frame reference from a `telemetry_payloads` row's typed columns.
 * Returns undefined when any column is out of contract so callers treat a
 * corrupt index row as "no payload" rather than path-traversing or reading
 * the wrong bytes.
 */
export function payloadReferenceFromRow(row: {
  readonly storage: string;
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  readonly checksum: string;
  readonly version: number;
}): PayloadFileReference | undefined {
  const candidate = {
    storage: row.storage,
    file: row.file,
    offset: row.offset,
    length: row.length,
    checksum: row.checksum,
    version: row.version,
  };
  return isPayloadFileReference(candidate) ? candidate : undefined;
}

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_DIRECTORY = "./data/telemetry-payloads";
let writeTail: Promise<void> = Promise.resolve();

/**
 * Single source of truth for the telemetry payload directory: the
 * `CARTETHYIA_TELEMETRY_PAYLOAD_DIR` override when set, otherwise the
 * default `./data/telemetry-payloads`. Every writer and reader must resolve
 * the directory through this function so the two can never drift.
 */
export function payloadDirectory(): string {
  return process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR?.trim() || DEFAULT_DIRECTORY;
}

function maxFileBytes(): number {
  const raw = Number(process.env.CARTETHYIA_TELEMETRY_PAYLOAD_FILE_MAX_BYTES ?? DEFAULT_MAX_FILE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_FILE_BYTES;
}

function checksum(value: Buffer | readonly Buffer[]): string {
  const parts = Array.isArray(value) ? value : [value];
  let hash = 2166136261;
  for (const part of parts) {
    for (let index = 0; index < part.byteLength; index += 1) {
      hash ^= part[index]!;
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fileName(now = new Date()): string {
  return `${now.toISOString().slice(0, 13).replaceAll(":", "-")}-${process.pid}.jsonb`;
}

/**
 * Gzipped frame body.
 *
 * The pieces stay separate until here, because nothing before the write reads
 * them assembled and joining them earlier is a copy of the whole frame. The
 * join happens once, at the moment of compression, and the compressed buffer
 * is what gets written, checksummed, and bounded — so the cap and the
 * reference both describe bytes on disk, not bytes of JSON.
 */
function compressFrame(parts: readonly Buffer[]): Buffer {
  return gzipSync(Buffer.concat(parts));
}

async function appendFrame(frame: PayloadFrame, parts?: readonly Buffer[]): Promise<PayloadFileReference> {
  const directory = payloadDirectory();
  await mkdir(directory, { recursive: true });
  parts ??= [Buffer.from(JSON.stringify(frame), "utf8")];
  const encoded = compressFrame(parts);
  if (encoded.byteLength > MAX_FRAME_BYTES) throw new Error("telemetry payload frame exceeds limit");
  const file = fileName();
  const path = join(directory, file);
  const currentSize = await stat(path).then((value) => value.size).catch(() => 0);
  const offset = currentSize;
  if (offset + FRAME_HEADER_BYTES + encoded.byteLength > maxFileBytes()) {
    const rotated = `${Date.now()}-${randomUUID()}.jsonb`;
    return appendFrameToPath(frame, join(directory, rotated), basename(rotated), undefined, encoded);
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
  const encoded = knownEncoded ?? compressFrame([Buffer.from(JSON.stringify(frame), "utf8")]);
  const offset = knownOffset ?? await stat(path).then((value) => value.size).catch(() => 0);
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(encoded.byteLength, 0);
  const handle = await open(path, "a");
  try {
    await handle.write(header);
    await handle.write(encoded);
  } finally {
    await handle.close();
  }
  return {
    storage: "jsonl-file",
    file: knownFile,
    offset,
    length: FRAME_HEADER_BYTES + encoded.byteLength,
    checksum: checksum(encoded),
    version: 1,
  };
}

const FRAME_BODY_KEYS = [
  "request_body",
  "response_body",
  "client_response_body",
  "provider_request_body",
  "provider_response_body",
] as const;

/**
 * The pieces of a frame whose bodies were already serialized while measured.
 *
 * Returned as separate buffers rather than one assembled buffer: the file
 * write accepts a list, and assembling them first is a copy of the whole frame
 * that nothing reads back.
 */
function prebuiltFrameParts(
  id: string,
  expiresAt: string,
  capturedAt: string,
  requestId: string | null,
  signals: unknown,
  bodies: readonly string[],
): Buffer[] {
  const parts = [
    Buffer.from(
      `{"version":1,"id":${JSON.stringify(id)},"expiresAt":${JSON.stringify(expiresAt)},` +
        `"payload":{"request_id":${JSON.stringify(requestId)},"captured_at":${JSON.stringify(capturedAt)},` +
        `"expires_at":${JSON.stringify(expiresAt)}`,
      "utf8",
    ),
  ];
  for (let index = 0; index < FRAME_BODY_KEYS.length; index += 1) {
    parts.push(Buffer.from(`,"${FRAME_BODY_KEYS[index]}":${bodies[index] ?? "null"}`, "utf8"));
  }
  parts.push(Buffer.from(`,"signals":${JSON.stringify(signals)}}}`, "utf8"));
  return parts;
}

export function writePayloadFrame(
  payload: unknown,
  expiresAt: Date,
  prebuilt?: { readonly requestId: string | null; readonly capturedAt: string; readonly signals: unknown; readonly bodies: readonly string[] },
): Promise<PayloadFileReference> {
  const id = randomUUID();
  const expires = expiresAt.toISOString();
  const parts = prebuilt
    ? prebuiltFrameParts(id, expires, prebuilt.capturedAt, prebuilt.requestId, prebuilt.signals, prebuilt.bodies)
    : undefined;
  const frame: PayloadFrame = { version: 1, id, expiresAt: expires, payload };
  const task = writeTail.then(() => appendFrame(frame, parts));
  writeTail = task.then(() => undefined, () => undefined);
  return task;
}

export async function readPayloadFrame(reference: PayloadFileReference): Promise<unknown | undefined> {
  // Basename-constrain the reference: a hostile/restored row carrying
  // `../../x` must not escape the payload directory (path traversal).
  const safeFile = basename(reference.file);
  if (safeFile !== reference.file || safeFile.length === 0) return undefined;
  const path = join(payloadDirectory(), safeFile);
  // Read exactly the frame. Reading the whole file copied every earlier frame
  // in the same hour into memory just to return one of them.
  const handle = await open(path, "r");
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (reference.offset < 0 || reference.offset + reference.length > stat.size) return undefined;
    data = Buffer.alloc(reference.length);
    await handle.read(data, 0, reference.length, reference.offset);
  } finally {
    await handle.close();
  }
  const frame = data;
  const length = frame.readUInt32BE(0);
  if (length <= 0 || length + FRAME_HEADER_BYTES !== frame.byteLength) return undefined;
  const stored = frame.subarray(FRAME_HEADER_BYTES);
  if (checksum(stored) !== reference.checksum) return undefined;
  // The row says which encoding it wrote. A compressed row that does not
  // decompress is a damaged frame, reported as absent like any other
  // unreadable frame, never thrown into the request that asked for it.
  const json = reference.storage === "jsonl-file" ? gunzipFrame(stored) : stored;
  if (json === undefined) return undefined;
  const parsed = JSON.parse(json.toString("utf8")) as PayloadFrame;
  return parsed.version === 1 ? parsed.payload : undefined;
}

/** Decompressed frame body, or undefined when the bytes are not gzip. */
function gunzipFrame(stored: Buffer): Buffer | undefined {
  try {
    return gunzipSync(stored);
  } catch {
    return undefined;
  }
}

/**
 * What a whole file's parseable frames say about reclaiming it.
 *
 * `live` — at least one frame is still inside its retention window.
 * `none` — every frame was read and every one has expired.
 * `unknown` — parsing stopped on a torn tail or a corrupt frame, so the rest
 *   of the file is unreadable and cannot be assumed empty of live frames.
 */
type FrameLiveness = "live" | "none" | "unknown";

/**
 * The JSON of one stored frame, whichever encoding wrote it.
 *
 * A frame names no encoding of its own — the row does — and this pass reads
 * files, not rows. gzip bytes start with the 0x1f 0x8b magic and plain JSON
 * starts with `{`, so the encoding is read off the bytes. Anything else is
 * corrupt and falls through to the caller's parse, which reports the file
 * unreadable rather than empty.
 */
function frameJson(stored: Buffer): Buffer {
  if (stored.byteLength >= 2 && stored[0] === 0x1f && stored[1] === 0x8b) {
    return gunzipSync(stored);
  }
  return stored;
}


function frameLiveness(data: Buffer, before: Date): FrameLiveness {
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= data.byteLength) {
    const length = data.readUInt32BE(offset);
    const end = offset + FRAME_HEADER_BYTES + length;
    // A length that runs past the file is a half-written tail, not a frame.
    if (length <= 0 || end > data.byteLength) return "unknown";
    let frame: PayloadFrame;
    try {
      frame = JSON.parse(frameJson(data.subarray(offset + FRAME_HEADER_BYTES, end)).toString("utf8")) as PayloadFrame;
    } catch {
      return "unknown";
    }
    if (new Date(frame.expiresAt).getTime() >= before.getTime()) return "live";
    offset = end;
  }
  // Bytes left over that are too short to hold a header are an unreadable tail.
  return offset === data.byteLength ? "none" : "unknown";
}

/**
 * Reclaims frame files that no longer hold a live payload.
 *
 * Frames are append-only and this pass never rewrites a file. That is a
 * correctness requirement, not an optimization: a `telemetry_payloads` row
 * addresses its body by file + offset + length, so compacting a file in place
 * would shift every later frame and leave live rows pointing at the wrong
 * bytes — the drawer then reads `undefined` and the payload silently vanishes
 * while its row is still current. A file is dropped whole, and only once
 * nothing in it is still live.
 *
 * `unparseableWrittenBefore` bounds the damaged-file case. A region that
 * cannot be parsed cannot prove it holds no live frame, so such a file is kept
 * until its last write is older than that instant — every frame it could hold
 * was written before then and has therefore expired. A caller that cannot
 * supply that bound leaves the default, which keeps damaged files rather than
 * risk dropping a frame a row still addresses.
 *
 * One damaged file must not abort the pass. A single corrupt frame used to
 * throw straight out of the loop, so every other expired file stayed on disk
 * forever and the volume only grew — and because a container restart is the
 * usual way a half-written tail appears, the failure looked Docker-specific.
 */
export async function prunePayloadFrames(
  before: Date,
  unparseableWrittenBefore: Date = new Date(0),
): Promise<number> {
  const directory = payloadDirectory();
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonb")) continue;
    const path = join(directory, entry.name);
    try {
      if (await fileReclaimable(path, before, unparseableWrittenBefore)) {
        await unlink(path);
        deleted += 1;
      }
    } catch {
      // Stat, read, or unlink failed on this one file. Leave it for the next
      // pass rather than abandoning every remaining file's reclaim.
    }
  }
  return deleted;
}

/**
 * True when the file can be deleted without losing a frame a row still
 * addresses. A readable file is reclaimable once every frame has expired; a
 * damaged one only once `unparseableWrittenBefore` rules out a live frame in
 * the part that could not be parsed.
 */
async function fileReclaimable(
  path: string,
  before: Date,
  unparseableWrittenBefore: Date,
): Promise<boolean> {
  const data = await readFile(path);
  if (data.byteLength < FRAME_HEADER_BYTES) return true;
  const liveness = frameLiveness(data, before);
  if (liveness === "live") return false;
  if (liveness === "none") return true;
  const written = await stat(path).then((value) => value.mtimeMs);
  return written <= unparseableWrittenBefore.getTime();
}

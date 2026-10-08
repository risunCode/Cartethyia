import { resolveImageSource, splitDataUrl } from "../../protocol/primitives";
import type { CanonicalRequest, ContentPart } from "../canonical-model";
import { log } from "../../observability/logger";

/**
 * Why an inline attachment was rejected before it reached the upstream.
 *
 * The names are operator-facing: they land in the degraded-attachment log line
 * and in the placeholder text the model sees, so each one has to be readable
 * on its own.
 */
export type AttachmentDefect =
  /** The base64 payload is not a whole number of 4-char groups. */
  | "truncated_base64"
  /** Base64 is well-formed but the bytes behind it are not a decodable image. */
  | "undecodable_base64"
  /** The declared media type is one this gateway cannot inspect. */
  | "unsupported_media_type"
  /** A PNG chunk's stored CRC disagrees with the bytes it covers. */
  | "png_crc_mismatch"
  /** A PNG stream ends without the terminating `IEND` chunk. */
  | "png_missing_end"
  /** A JPEG stream has no `FFD9` end-of-image marker. */
  | "jpeg_missing_end"
  /** The byte stream is neither a PNG nor a JPEG. */
  | "unrecognized_signature";

/** One attachment dropped from a request, and why. */
export interface DroppedAttachment {
  readonly defect: AttachmentDefect;
  /** Index of the message the part lived in, for the log line. */
  readonly messageIndex: number;
}

export interface AttachmentIntegrityResult {
  /** The request with every defective inline attachment replaced by a note. */
  readonly request: CanonicalRequest;
  /** Non-empty only when something was actually dropped. */
  readonly dropped: readonly DroppedAttachment[];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Human-readable reason, used in the placeholder text and the log line. */
const DEFECT_TEXT: Record<AttachmentDefect, string> = {
  truncated_base64: "its base64 payload is truncated",
  undecodable_base64: "its base64 payload does not decode",
  unsupported_media_type: "its media type cannot be inspected",
  png_crc_mismatch: "the image data is corrupt (a PNG chunk fails its checksum)",
  png_missing_end: "the image data is truncated (no PNG end marker)",
  jpeg_missing_end: "the image data is truncated (no JPEG end marker)",
  unrecognized_signature: "the bytes are not a recognizable image",
};

/**
 * Media types worth inspecting. Everything else is forwarded untouched: a
 * gateway that guesses at formats it cannot parse risks dropping a valid
 * attachment, which is a worse outcome than letting the upstream decide.
 */
const INSPECTABLE_MEDIA_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/jpg": true,
};

/** Reads a big-endian 32-bit unsigned integer. */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/** True when `bytes` begins with `signature`. */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

/**
 * CRC-32 (IEEE 802.3, reflected, polynomial `0xEDB88320`) as PNG specifies it.
 *
 * Inlined rather than pulled from a dependency: the table is 1 KB of work on
 * first use and this runs on every inline image of every request, so the
 * lookup is built once per process instead of once per image.
 */
let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, length: number): number {
  if (crcTable === undefined) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = start; i < start + length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Walks a PNG's chunk chain verifying each stored CRC and that the stream is
 * terminated by `IEND`.
 *
 * Only the chunk framing is checked — the pixel stream is left compressed. A
 * screenshot captured before the writer flushed it is exactly the case this
 * catches, and a corrupt pixel stream fails here too because the corruption
 * lands in an IDAT chunk's covered bytes.
 */
function inspectPng(bytes: Uint8Array): AttachmentDefect | undefined {
  let offset = PNG_SIGNATURE.length;
  let sawEnd = false;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    // A chunk length that overruns the buffer means the stream was cut short.
    if (offset + 12 + length > bytes.length) return "png_missing_end";
    const typeEnd = offset + 8;
    const storedCrc = readUint32(bytes, offset + 8 + length);
    // The CRC covers the type field and the data, not the length or itself.
    if (crc32(bytes, offset + 4, 4 + length) !== storedCrc) return "png_crc_mismatch";
    const isEnd =
      bytes[offset + 4] === 0x49 &&
      bytes[offset + 5] === 0x45 &&
      bytes[offset + 6] === 0x4e &&
      bytes[offset + 7] === 0x44;
    if (isEnd) {
      sawEnd = true;
      break;
    }
    offset = typeEnd + length + 4;
  }
  return sawEnd ? undefined : "png_missing_end";
}

/** True when the stream carries a JPEG `FFD9` end-of-image marker. */
function inspectJpeg(bytes: Uint8Array): AttachmentDefect | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return "unrecognized_signature";
  }
  // Scan backwards: trailing padding after the marker is normal in the wild.
  for (let i = bytes.length - 1; i >= 1; i -= 1) {
    if (bytes[i] !== 0xd9) continue;
    if (bytes[i - 1] === 0xff) return undefined;
  }
  return "jpeg_missing_end";
}

/**
 * Decodes base64 without throwing, treating malformed input as a defect.
 *
 * `Buffer.from` is lenient — it drops invalid characters rather than throwing
 * — so the byte-signature checks below do the real work. Only the length
 * filter is available here: a base64 payload's length is a multiple of 4 once
 * padding is present, so anything else was cut off mid-encode.
 */
function decodeBase64(data: string): Uint8Array | undefined {
  if (data.length % 4 !== 0) return undefined;
  try {
    return new Uint8Array(Buffer.from(data, "base64"));
  } catch {
    return undefined;
  }
}

/** Classifies an inline image's bytes, or `undefined` when they are sound. */
function inspectImageBytes(mediaType: string, data: string): AttachmentDefect | undefined {
  if (INSPECTABLE_MEDIA_TYPES[mediaType] !== true) return undefined;
  const bytes = decodeBase64(data);
  if (bytes === undefined) return "truncated_base64";
  if (startsWith(bytes, PNG_SIGNATURE)) return inspectPng(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  return "unrecognized_signature";
}

/** The only `data:`-URI shapes an image part can carry its bytes in. */
function inlineDefect(part: Extract<ContentPart, { kind: "image" }>): AttachmentDefect | undefined {
  const source = resolveImageSource(part.payload);
  const url = source?.url;
  if (url === undefined) return undefined; // A URL or file-id reference is the upstream's to fetch.
  const split = splitDataUrl(url);
  if (split === undefined) return undefined; // Not inline bytes — nothing to inspect.
  return inspectImageBytes(split.mediaType.toLowerCase(), split.data);
}

/**
 * Replaces inline image attachments that cannot survive the upstream with a
 * text placeholder naming the reason.
 *
 * Why drop rather than forward: a provider that rejects a corrupt image
 * rejects the *whole* request — the caller gets a 400 with no field named (the
 * buddy family reports `model_param_invalid` with an empty `param`), so the
 * failure is unactionable. Swapping the part for a short note keeps the turn's
 * position and its surrounding text intact, and tells the model the attachment
 * was there, which is strictly more useful than a failed request.
 *
 * A valid image is never touched — the check is read-only until it finds a
 * defect, and unrecognized media types are forwarded as-is.
 */
export function dropCorruptAttachments(
  request: CanonicalRequest,
): AttachmentIntegrityResult {
  const dropped: DroppedAttachment[] = [];

  const strip = (
    parts: readonly ContentPart[],
    messageIndex: number,
  ): readonly ContentPart[] =>
    parts.flatMap((part): ContentPart[] => {
      if (part.kind !== "image") return [part];
      const defect = inlineDefect(part);
      if (defect === undefined) return [part];
      dropped.push({ defect, messageIndex });
      return [
        {
          kind: "text",
          text: `[attachment dropped: ${DEFECT_TEXT[defect]}]`,
        },
      ];
    });

  const messages = request.messages.map((message, index) => ({
    ...message,
    content: strip(message.content, index),
  }));
  const system =
    request.system === undefined ? request.system : strip(request.system, -1);

  if (dropped.length === 0) return { request, dropped: [] };
  // Dropping an attachment changes what the model can see, so it is never
  // silent — but it is also not a warn: this fires on every corrupt upload,
  // and a client that re-sends the same broken file should not be able to
  // flood the console ring.
  log.info("[attachments] dropped inline media that the upstream would reject", {
    model: request.model,
    dropped: dropped.map((d) => `${d.defect}@msg${d.messageIndex}`),
  });
  return {
    request: { ...request, messages, ...(system === undefined ? {} : { system }) },
    dropped,
  };
}

/**
 * Image concern — base64 (de)encode, magic-byte media-type sniffing, size/mime guard.
 *
 * OpenAI encodes images as a data URI (`data:image/png;base64,AAAA...`) inline
 * in `image_url.url`; Anthropic wants base64 payload and media_type as two
 * separate fields. We normalize both directions through raw bytes + a sniffed
 * media type instead of trusting the client-supplied media type string, since
 * a client (or a translated upstream) can lie about it.
 */

const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** 5 MiB — generous enough for real photos, small enough to stop a base64 bomb. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DecodedImage {
  mediaType: string;
  bytes: Uint8Array;
}

export class ImageValidationError extends Error {}

/** Sniff media type from the leading bytes; ignores whatever the caller claims it is. */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Decode a base64 payload into validated, media-type-sniffed bytes.
 * Throws ImageValidationError on malformed base64, oversize payload, or an
 * unrecognized/unsupported format — callers should surface this as a 400.
 */
export function decodeImageBase64(base64: string): DecodedImage {
  // Reject oversize BEFORE decoding — base64 inflates ~4/3, so bound the
  // encoded string length rather than allocating the decoded buffer first.
  if (base64.length > (MAX_IMAGE_BYTES * 4) / 3 + 4) {
    throw new ImageValidationError(`image payload exceeds ${MAX_IMAGE_BYTES} bytes`);
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    throw new ImageValidationError("invalid base64 image payload");
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError(`image payload exceeds ${MAX_IMAGE_BYTES} bytes`);
  }

  const mediaType = sniffMediaType(bytes);
  if (!mediaType || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new ImageValidationError("unrecognized or unsupported image format (jpeg/png/gif/webp only)");
  }

  return { mediaType, bytes };
}

/** Parse an OpenAI-style `data:image/png;base64,AAAA` URI into base64 payload; passthrough for remote http(s) URLs. */
export function parseDataUri(url: string): { base64: string } | { remoteUrl: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (match) return { base64: match[2]! };
  return { remoteUrl: url };
}

export function toDataUri(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

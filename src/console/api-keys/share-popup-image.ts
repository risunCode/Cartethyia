/**
 * Share-popup image policy — pure declarations only.
 *
 * This module must stay free of Node imports and Buffer usage: the dashboard
 * re-exports these bounds for its upload control, so putting them anywhere that
 * reaches `node:crypto` would drag a Node builtin into the browser bundle. The
 * server-side decode lives beside it in `contracts.ts`.
 */

/** Decoded art ceiling; the upload control rejects above this before sending. */
export const SHARE_POPUP_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The only formats the share page may serve. Raster only on purpose: an SVG is
 * an active document and would become stored XSS wherever it is embedded.
 */
export const SHARE_POPUP_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type SharePopupImageMime = (typeof SHARE_POPUP_IMAGE_MIMES)[number];

/**
 * Stored art as an `ArrayBuffer`-backed view, ready to hand to `Blob`/`Response`.
 *
 * A Node `Buffer` is `Uint8Array<ArrayBufferLike>` because it may wrap a
 * `SharedArrayBuffer`, which the web `BodyInit` types reject. The common case is
 * a plain `ArrayBuffer` and stays zero-copy; only the exotic one copies.
 */
export function popupImageBytes(image: Uint8Array): Uint8Array<ArrayBuffer> {
  return image.buffer instanceof ArrayBuffer
    ? new Uint8Array(image.buffer, image.byteOffset, image.byteLength)
    : new Uint8Array(image);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Identifies the format from the bytes themselves. The declared mime is not
 * trusted: the stored value is the `Content-Type` this gateway later serves, so
 * an upload labelled `image/png` that is really something else would otherwise
 * become an active document on the share page.
 */
export function sniffSharePopupImageMime(bytes: Uint8Array): SharePopupImageMime | undefined {
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
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

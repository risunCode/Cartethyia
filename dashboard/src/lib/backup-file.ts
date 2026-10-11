/**
 * Reading an uploaded backup file.
 *
 * The export offers a compressed download and names it `.json.gz`, so the file
 * an operator picks back up is gzip bytes — and `file.text()` plus `JSON.parse`
 * rejects it, which until now made the operator's own backup the one file the
 * restore path could not read. Both upload surfaces (the setup wizard and the
 * backup panel) go through here so there is one owner of "what a backup file is"
 * rather than two copies of the same parse.
 *
 * Whether the file is compressed is decided from its magic bytes, never from its
 * name: a `.json` that is really gzip is read correctly, and so is a `.gz` that
 * is not.
 */

/** The gzip magic: `1f 8b`. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

function isGzip(bytes: Uint8Array): boolean {
  return GZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Inflates gzip bytes with the platform's own decompressor. */
async function inflate(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser cannot decompress a .gz backup. Export without compression, or restore from the console's API.",
    );
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/**
 * Parses an uploaded backup file into the payload the restore API expects.
 *
 * Throws the message the caller should show the operator, because both callers
 * render it verbatim and "Unexpected token � in JSON at position 0" is not a
 * sentence anyone can act on.
 */
export async function readBackupFile(file: File): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error("Could not read that file.");
  }
  const text = isGzip(bytes) ? await inflate(bytes) : new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      isGzip(bytes) ? "That file decompressed to something that is not a JSON backup." : "That file is not a JSON backup.",
    );
  }
}

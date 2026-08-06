/** Result of bounded body reading, distinguishing oversized from malformed JSON. */
export type JsonBodyResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: "too_large" | "invalid" };

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Reads and parses JSON only after enforcing a byte limit on the request stream. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) return { ok: false, reason: "too_large" };
  if (request.body === null) return { ok: false, reason: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  const expectedBytes = contentLength !== undefined && Number.isInteger(contentLength) && contentLength >= 0 ? contentLength : null;
  let buffer = expectedBytes === null ? null : new Uint8Array(expectedBytes);
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the size classification */ }
        return { ok: false, reason: "too_large" };
      }
      if (buffer !== null) buffer.set(value, totalBytes - value.byteLength);
      else chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (buffer === null) {
    buffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else if (totalBytes !== buffer.byteLength) {
    buffer = buffer.slice(0, totalBytes);
  }
  try {
    const value = JSON.parse(decoder.decode(buffer));
    buffer = new Uint8Array(0);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

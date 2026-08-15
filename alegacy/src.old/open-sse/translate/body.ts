/** Result of bounded body reading, distinguishing oversized from malformed JSON. */
export type JsonBodyResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: "too_large" | "invalid" };

/** Result of bounded byte reading. */
export type BoundedBytesResult = { readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly reason: "too_large" | "invalid" };

/** Error raised by a bounded request stream once its byte limit is exceeded. */
export class BoundedBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BoundedBodyTooLargeError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Wraps a request body with a streaming byte limit, cancelling the source on overflow. */
export function boundedRequest(request: Request, maxBytes: number): Request {
  if (request.body === null) throw new Error("request body is missing");
  const reader = request.body.getReader();
  let totalBytes = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          release();
          controller.error(new BoundedBodyTooLargeError());
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!released) void reader.cancel(reason).finally(release);
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    duplex: "half",
  };
  return new Request(request.url, init);
}

/** Reads a bounded byte body, stopping and cancelling as soon as the limit is exceeded. */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<BoundedBytesResult> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) return { ok: false, reason: "too_large" };
  if (request.body === null) return { ok: false, reason: "invalid" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* preserve the size classification */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const value = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value };
}

/** Reads a bounded JSON body and parses it on Bun's async HTTP path. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const bytes = await readBoundedBytes(request, maxBytes);
  if (!bytes.ok) return bytes;
  try {
    return { ok: true, value: JSON.parse(decoder.decode(bytes.value)) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

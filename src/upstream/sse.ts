/**
 * SSE protocol-level encode/decode — no knowledge of OpenAI/Anthropic event
 * shapes here, just the `event: X\ndata: Y\n\n` wire format (RFC-ish, as
 * used by both providers).
 */

export interface SSEFrame {
  event?: string;
  data: string;
}

/** Parse a raw SSE byte stream into frames, one at a time, as bytes arrive. */
/** Stream stall timeout — abort if no chunk received within this window (C4). */
const STREAM_STALL_TIMEOUT_MS = 360_000; // 6 minutes

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastChunkTime = Date.now();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    lastChunkTime = Date.now();
    stallTimer = setTimeout(() => {
      const elapsed = Date.now() - lastChunkTime;
      if (elapsed >= STREAM_STALL_TIMEOUT_MS) {
        reader.cancel("stream stall timeout").catch(() => {});
      }
    }, STREAM_STALL_TIMEOUT_MS);
  };

  try {
    resetStallTimer();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStallTimer();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line (\n\n or \r\n\r\n).
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawFrame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
      }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SSEFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.startsWith("event:")) event = clean.slice(6).trim();
    else if (clean.startsWith("data:")) dataLines.push(clean.slice(5).trimStart());
  }

  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

export function formatSSEFrame(frame: SSEFrame): string {
  const eventLine = frame.event !== undefined ? `event: ${frame.event}\n` : "";
  return `${eventLine}data: ${frame.data}\n\n`;
}

export function sseDataOnly(data: unknown): string {
  return formatSSEFrame({ event: undefined, data: JSON.stringify(data) });
}

export const SSE_DONE = "data: [DONE]\n\n";

/** Turn an AsyncGenerator of already-formatted SSE text frames into a ReadableStream<Uint8Array>, for Elysia to hand back as the response body. */
export function toSSEResponseStream(frames: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await frames.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await frames.return(undefined);
    },
  });
}

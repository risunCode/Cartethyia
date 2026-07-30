import { formatSSEFrame } from "../upstream/sse";

export interface SseSender {
  send(event: string, data: unknown): void;
}

/** Register endpoint-specific SSE subscriptions; return their teardown callback. */
export type SseSetup = (sender: SseSender) => () => void;

/**
 * Create a console SSE response stream with uniform JSON event encoding,
 * 25-second proxy heartbeat, and abort/cancel cleanup.
 */
export function createConsoleSseStream(signal: AbortSignal, setup: SseSetup): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanupSubscription: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let close: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const sender: SseSender = {
        send(event, data) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(formatSSEFrame({ event, data: JSON.stringify(data) })));
          } catch {
            close?.();
          }
        },
      };

      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        cleanupSubscription?.();
        try {
          controller.close();
        } catch {
          // Stream may already be closed by the runtime.
        }
      };

      cleanupSubscription = setup(sender);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close?.();
        }
      }, 25_000);

      if (signal.aborted) {
        close();
        return;
      }
      signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      close?.();
    },
  });
}

/** Standard response wrapper for console SSE endpoints. */
export function consoleSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Minimal SSE framing + stream helper for console live endpoints. The gateway
 * already speaks SSE to inference clients; this is the same wire shape
 * (named `event:`, JSON `data:`) pointed at the dashboard instead.
 */

export interface SseSender {
  send(event: string, data: unknown): void;
}

/** Register endpoint-specific SSE subscriptions; return their teardown callback. */
export type SseSetup = (sender: SseSender) => () => void;

export function formatSseFrame(event: string, json: string): string {
  return `event: ${event}\ndata: ${json}\n\n`;
}

/**
 * Heartbeat cadence. The listener idles at 60s, so a comment frame every 25s
 * keeps SSE connections alive through proxies and idle-timeout sweeps.
 */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Console SSE response stream with uniform JSON event encoding, heartbeat,
 * and abort/cancel cleanup. The setup callback runs synchronously at stream
 * start so the initial snapshot is enqueued before the first read.
 */
export function createConsoleSseStream(
  signal: AbortSignal,
  setup: SseSetup,
): ReadableStream<Uint8Array> {
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
            controller.enqueue(encoder.encode(formatSseFrame(event, JSON.stringify(data))));
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

      if (signal.aborted) {
        close();
        return;
      }
      cleanupSubscription = setup(sender);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close?.();
        }
      }, SSE_HEARTBEAT_MS);

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
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

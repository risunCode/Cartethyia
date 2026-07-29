/**
 * Console logs API — ring buffer snapshot/clear + SSE live stream (REQ-6).
 *
 * SSE events: `init` (full snapshot), `line` (single entry), `clear`.
 * A 25s `ping` comment keeps proxies from closing the idle connection.
 */

import { Elysia } from "elysia";
import {
  getConsoleLogSnapshot,
  clearConsoleLogs,
  subscribeConsoleLogs,
  type ConsoleLogEvent,
} from "../logs/ring";
import { addAuditEvent } from "../db/repos/audit";

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createLogStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEncode(event, data)));
        } catch {
          closed = true;
        }
      };

      unsubscribe = subscribeConsoleLogs((evt: ConsoleLogEvent) => {
        if (evt.type === "init") send("init", { lines: evt.lines });
        else if (evt.type === "line") send("line", evt.line);
        else send("clear", {});
      });

      // Heartbeat keeps intermediaries from timing out the stream.
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 25_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed/errored — fine
        }
      };

      if (signal.aborted) {
        cleanup();
        return;
      }
      signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      clearInterval(timer);
      if (unsubscribe) unsubscribe();
    },
  });
}

export const logsRoutes = new Elysia({ prefix: "/console/api" })
  .get("/console-logs", () => ({ lines: getConsoleLogSnapshot() }))
  .delete("/console-logs", () => {
    clearConsoleLogs();
    addAuditEvent("console_logs.cleared", {});
    return { ok: true };
  })
  .get("/console-logs/stream", ({ request }) => {
    const stream = createLogStream(request.signal);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

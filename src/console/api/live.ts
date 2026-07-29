/**
 * Live in-flight request count — SSE stream mirroring `console-logs`'s
 * pattern (init snapshot + push-on-change + 25s heartbeat ping).
 */

import { Elysia } from "elysia";
import { getInFlightCount, subscribeInFlight } from "../tracking/in-flight";
import { activeFlights } from "../../http/traffic";
import { getRuntimeSettings } from "../runtime";

/**
 * Per-IP breakdown (REQ-9 follow-up) — `activeFlights` is the SAME tracker
 * `createRequestTrafficMiddleware` enforces `maxFlightsPerIp` against, so
 * this makes that setting's effect observable instead of a number nobody
 * can verify is doing anything.
 */
function byIpSnapshot() {
  return { byIp: activeFlights.snapshot(), maxFlightsPerIp: getRuntimeSettings().maxFlightsPerIp };
}

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createInFlightStream(signal: AbortSignal): ReadableStream<Uint8Array> {
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

      send("count", { inFlight: getInFlightCount(), ...byIpSnapshot() });
      unsubscribe = subscribeInFlight((count) => send("count", { inFlight: count, ...byIpSnapshot() }));

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

export const liveRoutes = new Elysia({ prefix: "/console/api" })
  .get("/live/in-flight", () => ({ inFlight: getInFlightCount(), ...byIpSnapshot() }))
  .get("/live/in-flight/stream", ({ request }) => {
    const stream = createInFlightStream(request.signal);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

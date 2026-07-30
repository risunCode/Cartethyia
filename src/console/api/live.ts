/**
 * Live in-flight request count — SSE stream mirroring `console-logs`'s
 * pattern (init snapshot + push-on-change + 25s heartbeat ping).
 */

import { Elysia } from "elysia";
import { getInFlightCount, subscribeInFlight } from "../tracking/in-flight";
import { activeFlights } from "../../http/traffic";
import { getRuntimeSettings } from "../runtime";
import { consoleSseResponse, createConsoleSseStream } from "../sse";

/**
 * Per-IP breakdown (REQ-9 follow-up) — `activeFlights` is the SAME tracker
 * `createRequestTrafficMiddleware` enforces `maxFlightsPerIp` against, so
 * this makes that setting's effect observable instead of a number nobody
 * can verify is doing anything.
 */
function byIpSnapshot() {
  return { byIp: activeFlights.snapshot(), maxFlightsPerIp: getRuntimeSettings().maxFlightsPerIp };
}


export const liveRoutes = new Elysia({ prefix: "/console/api" })
  .get("/live/in-flight", () => ({ inFlight: getInFlightCount(), ...byIpSnapshot() }))
  .get("/live/in-flight/stream", ({ request }) => consoleSseResponse(
    createConsoleSseStream(request.signal, ({ send }) => {
      send("count", { inFlight: getInFlightCount(), ...byIpSnapshot() });
      return subscribeInFlight((count) => send("count", { inFlight: count, ...byIpSnapshot() }));
    }),
  ));

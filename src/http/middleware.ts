/** Request logging plus privacy-safe per-IP active-flight control. */

import { Elysia } from "elysia";
import { config } from "../config";
import { flightLimitError } from "./errors";
import { activeFlights, identifyClient, isFlightRejection } from "./traffic";

interface ActiveRequest {
  identity: ReturnType<typeof identifyClient>;
  permit: { ip: string; active: number } | undefined;
  startedAt: number;
}

export interface TrafficControlOptions {
  maxFlightsPerIp: number;
  trustProxy: boolean;
}

/**
 * Observes a client without logging credentials or raw fingerprint headers,
 * then limits only `/v1/*` by active flights per resolved IP. `onAfterResponse`
 * releases the permit after an SSE response closes too, so a live stream holds
 * its concurrency slot for its actual lifetime.
 */
export function createRequestTrafficMiddleware(options: TrafficControlOptions, tracker = activeFlights) {
  const activeRequests = new WeakMap<Request, ActiveRequest>();
  return new Elysia()
    .onBeforeHandle({ as: "global" }, ({ request, server, set }) => {
      const url = new URL(request.url);
      const directIp = server?.requestIP(request)?.address;
      const identity = identifyClient(request.headers, directIp, options.trustProxy);
      const isLimitedRoute = url.pathname.startsWith("/v1/") && options.maxFlightsPerIp > 0;

      if (!isLimitedRoute) {
        activeRequests.set(request, { identity, permit: undefined, startedAt: performance.now() });
        return;
      }

      const result = tracker.acquire(identity.ip, options.maxFlightsPerIp);
      if (isFlightRejection(result)) {
        set.status = 429;
        return flightLimitError(url.pathname, result.active, result.limit);
      }
      activeRequests.set(request, { identity, permit: result, startedAt: performance.now() });
    })
    .onAfterResponse({ as: "global" }, ({ request, set }) => {
      const active = activeRequests.get(request);
      if (!active) return;
      activeRequests.delete(request);
      if (active.permit) tracker.release(active.permit);

      const durationMs = performance.now() - active.startedAt;
      const url = new URL(request.url);
      console.log(`${request.method} ${url.pathname} ${set.status ?? 200} ${durationMs.toFixed(1)}ms ip=${active.identity.ip} fp=${active.identity.fingerprint} client=${active.identity.client}`);
    });
}

export const requestLogger = createRequestTrafficMiddleware(config.traffic);

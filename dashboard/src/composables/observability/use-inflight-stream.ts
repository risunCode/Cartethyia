/**
 * useInFlightStream — EventSource hook for /console/api/live/in-flight/stream.
 * Mirrors useConsoleLogStream's backoff (1s→2s→…→30s); native EventSource
 * handles SSE framing + sends the session cookie same-origin.
 */

import { createSignal, onCleanup, type Accessor } from "solid-js";

const STREAM_URL = "/console/api/live/in-flight/stream";

export type InFlightStreamStatus = "connected" | "connecting" | "error";

export interface InFlightSnapshot {
  inFlight: number;
  /** Every IP with an active flight right now, busiest first — the same tracker `maxFlightsPerIp` is enforced against. */
  byIp: Array<{ ip: string; active: number }>;
  /** Providers with an active upstream call, busiest first. */
  byProvider: Array<{ providerId: string; active: number }>;
  maxFlightsPerIp: number;
  connectionStatus: InFlightStreamStatus;
}

const EMPTY: InFlightSnapshot = { inFlight: 0, byIp: [], byProvider: [], maxFlightsPerIp: 0, connectionStatus: "connecting" };

export function useInFlightSnapshot(): Accessor<InFlightSnapshot> {
  const [snapshot, setSnapshot] = createSignal<InFlightSnapshot>(EMPTY);
  let attempts = 0;
  let pendingData: Omit<InFlightSnapshot, "connectionStatus"> | null = null;
  let rafId: number | null = null;

  let disposed = false;
  let timer: number | undefined;
  let source: EventSource | null = null;

  const flush = () => {
      rafId = null;
      const data = pendingData;
      if (data === null) return;
      pendingData = null;
      setSnapshot({ ...data, connectionStatus: "connected" as const });
      attempts = 0;
    };

    const scheduleFlush = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flush);
    };

  const connect = () => {
      if (disposed) return;
      setSnapshot((current) => ({ ...current, connectionStatus: "connecting" as const }));
      const es = new EventSource(STREAM_URL, { withCredentials: true });
      source = es;
      es.onopen = () => setSnapshot((current) => ({ ...current, connectionStatus: "connected" as const }));

      es.addEventListener("count", (event) => {
        const data = JSON.parse((event as MessageEvent).data as string) as Omit<InFlightSnapshot, "connectionStatus">;
        pendingData = data;
        scheduleFlush();
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setSnapshot((current) => ({ ...current, connectionStatus: "error" as const }));
        const delay = Math.min(1000 * 2 ** attempts, 30_000);
        attempts += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

  connect();
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
    source?.close();
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  return snapshot;
}

/** Global in-flight count only — the common case for stat-card badges. */
export function useInFlightStream(): Accessor<number> {
  const snapshot = useInFlightSnapshot();
  return () => snapshot().inFlight;
}

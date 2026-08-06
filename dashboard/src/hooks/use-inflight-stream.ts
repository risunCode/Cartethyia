/**
 * useInFlightStream — EventSource hook for /console/api/live/in-flight/stream.
 * Mirrors useConsoleLogStream's backoff (1s→2s→…→30s); native EventSource
 * handles SSE framing + sends the session cookie same-origin.
 */

import { useEffect, useRef, useState } from "react";

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

export function useInFlightSnapshot(): InFlightSnapshot {
  const [snapshot, setSnapshot] = useState<InFlightSnapshot>(EMPTY);
  const attemptsRef = useRef(0);
  const pendingDataRef = useRef<Omit<InFlightSnapshot, "connectionStatus"> | null>(null);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let source: EventSource | null = null;

    const flush = () => {
      rafIdRef.current = null;
      const data = pendingDataRef.current;
      if (data === null) return;
      pendingDataRef.current = null;
      setSnapshot({ ...data, connectionStatus: "connected" });
      attemptsRef.current = 0;
    };

    const scheduleFlush = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(flush);
    };

    const connect = () => {
      if (disposed) return;
      setSnapshot((current) => ({ ...current, connectionStatus: "connecting" }));
      const es = new EventSource(STREAM_URL, { withCredentials: true });
      source = es;
      es.onopen = () => setSnapshot((current) => ({ ...current, connectionStatus: "connected" }));

      es.addEventListener("count", (event) => {
        const data = JSON.parse((event as MessageEvent).data as string) as Omit<InFlightSnapshot, "connectionStatus">;
        pendingDataRef.current = data;
        scheduleFlush();
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setSnapshot((current) => ({ ...current, connectionStatus: "error" }));
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30_000);
        attemptsRef.current += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  return snapshot;
}

/** Global in-flight count only — the common case for stat-card badges. */
export function useInFlightStream(): number {
  return useInFlightSnapshot().inFlight;
}

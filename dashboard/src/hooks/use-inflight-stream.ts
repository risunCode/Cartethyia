/**
 * useInFlightStream — EventSource hook for /console/api/live/in-flight/stream.
 * Mirrors useConsoleLogStream's backoff (1s→2s→…→30s); native EventSource
 * handles SSE framing + sends the session cookie same-origin.
 */

import { useEffect, useRef, useState } from "react";

const STREAM_URL = "/console/api/live/in-flight/stream";

export interface InFlightSnapshot {
  inFlight: number;
  /** Every IP with an active flight right now, busiest first — the same tracker `maxFlightsPerIp` is enforced against. */
  byIp: Array<{ ip: string; active: number }>;
  maxFlightsPerIp: number;
}

const EMPTY: InFlightSnapshot = { inFlight: 0, byIp: [], maxFlightsPerIp: 0 };

export function useInFlightSnapshot(): InFlightSnapshot {
  const [snapshot, setSnapshot] = useState<InFlightSnapshot>(EMPTY);
  const attemptsRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let source: EventSource | null = null;

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(STREAM_URL, { withCredentials: true });
      source = es;

      es.addEventListener("count", (event) => {
        const data = JSON.parse((event as MessageEvent).data as string) as InFlightSnapshot;
        setSnapshot(data);
        attemptsRef.current = 0;
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
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
    };
  }, []);

  return snapshot;
}

/** Global in-flight count only — the common case for stat-card badges. */
export function useInFlightStream(): number {
  return useInFlightSnapshot().inFlight;
}

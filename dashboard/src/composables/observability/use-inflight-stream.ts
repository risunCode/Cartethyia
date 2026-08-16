/**
 * useInFlightStream — EventSource hook for /console/telemetry/in-flight/stream.
 * Mirrors useConsoleLogStream's backoff (1s→2s→…→30s); native EventSource
 * handles SSE framing + sends the session cookie same-origin.
 */

import { createSignal, onCleanup, type Accessor } from "solid-js";

const STREAM_URL = "/console/telemetry/in-flight/stream";

const SHARE_STREAM_MAX_DELAY = 30_000;

/** Lifecycle state for a public share in-flight stream. */
export type ShareInFlightStreamStatus = "disabled" | "connected" | "connecting" | "error";

/** Public stream state containing only the aggregate count and connection state. */
export interface ShareInFlightSnapshot {
  readonly inFlight: number | null;
  readonly connectionStatus: ShareInFlightStreamStatus;
}

const EMPTY_SHARE_SNAPSHOT: ShareInFlightSnapshot = { inFlight: null, connectionStatus: "connecting" };

/** Uses the live count only after a valid stream event; otherwise keeps polling data visible. */
export function resolveShareInFlight(snapshot: ShareInFlightSnapshot, fallback: number): number {
  return snapshot.connectionStatus === "connected" && snapshot.inFlight !== null ? snapshot.inFlight : fallback;
}

/** Parses the public share stream payload without accepting private tracker fields. */
export function parseShareInFlightPayload(payload: unknown): number | null {
  let value: unknown = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("inFlight" in value)) return null;
  const inFlight = value.inFlight;
  return typeof inFlight === "number" && Number.isSafeInteger(inFlight) && inFlight >= 0 ? inFlight : null;
}

/** Subscribes to a public share token's in-flight count stream without console credentials. */
export function useShareInFlightStream(token: string | null, enabled = true): Accessor<ShareInFlightSnapshot> {
  const [snapshot, setSnapshot] = createSignal<ShareInFlightSnapshot>(
    enabled && token !== null && token.length > 0 ? EMPTY_SHARE_SNAPSHOT : { inFlight: null, connectionStatus: "disabled" },
  );
  let attempts = 0;
  let pendingInFlight: number | null = null;
  let rafId: number | null = null;
  let disposed = false;
  let retryTimer: number | undefined;
  let source: EventSource | null = null;

  const flush = (): void => {
    rafId = null;
    if (pendingInFlight === null || disposed) return;
    const inFlight = pendingInFlight;
    pendingInFlight = null;
    setSnapshot({ inFlight, connectionStatus: "connected" });
    attempts = 0;
  };

  const scheduleFlush = (): void => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(flush);
  };

  const connect = (): void => {
    if (disposed || !enabled || token === null || token.length === 0) return;
    retryTimer = undefined;
    setSnapshot((current) => ({ ...current, inFlight: null, connectionStatus: "connecting" }));
    const eventSource = new EventSource(`/share/${encodeURIComponent(token)}/stream`, { withCredentials: false });
    source = eventSource;
    eventSource.onopen = () => {
      if (!disposed) setSnapshot((current) => ({ ...current, connectionStatus: "connected" }));
    };
    eventSource.addEventListener("count", (event) => {
      const inFlight = parseShareInFlightPayload((event as MessageEvent<string>).data);
      if (inFlight === null) return;
      pendingInFlight = inFlight;
      scheduleFlush();
    });
    eventSource.onerror = () => {
      eventSource.close();
      if (disposed) return;
      pendingInFlight = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      setSnapshot({ inFlight: null, connectionStatus: "error" });
      if (retryTimer !== undefined) return;
      const delay = Math.min(1000 * 2 ** attempts, SHARE_STREAM_MAX_DELAY);
      attempts += 1;
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();
  onCleanup(() => {
    disposed = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    source?.close();
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  return snapshot;
}

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

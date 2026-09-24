import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest, isRecord } from "../api";
import { queryKeys } from "../query-keys";

export interface InFlightState {
  /** Latest live count, or null before the first snapshot arrives. */
  readonly count: number | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

function readCount(payload: unknown): number | null {
  if (isRecord(payload) && typeof payload.inFlight === "number" && Number.isFinite(payload.inFlight)) {
    return Math.max(0, Math.floor(payload.inFlight));
  }
  return null;
}

const STREAM_RETRY_MS = 5_000;

/**
 * Live in-flight proxy request count over the console SSE stream
 * (`GET /live/in-flight/stream`, `count` events). Opens with an
 * authenticated snapshot fetch — so a dead session bounces to login through
 * the shell's normal 401 handling instead of spinning a retry loop — then
 * keeps the stream open; on transport failure it re-snapshots and re-opens
 * after a short delay.
 */
export function useInFlight(): InFlightState {
  const [count, setCount] = useState<number | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const openStream = () => {
      source = new EventSource("/console/api/live/in-flight/stream");
      source.addEventListener("count", (event) => {
        if (stopped) return;
        try {
          const next = readCount(JSON.parse((event as MessageEvent).data as string));
          if (next !== null) {
            setCount(next);
            setLive(true);
          }
        } catch {
          // Malformed frame: keep the last good value.
        }
      });
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        setLive(false);
        retryTimer = setTimeout(() => {
          if (!stopped) void snapshotThenStream();
        }, STREAM_RETRY_MS);
      };
    };

    const snapshotThenStream = async () => {
      try {
        const snapshot = await consoleRequest<unknown>("/live/in-flight");
        if (stopped) return;
        const next = readCount(snapshot);
        if (next !== null) setCount(next);
        openStream();
      } catch {
        // Unauthenticated (shell handles the transition) or offline: stay stale.
      }
    };

    void snapshotThenStream();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return { count, live };
}

export interface PoolUsageRow {
  readonly poolId: string;
  readonly currentInflight: number;
}

export interface PoolUsageState {
  /** Latest per-pool usage rows, or null before the first snapshot arrives. */
  readonly pools: readonly PoolUsageRow[] | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

function readPools(payload: unknown): readonly PoolUsageRow[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.pools)) return null;
  const rows: PoolUsageRow[] = [];
  for (const raw of payload.pools) {
    if (!isRecord(raw) || typeof raw.poolId !== "string") continue;
    const currentInflight = typeof raw.currentInflight === "number" && Number.isFinite(raw.currentInflight)
      ? Math.max(0, Math.floor(raw.currentInflight))
      : 0;
    rows.push({ poolId: raw.poolId, currentInflight });
  }
  return rows;
}

const POOL_STREAM_RETRY_MS = 5_000;

/**
 * Live per-pool proxy usage over the console SSE stream
 * (`GET /live/pools/stream`, `pools` events). Same open pattern as
 * `useInFlight`: authenticated snapshot first, then the stream, with
 * re-snapshot + re-open on transport failure. Rows cover only pools with an
 * active slot — an idle pool reads as absent (zero), keyed by pool id so the
 * Proxy page can join against its pool list.
 */
export function usePoolUsage(): PoolUsageState {
  const queryClient = useQueryClient();
  const [pools, setPools] = useState<readonly PoolUsageRow[] | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const openStream = () => {
      source = new EventSource("/console/api/live/pools/stream");
      source.addEventListener("pools", (event) => {
        if (stopped) return;
        try {
          const next = readPools(JSON.parse((event as MessageEvent).data as string));
          if (next !== null) {
            setPools(next);
            setLive(true);
          }
        } catch {
          // Malformed frame: keep the last good value.
        }
      });
      source.addEventListener("health", () => {
        if (!stopped) void queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
      });
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        setLive(false);
        retryTimer = setTimeout(() => {
          if (!stopped) void snapshotThenStream();
        }, POOL_STREAM_RETRY_MS);
      };
    };

    const snapshotThenStream = async () => {
      try {
        const snapshot = await consoleRequest<unknown>("/live/pools");
        if (stopped) return;
        const next = readPools(snapshot);
        if (next !== null) setPools(next);
        openStream();
      } catch {
        // Unauthenticated (shell handles the transition) or offline: stay stale.
      }
    };

    void snapshotThenStream();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);

  return { pools, live };
}

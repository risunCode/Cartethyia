import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest, isRecord } from "../data/api";
import { queryKeys } from "../data/query-keys";
import { STREAM_RETRY_MS } from "../shared/constants";

export interface InFlightState {
  /** Latest live count, or null before the first snapshot arrives. */
  readonly count: number | null;
  /** Unique client IPs behind the live count, or null before arrival. */
  readonly uniqueIps: number | null;
  /** True while the SSE stream is open and pushing. */
  readonly live: boolean;
}

function readSnapshot(payload: unknown): { count: number; uniqueIps: number } | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.inFlight !== "number" || !Number.isFinite(payload.inFlight)) return null;
  const count = Math.max(0, Math.floor(payload.inFlight));
  // Older gateways send no `uniqueIps`: fall back to the count so the pill
  // still renders instead of sticking at its loading state.
  const uniqueIps =
    typeof payload.uniqueIps === "number" && Number.isFinite(payload.uniqueIps)
      ? Math.max(0, Math.min(count, Math.floor(payload.uniqueIps)))
      : count;
  return { count, uniqueIps };
}

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
  const [uniqueIps, setUniqueIps] = useState<number | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;

    const connect = async () => {
      const currentGeneration = ++generation;
      try {
        const snapshot = await consoleRequest<unknown>("/live/in-flight");
        if (stopped || currentGeneration !== generation) return;
        const next = readSnapshot(snapshot);
        if (next !== null) {
          setCount(next.count);
          setUniqueIps(next.uniqueIps);
        }

        const nextSource = new EventSource("/console/api/live/in-flight/stream");
        source = nextSource;
        nextSource.addEventListener("count", (event) => {
          if (stopped || currentGeneration !== generation) return;
          try {
            const seen = readSnapshot(JSON.parse((event as MessageEvent).data as string));
            if (seen !== null) {
              setCount(seen.count);
              setUniqueIps(seen.uniqueIps);
              setLive(true);
            }
          } catch {
            // Malformed frame: keep the last good value.
          }
        });
        nextSource.onerror = () => {
          if (stopped || currentGeneration !== generation) return;
          nextSource.close();
          if (source === nextSource) source = undefined;
          setLive(false);
          retryTimer = setTimeout(() => {
            if (!stopped) void connect();
          }, STREAM_RETRY_MS);
        };
      } catch {
        // Unauthenticated (shell handles the transition) or offline: retry after a delay.
        if (!stopped && currentGeneration === generation) {
          setLive(false);
          retryTimer = setTimeout(() => {
            if (!stopped) void connect();
          }, STREAM_RETRY_MS);
        }
      }
    };

    void connect();
    return () => {
      stopped = true;
      generation += 1;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return { count, uniqueIps, live };
}

export interface PoolUsageRow {
  readonly poolId: string;
  readonly currentInflight: number;
  /** Wire bytes the pool has carried since this process started. */
  readonly bytesSent: number;
  readonly bytesReceived: number;
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
    const bytes = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    rows.push({
      poolId: raw.poolId,
      currentInflight,
      bytesSent: bytes(raw.bytesSent),
      bytesReceived: bytes(raw.bytesReceived),
    });
  }
  return rows;
}

/**
 * Hard bound on remembered per-pool byte peaks.
 *
 * Neither `pools` frame is a complete list of the tenant's configured pools:
 * `NetworkPoolSelector.snapshotPoolUsage()` only rows pools that currently hold
 * a slot (an idle pool drops out on release) and the live route unions that
 * with the byte-accounting map. Entries therefore cannot be pruned against a
 * snapshot without snapping a legitimately idle pool's peak to 0B — which is
 * exactly what this map exists to prevent. Bound it the way
 * `enforceInflightLimit` bounds the backend's inflight map instead: evict
 * oldest-inserted entries past the cap.
 */
export const MAX_TRACKED_POOL_PEAKS = 500;

function enforcePeakLimit(peaks: Map<string, PoolUsageRow>): void {
  while (peaks.size > MAX_TRACKED_POOL_PEAKS) {
    const oldest = peaks.keys().next().value;
    if (oldest === undefined) break;
    peaks.delete(oldest);
  }
}

/**
 * Folds one frame of pool rows into the remembered peaks and returns the rows
 * to render. Shared by the snapshot fetch and the stream so both paths get the
 * same merge and the same bound.
 */
export function mergePools(
  peaks: Map<string, PoolUsageRow>,
  parsed: readonly PoolUsageRow[],
): PoolUsageRow[] {

  const present = new Set<string>();
  const next: PoolUsageRow[] = [];
  for (const row of parsed) {
    present.add(row.poolId);
    const prev = peaks.get(row.poolId);
    const merged: PoolUsageRow = prev
      ? {
          poolId: row.poolId,
          currentInflight: row.currentInflight,
          bytesSent: Math.max(prev.bytesSent, row.bytesSent),
          bytesReceived: Math.max(prev.bytesReceived, row.bytesReceived),
        }
      : row;
    peaks.set(row.poolId, merged);
    next.push(merged);
  }
  enforcePeakLimit(peaks);
  // Pools that dropped out of this frame keep their last max (union is backend-driven; this is the frontend guard).
  for (const [poolId, prev] of peaks) {
    if (!present.has(poolId)) next.push(prev);
  }
  return next;
}

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
  const maxBytesByPool = useState(() => new Map<string, PoolUsageRow>())[0];

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const openStream = () => {
      source = new EventSource("/console/api/live/pools/stream");
      source.addEventListener("pools", (event) => {
        if (stopped) return;
        try {
          const parsed = readPools(JSON.parse((event as MessageEvent).data as string));
          if (parsed !== null) {
            // Keep the highest bytesSent/received seen per pool so a reconnect
            // that temporarily yields an empty snapshot does not snap the bar to 0B.
            setPools(mergePools(maxBytesByPool, parsed));
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
        }, STREAM_RETRY_MS);
      };
    };

    const snapshotThenStream = async () => {
      try {
        const snapshot = await consoleRequest<unknown>("/live/pools");
        if (stopped) return;
        const parsed2 = readPools(snapshot);
        if (parsed2 !== null) {
          setPools(mergePools(maxBytesByPool, parsed2));
        }
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

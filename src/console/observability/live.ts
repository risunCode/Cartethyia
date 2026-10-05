// Live domain: process-local in-flight proxy request count, read from the
// request state store's admission funnel (`transport/request/inflight`), plus
// per-pool inflight usage from `NetworkPoolSelector` and tenant-filtered pool
// health notifications. The streams push changes with a heartbeat; health data
// is joined to the owning tenant before it leaves the process.
//
// Every endpoint requires `dashboard:read`. The global request count is
// process-level; pool usage and health are filtered to the caller's tenant.

import { Elysia } from "elysia";
import { errorResponse, requireScope } from "../shared/errors";
import type { ConsoleAccessResolver } from "../auth/access";
import type { ProxyRequestStateStore } from "../../transport/request/state";
import type { InFlightSnapshot } from "../../transport/request/inflight";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { networkPools } from "../../persistence/schema";
import { subscribePoolHealth } from "../../network/pool-health-machine";
import { poolByteSnapshot } from "../../network/pool/byte-accounting";
import { consoleSseResponse, createConsoleSseStream } from "./sse";

export interface LiveConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly poolSelector?: NetworkPoolSelector;
  readonly db?: CartethyiaDatabase;
  /**
   * Owns the live in-flight gauge. Optional so reduced compositions (route-only
   * shell, console stubs) mount the pool/health endpoints without the gauge;
   * absent means the in-flight endpoints report zero rather than failing.
   */
  readonly stateStore?: ProxyRequestStateStore;
}

const EMPTY_IN_FLIGHT: InFlightSnapshot = { inFlight: 0, uniqueIps: 0 };

async function tenantPoolIds(
  db: CartethyiaDatabase | undefined,
  tenantId: string | null,
): Promise<ReadonlySet<string> | undefined> {
  if (!db) return undefined;
  if (!tenantId) return new Set();
  const rows = await db.select({ id: networkPools.id }).from(networkPools).where(eq(networkPools.tenantId, tenantId));
  return new Set(rows.map((row) => row.id));
}
/**
 * Joins measured egress bytes onto the selector's usage rows.
 *
 * The selector only knows concurrency, and byte accounting lives outside it
 * (it is fed by the transport layer, not the scheduler), so the two are merged
 * at the edge. Pools that have carried no traffic yet are absent from the byte
 * snapshot and read as zero.
 */
function withPoolBytes<T extends { poolId: string; currentInflight?: number }>(
  pools: readonly T[],
): ReadonlyArray<T & { bytesSent: number; bytesReceived: number }> {
  const bytes = new Map(poolByteSnapshot().map((row) => [row.poolId, row]));
  // `snapshotPoolUsage()` only rows pools that currently hold a slot; an idle
  // pool therefore drops out of the map and would read as 0B even though it
  // already carried traffic this process. Union the byte snapshot so a pool
  // that has bytes but no inflight still appears with its running total.
  const merged = new Map<string, T>();
  for (const pool of pools) merged.set(pool.poolId, pool);
  for (const [poolId] of bytes) {
    if (!merged.has(poolId)) {
      merged.set(poolId, { poolId, currentInflight: 0 } as unknown as T);
    }
  }
  return [...merged.values()].map((pool) => {
    const row = bytes.get(pool.poolId);
    return { ...pool, bytesSent: row?.sent ?? 0, bytesReceived: row?.received ?? 0 };
  });
}

export function createLiveRoutes(config: LiveConfig): Elysia {
  return new Elysia()
    .get("/live/in-flight", ({ request, set }) => {
      try {
        requireScope(config.accessResolver(request), "dashboard:read");
        return config.stateStore?.inFlightSnapshot() ?? EMPTY_IN_FLIGHT;
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
    })
    .get("/live/in-flight/stream", ({ request, set }) => {
      try {
        requireScope(config.accessResolver(request), "dashboard:read");
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
      return consoleSseResponse(
        createConsoleSseStream(request.signal, ({ send }) => {
          const store = config.stateStore;
          if (!store) {
            send("count", EMPTY_IN_FLIGHT);
            return () => {};
          }
          const unsubscribe = store.subscribeInFlight((snapshot) => send("count", snapshot));
          send("count", store.inFlightSnapshot());
          return unsubscribe;
        }),
      );
    })
    .get("/live/pools", async ({ request, set }) => {
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        const allowed = await tenantPoolIds(config.db, access.tenantId);
        const pools = withPoolBytes(config.poolSelector?.snapshotPoolUsage() ?? []);
        return { pools: allowed ? pools.filter((pool) => allowed.has(pool.poolId)) : pools };
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
    })
    .get("/live/pools/stream", async ({ request, set }) => {
      let tenantId: string | null;
      let allowed: ReadonlySet<string> | undefined;
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        tenantId = access.tenantId;
        allowed = await tenantPoolIds(config.db, tenantId);
      } catch (e) {
        return errorResponse(e, set, "Live operation failed");
      }
      const selector = config.poolSelector;
      return consoleSseResponse(
        createConsoleSseStream(request.signal, ({ send }) => {
          const sendUsage = (pools: readonly { poolId: string; currentInflight: number }[]) => {
            const merged = withPoolBytes(pools);
            send("pools", {
              pools: allowed ? merged.filter((pool) => allowed.has(pool.poolId)) : merged,
            });
          };
          sendUsage(selector?.snapshotPoolUsage() ?? []);
          const unsubscribeUsage = selector?.subscribePoolUsage(sendUsage);
          const unsubscribeHealth = subscribePoolHealth((pool) => {
            if (pool.tenantId === tenantId) send("health", pool);
          });
          return () => {
            unsubscribeUsage?.();
            unsubscribeHealth();
          };
        }),
      );
    }) as unknown as Elysia;
}

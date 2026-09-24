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
import { getInFlightCount, subscribeInFlight } from "../../transport/request/inflight";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { networkPools } from "../../persistence/schema";
import { subscribePoolHealth } from "../../network/pool-health-machine";
import { consoleSseResponse, createConsoleSseStream } from "./sse/routes";

export interface LiveConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly poolSelector?: NetworkPoolSelector;
  readonly db?: CartethyiaDatabase;
}

async function tenantPoolIds(
  db: CartethyiaDatabase | undefined,
  tenantId: string | null,
): Promise<ReadonlySet<string> | undefined> {
  if (!db) return undefined;
  if (!tenantId) return new Set();
  const rows = await db.select({ id: networkPools.id }).from(networkPools).where(eq(networkPools.tenantId, tenantId));
  return new Set(rows.map((row) => row.id));
}
export function createLiveRoutes(config: LiveConfig): Elysia {
  return new Elysia()
    .get("/live/in-flight", ({ request, set }) => {
      try {
        requireScope(config.accessResolver(request), "dashboard:read");
        return { inFlight: getInFlightCount() };
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
          send("count", { inFlight: getInFlightCount() });
          return subscribeInFlight((inFlight) => send("count", { inFlight }));
        }),
      );
    })
    .get("/live/pools", async ({ request, set }) => {
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        const allowed = await tenantPoolIds(config.db, access.tenantId);
        const pools = config.poolSelector?.snapshotPoolUsage() ?? [];
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
          const sendUsage = (pools: readonly { poolId: string; currentInflight: number }[]) =>
            send("pools", {
              pools: allowed ? pools.filter((pool) => allowed.has(pool.poolId)) : pools,
            });
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

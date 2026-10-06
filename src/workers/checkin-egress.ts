/**
 * Per-account egress rotation for the daily check-in ride-along.
 *
 * The check-in hits the provider's billing facade once per account per day.
 * Sending every account through the same direct egress gives them all one
 * source IP; some facades rate-limit or flag that shape. When network pools
 * are available, each account rotates to a different pool so the check-ins
 * spread across IPs. When there are fewer pools than accounts — or none at
 * all — the rotation simply wraps and repeats; a repeated IP is accepted, an
 * unattempted check-in is not.
 *
 * Pools are tenant-scoped, and quota sweep targets carry their tenant in
 * `tenantId`. A pool row with a null tenant is the global set; anything else
 * belongs to its tenant and is never borrowed across tenants.
 */
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { networkPools } from "../persistence/schema";
import type { ValidatedFetch } from "../network/outbound-fetch";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";

/**
 * Builds the per-account fetcher for one quota-sweep pass.
 *
 * Lists active pools once per pass (not per account), then hands each account
 * the next pool in rotation. Accounts whose tenant has no active pool fall
 * back to direct egress — the same path the sweep used before this existed.
 */
export function checkinEgressForPass(args: {
  readonly db: CartethyiaDatabase;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
}): (accountId: string, tenantId?: string | null) => Promise<ValidatedFetch> {
  const { db, networkBindingFactory } = args;
  let poolsPromise: Promise<readonly { id: string; tenantId: string | null }[]> | undefined;

  const activePools = (): Promise<readonly { id: string; tenantId: string | null }[]> => {
    // A table that cannot even be read (down DB, bad shape) yields the same
    // answer as an empty one: direct egress. A `try` that threw synchronously
    // would escape as a rejection; `Promise.resolve().then` folds both into
    // the same `.catch`.
    poolsPromise ??= Promise.resolve()
      .then(() =>
        db
          .select({ id: networkPools.id, tenantId: networkPools.tenantId })
          .from(networkPools)
          .where(eq(networkPools.status, "active")),
      )
      .then((rows) => rows)
      .catch(() => []);
    return poolsPromise;
  };

  // Rotation cursor per tenant, so two tenants sharing the global pools still
  // spread independently instead of marching in lockstep.
  const cursors = new Map<string, number>();

  return async (accountId: string, tenantId?: string | null) => {
    void accountId;
    const pools = await activePools();
    const global = pools.filter((pool) => pool.tenantId === null);
    const owned =
      tenantId === undefined || tenantId === null
        ? []
        : pools.filter((pool) => pool.tenantId === tenantId);
    const candidates = [...owned, ...global];
    if (candidates.length === 0) return globalThis.fetch;
    const cursorKey = tenantId ?? "global";
    const cursor = cursors.get(cursorKey) ?? 0;
    const pool = candidates[cursor % candidates.length]!;
    cursors.set(cursorKey, cursor + 1);
    try {
      return networkBindingFactory.fetch(pool.id, tenantId ?? undefined);
    } catch {
      return globalThis.fetch;
    }
  };
}

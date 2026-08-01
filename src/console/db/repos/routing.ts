/** Provider routing config repo — strategy/sticky per provider (REQ-11). */

import { getDb } from "../client";
import { TtlCache } from "../ttl-cache";

export type RoutingStrategy = "priority" | "round-robin";

export interface ProviderRoutingRow {
  provider: string;
  strategy: string;
  sticky_limit: number;
  updated_at: string;
}

export interface ProviderRouting {
  provider: string;
  strategy: RoutingStrategy;
  stickyLimit: number;
  updatedAt: string;
}

const DEFAULTS: Omit<ProviderRouting, "provider" | "updatedAt"> = {
  strategy: "priority",
  stickyLimit: 0,
};

function fromRow(row: ProviderRoutingRow): ProviderRouting {
  return {
    provider: row.provider,
    strategy: (row.strategy === "round-robin" ? "round-robin" : "priority") as RoutingStrategy,
    stickyLimit: row.sticky_limit,
    updatedAt: row.updated_at,
  };
}

// getProviderRouting is read on every proxied request to pick a rotation
// strategy/sticky limit. 5s TTL, cleared immediately on upsertProviderRouting.
const routingCache = new TtlCache<string, ProviderRouting>(5_000);

export function getProviderRouting(provider: string): ProviderRouting {
  return routingCache.get(provider, () => {
    const row = getDb().query("SELECT * FROM provider_routing WHERE provider = ?").get(provider) as ProviderRoutingRow | null;
    if (!row) return { provider, ...DEFAULTS, updatedAt: "" };
    return fromRow(row);
  });
}

export function upsertProviderRouting(
  provider: string,
  patch: Partial<Omit<ProviderRouting, "provider" | "updatedAt">>
): ProviderRouting {
  const current = getProviderRouting(provider);
  const next: ProviderRouting = {
    provider,
    strategy: patch.strategy ?? current.strategy,
    stickyLimit: patch.stickyLimit ?? current.stickyLimit,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .query(
      "INSERT INTO provider_routing (provider, strategy, sticky_limit, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET strategy = excluded.strategy, sticky_limit = excluded.sticky_limit, updated_at = excluded.updated_at"
    )
    .run(next.provider, next.strategy, next.stickyLimit, next.updatedAt);
  routingCache.clear();
  return next;
}

/** Test-only: drop the cached routing config so isolated test databases don't leak into each other. */
export function resetProviderRoutingCacheForTests(): void {
  routingCache.clear();
}

/** Provider routing config repo — strategy/sticky per provider (REQ-11). */

import { getDb } from "../client";
import { TtlCache } from "../ttl-cache";

export type RoutingStrategy = "priority" | "round-robin";

export interface ProviderRoutingRow {
  provider: string;
  strategy: string;
  sticky_limit: number;
  sticky_enabled: number;
  updated_at: string;
}

export interface ProviderRouting {
  provider: string;
  strategy: RoutingStrategy;
  stickyLimit: number;
  useStickyLimit: boolean;
  updatedAt: string;
}

const DEFAULTS: Omit<ProviderRouting, "provider" | "updatedAt"> = {
  strategy: "priority",
  stickyLimit: 1,
  useStickyLimit: false,
};

function fromRow(row: ProviderRoutingRow): ProviderRouting {
  return {
    provider: row.provider,
    strategy: (row.strategy === "round-robin" ? "round-robin" : "priority") as RoutingStrategy,
    stickyLimit: Math.max(1, Math.min(100, Math.round(row.sticky_limit ?? 1))),
    useStickyLimit: Boolean(row.sticky_enabled),
    updatedAt: row.updated_at,
  };
}

// getProviderRouting is read on every provider request to pick the account
// rotation strategy and sticky limit. 5s TTL, cleared immediately on upsertProviderRouting.
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
    stickyLimit: patch.stickyLimit === undefined ? current.stickyLimit : Math.max(1, Math.min(100, Math.round(patch.stickyLimit))),
    useStickyLimit: patch.useStickyLimit ?? current.useStickyLimit,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .query(
      "INSERT INTO provider_routing (provider, strategy, sticky_limit, sticky_enabled, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET strategy = excluded.strategy, sticky_limit = excluded.sticky_limit, sticky_enabled = excluded.sticky_enabled, updated_at = excluded.updated_at"
    )
    .run(next.provider, next.strategy, next.stickyLimit, next.useStickyLimit ? 1 : 0, next.updatedAt);
  routingCache.clear();
  return next;
}

/** Test-only: drop the cached routing config so isolated test databases don't leak into each other. */
export function resetProviderRoutingCacheForTests(): void {
  routingCache.clear();
}

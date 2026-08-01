/** Provider routing config repo — strategy/sticky per provider (REQ-11). */

import { getDb } from "../client";

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

export function getProviderRouting(provider: string): ProviderRouting {
  const row = getDb().query("SELECT * FROM provider_routing WHERE provider = ?").get(provider) as ProviderRoutingRow | null;
  if (!row) return { provider, ...DEFAULTS, updatedAt: "" };
  return fromRow(row);
}

export function listProviderRoutings(): ProviderRouting[] {
  const rows = getDb().query("SELECT * FROM provider_routing").all() as ProviderRoutingRow[];
  return rows.map(fromRow);
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
  return next;
}

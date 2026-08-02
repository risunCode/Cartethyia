/**
 * Global proxy pool settings - single row, mirrors `settings.ts`'s singleton
 * pattern. Distinct from `console/env.ts`'s `ProxyAuthMode` (how *this*
 * server authenticates inbound `/v1/*` callers) and from `routing.ts`'s
 * per-provider account rotation (which *credential* handles a request) -
 * this table controls which *network path* (direct vs. a pooled outbound
 * proxy) an outbound provider call takes.
 *
 * Selection is always priority order (auto-assigned by add order, see
 * `proxies.priority`) with failover to the next active, non-cooled-down
 * proxy - there is no separate strategy or sticky-affinity setting to configure.
 */

import { getDb } from "../client";
import { TtlCache } from "../ttl-cache";

export interface ProxyPoolSettingsRow {
  id: number;
  enabled: number;
  excluded_providers_json: string;
  smart_dynamic_routing: number;
  smart_dynamic_proxy_count: number;
  updated_at: string;
}

export interface ProxyPoolSettings {
  enabled: boolean;
  excludedProviders: string[];
  smartDynamicRouting: boolean;
  smartDynamicProxyCount: number;
  updatedAt: string;
}

const DEFAULTS: Omit<ProxyPoolSettings, "updatedAt"> = {
  enabled: false,
  excludedProviders: [],
  smartDynamicRouting: false,
  smartDynamicProxyCount: 2,
};

function fromRow(row: ProxyPoolSettingsRow): ProxyPoolSettings {
  return {
    enabled: Boolean(row.enabled),
    excludedProviders: JSON.parse(row.excluded_providers_json) as string[],
    smartDynamicRouting: Boolean(row.smart_dynamic_routing),
    smartDynamicProxyCount: Math.max(1, Math.min(10, row.smart_dynamic_proxy_count ?? 2)),
    updatedAt: row.updated_at,
  };
}

// Read on every proxied request to decide direct-vs-proxied dispatch. 5s TTL,
// cleared immediately on patchProxyPoolSettings.
const settingsCache = new TtlCache<"global", ProxyPoolSettings>(5_000);

export function getProxyPoolSettings(): ProxyPoolSettings {
  return settingsCache.get("global", () => {
    const row = getDb().query("SELECT * FROM proxy_settings WHERE id = 1").get() as ProxyPoolSettingsRow | null;
    return row ? fromRow(row) : { ...DEFAULTS, updatedAt: "" };
  });
}

export function patchProxyPoolSettings(patch: Partial<Omit<ProxyPoolSettings, "updatedAt">>): ProxyPoolSettings {
  const current = getProxyPoolSettings();
  const next: ProxyPoolSettings = {
    enabled: patch.enabled ?? current.enabled,
    excludedProviders: patch.excludedProviders ?? current.excludedProviders,
    smartDynamicRouting: patch.smartDynamicRouting ?? current.smartDynamicRouting,
    smartDynamicProxyCount: patch.smartDynamicProxyCount === undefined ? current.smartDynamicProxyCount : Math.max(1, Math.min(10, Math.round(patch.smartDynamicProxyCount))),
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .query(
      `INSERT INTO proxy_settings (id, enabled, excluded_providers_json, smart_dynamic_routing, smart_dynamic_proxy_count, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled,
         excluded_providers_json = excluded.excluded_providers_json,
         smart_dynamic_routing = excluded.smart_dynamic_routing,
         smart_dynamic_proxy_count = excluded.smart_dynamic_proxy_count,
         updated_at = excluded.updated_at`,
    )
    .run(next.enabled ? 1 : 0, JSON.stringify(next.excludedProviders), next.smartDynamicRouting ? 1 : 0, next.smartDynamicProxyCount, next.updatedAt);
  settingsCache.clear();
  return next;
}

/** True when the pool should be consulted for this provider - enabled, and not explicitly excluded. */
export function isProviderProxied(provider: string): boolean {
  const settings = getProxyPoolSettings();
  return settings.enabled && !settings.excludedProviders.includes(provider);
}

/** Clears the cached proxy routing settings after a restore or settings mutation. */
export function invalidateProxyPoolSettingsCache(): void {
  settingsCache.clear();
}

/** Test-only alias for isolated database tests. */
export function resetProxyPoolSettingsCacheForTests(): void {
  invalidateProxyPoolSettingsCache();
}

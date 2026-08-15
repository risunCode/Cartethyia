/**
 * Centralized Solid Query key factories.
 *
 * Every query/invalidation site in the dashboard should source its key from
 * here so that:
 *   1. the `queryKey` passed to `useQuery` and the one passed to
 *      `invalidateQueries` can never drift apart;
 *   2. renaming a key is a single-file change;
 *   3. invalidating a whole family by prefix is a one-liner
 *      (`invalidateQueries({ queryKey: qk.settings.all })`).
 *
 * Keys are `readonly` tuples — treat them as opaque, never mutate.
 */

/** Root prefixes used across the dashboard, grouped by domain. */
export const qk = {
  /** `/console/api/settings` — runtime + appearance settings bundle. */
  settings: {
    all: ["settings"] as const,
  },

  /** `/v2/admin/backups/*`. */
  backups: {
    all: ["backups"] as const,
  },

  /** `/v2/admin/tools/*`. */
  tools: {
    all: ["tools"] as const,
  },

  /** `/v2/admin/proxies/*` and `/v2/admin/proxy-settings`. */
  proxies: {
    all: ["proxies"] as const,
    list: (limit = 100) => ["proxies", "list", limit] as const,
    detail: (proxyId: string | undefined) => ["proxies", "detail", proxyId] as const,
    search: (query: string, country: readonly string[], limit: number) => ["proxies", "search", query, country, limit] as const,
    countries: ["proxies", "scrape", "countries"] as const,
    catalog: ["proxies", "scrape", "catalog"] as const,
    settings: ["proxies", "settings"] as const,
  },


  /** `/console/api/overview` — dashboard overview aggregate. */
  overview: {
    all: ["overview"] as const,
  },


  /** `/console/api/health/*` — proxy/runtime health probes. */
  health: {
    status: ["health-status"] as const,
    metrics: ["health-metrics"] as const,
  },


  /** `/console/api/providers` catalog surface. */
  catalog: {
    providers: ["catalog", "providers"] as const,
    provider: (providerId: string | undefined) => ["catalog", "provider", providerId] as const,
  },

  /** `/console/api/providers/:id` (single provider detail/accounts). */
  provider: {
    detail: (providerId: string | undefined) => ["provider", providerId] as const,
    accounts: (providerId: string | undefined) => ["provider-accounts", providerId] as const,
  },



  /** `/console/api/quota` management. */
  quota: {
    management: ["console", "quota-management"] as const,
    account: (accountId: string) => ["console", "quota-account", accountId] as const,
  },

  /** `/console/api/usage/*`. */
  usage: {
    chart: (period: string) => ["usage-chart", period] as const,
    detail: (id: string | null) => ["usage-detail", id] as const,
    by: (period: string, dimension: string) => ["usage-by", period, dimension] as const,
    cache: (period: string) => ["usage-cache", period] as const,
    summary: (period: string) => ["usage-summary", period] as const,
    recentRequests: ["usage-requests", "recent"] as const,
    clients: (period: string) => ["usage-clients", period] as const,
  },

  /** `/console/api/oauth/sessions/:id` — OAuth popup polling. */
  oauthLogin: {
    session: (sessionId: string | null | undefined) => ["oauth-login", sessionId] as const,
  },
} as const;

export type QueryKeys = typeof qk;

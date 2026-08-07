/**
 * Centralized React Query key factories.
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

  /** `/console/api/keys` — proxy API keys. */
  apiKeys: {
    all: ["keys"] as const,
  },

  /** `/console/api/overview` — dashboard overview aggregate. */
  overview: {
    all: ["overview"] as const,
  },

  /** `/console/api/ip` — local egress IPs. */
  ip: {
    all: ["ip"] as const,
  },

  /** `/console/api/health/*` — proxy/runtime health probes. */
  health: {
    status: ["health-status"] as const,
    metrics: ["health-metrics"] as const,
  },

  /** GitHub releases API (external). */
  releases: {
    githubLatest: ["github-latest-release"] as const,
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

  /** `/console/api/custom-providers` (catalog of custom providers). */
  customProviders: {
    all: ["console", "custom-providers"] as const,
    detail: (providerId: string | undefined) => ["custom-provider", providerId] as const,
  },

  /** `/console/api/aliases` + `/console/api/combos`. */
  aliases: {
    all: ["console", "aliases"] as const,
  },
  combos: {
    all: ["console", "combos"] as const,
  },

  /** `/console/api/proxies` pool + `/console/api/proxy-settings`. */
  proxies: {
    all: ["console", "proxies"] as const,
  },
  proxySettings: {
    all: ["console", "proxy-settings"] as const,
  },

  /** `/console/api/providers` routing view (summary list for routing UI). */
  routing: {
    all: ["console", "providers-routing"] as const,
  },

  /** `/console/api/filters` — request filter/sanitize rules. */
  filterRules: {
    all: ["filter-rules"] as const,
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
  },
  /** `/console/api/cli-tools/*`. */
  cliTools: {
    registry: ["cli-tools", "registry"] as const,
    statuses: ["cli-tools", "statuses"] as const,
    apiKeys: ["cli-tools", "api-keys"] as const,
  },
  dbMap: {
    schema: (db: string) => ["db-map", "schema", db] as const,
    rows: (db: string, table: string | null, limit: number, offset: number) =>
      ["db-map", "rows", db, table, limit, offset] as const,
    /** Prefix matching all rows queries for a db (any table/limit/offset). */
    rowsPrefix: (db: string) => ["db-map", "rows", db] as const,
  },

  /** `/console/api/model-studio/*`. */
  modelStudio: {
    sessions: ["model-studio", "sessions"] as const,
    session: (sessionId: string | null) => ["model-studio", "session", sessionId] as const,
  },

  /** `/console/api/oauth/sessions/:id` — OAuth popup polling. */
  oauthLogin: {
    session: (sessionId: string | null | undefined) => ["oauth-login", sessionId] as const,
  },
} as const;

export type QueryKeys = typeof qk;

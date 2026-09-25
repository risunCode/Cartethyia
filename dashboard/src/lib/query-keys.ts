/**
 * Centralized query-key factory for every dashboard server-state resource.
 *
 * Keys are readonly tuples so query readers and mutation invalidations share one
 * authority. Feature code must not create inline TanStack Query keys.
 */
export const queryKeys = {
  session: {
    current: ["console", "session"] as const,
  },
  system: {
    health: ["console", "system", "health"] as const,
    usage: ["console", "system", "usage"] as const,
    usageByPeriod: (period: string) => ["console", "system", "usage", period] as const,
  },
  usageAnalytics: {
    summary: (period: string) => ["console", "usage", "summary", period] as const,
    chart: (period: string) => ["console", "usage", "chart", period] as const,
    by: (period: string, dimension: string) => ["console", "usage", "by", period, dimension] as const,
    requests: (period: string, limit: number, httpStatus?: number | null) =>
      ["console", "usage", "requests", period, limit, httpStatus ?? "all"] as const,
    requestDetail: (requestId: string) => ["console", "usage", "requests", requestId] as const,
  },
  providers: {
    all: ["console", "providers"] as const,
    detail: (providerId: string) => ["console", "providers", providerId] as const,
    models: (providerId: string | undefined) =>
      ["console", "providers", providerId, "models"] as const,
    flatAll: ["console", "providers", "models-flat-all"] as const,
    accounts: (providerId: string | undefined) =>
      ["console", "providers", providerId, "accounts"] as const,
    routing: (providerId: string | undefined) =>
      ["console", "providers", providerId, "routing"] as const,
    accountInflight: (providerId: string | undefined) =>
      ["console", "providers", providerId, "account-inflight"] as const,
    healthEvents: (providerId: string | undefined, accountId: string | undefined) =>
      [
        "console",
        "providers",
        providerId,
        "accounts",
        accountId,
        "health-events",
      ] as const,
  },
  modelRouting: {
    all: ["console", "model-routing"] as const,
    aliases: ["console", "model-routing", "aliases"] as const,
    combos: ["console", "model-routing", "combos"] as const,
  },
  network: {
    pools: ["console", "network", "pools"] as const,
    poolStrategy: ["console", "network", "pool-strategy"] as const,
  },
  apiKeys: {
    all: ["console", "api-keys"] as const,
    sharedKeys: (keyId: string) => ["console", "api-keys", keyId, "shared-keys"] as const,
    sharedKeyActivity: (parentKeyId: string, childKeyId: string) =>
      ["console", "api-keys", parentKeyId, "shared-keys", childKeyId, "activity"] as const,
  },
  settings: {

    runtime: ["console", "settings", "runtime"] as const,
  },
  cliTools: {
    registry: ["console", "cli-tools", "registry"] as const,
    statuses: ["console", "cli-tools", "statuses"] as const,
    mappings: (toolId: string) => ["console", "cli-tools", toolId, "mappings"] as const,
  },
  audit: {
    list: (filters: { action?: string; actor?: string; cursor?: string; limit?: number }) =>
      ["console", "audit", "list", filters] as const,
  },
  quota: {
    all: ["console", "quota"] as const,
    account: (accountId: string) => ["console", "quota", "account", accountId] as const,
    resets: (accountId: string) => ["console", "quota", "account", accountId, "resets"] as const,
  },
  studio: {
    sessions: ["console", "studio", "sessions"] as const,
    session: (sessionId: string) => ["console", "studio", "sessions", sessionId] as const,
  },
} as const;

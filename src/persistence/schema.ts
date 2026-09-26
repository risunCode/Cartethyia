/** Canonical Drizzle schema: every persistence table, enum, index, and shared type. */
import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, customType, index, integer, jsonb, numeric, pgEnum, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Exactly id, name, status, created_at — no status enum/default or extra
// lifecycle column.
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  // Intentionally inline (not createdAtColumn()): this root table is imported
  // by the helpers below sharing the helper here would make a use-before-define.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;

// Canonical tenant/timestamp column definitions shared by every table.

export function tenantRefNullable() {
  return uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantRefRequired() {
  return uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantRefPrimaryKey() {
  return uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantCascadeSetNull() {
  return uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" });
}

export function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

export function updatedAtColumn() {
  return timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
}

export function timestampColumns() {
  return { createdAt: createdAtColumn(), updatedAt: updatedAtColumn() };
}

/**
 * `bytea` column for encrypted credential ciphertext (application-layer
 * envelope encryption: the ciphertext stored here is opaque to the
 * database). Drizzle's pg-core does not ship a first-class `bytea`
 * builder, so this is the documented `customType` escape hatch (the same
 * DDL-shape escape-hatch principle applied to column-type gaps in the
 * ORM's builder).
 */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Shared four-state health machine for provider_accounts and network_pools —
// the account state machine is reused for network pools rather than
// inventing a second one.
export const healthStatus = pgEnum("health_status", ["active", "degraded", "cooldown", "disabled"]);

export const credentialKind = pgEnum("credential_kind", ["api_key", "oauth", "none"]);

// Shared wire-family domain used by providers.wire_family_default and
// models.wire_family.
export const wireFamily = pgEnum("wire_family", ["chat", "responses", "messages"]);

export const networkPoolKind = pgEnum("network_pool_kind", ["http", "socks5"]);

//  health_events.entity_kind — distinguishes which owning
// table entity_id/account_id/network_pool_id references.
export const healthEntityKind = pgEnum("health_entity_kind", ["account", "pool"]);

export const telemetrySourceSurface = pgEnum("telemetry_source_surface", [
  "chat",
  "responses",
  "messages",
  "completion",
]);

export const telemetryStatus = pgEnum("telemetry_status", [
  "completed",
  "failed",
  "cancelled",
  "truncated",
]);

// The id matches the seven canonical builtin IDs (openai, anthropic, claude,
// codex, opencodezen, ollamacloud, cerebras) or a custom/BYOK slug
// rejected at the identity boundary when it collides case-insensitively with
// a reserved ID — that rejection is application-layer, not a DB constraint
// here. `capability_profile` carries the native JSONB/GIN index. `tenant_id`
// null means the provider is global/built-in, matching the same convention
// as `provider_accounts.tenant_id`; populated means tenant-owned/BYOK.
// `base_url`/`compatibility_profile` are BYOK-only: `compatibility_profile`
// carries HTTP dispatch config (extra headers/query params/streaming mode)
// and is intentionally a separate column from `capability_profile`, which
// drives routing capability flags — conflating the two would corrupt routing
// data with unrelated HTTP config.
export const providers = pgTable(
  "providers",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRefNullable(),
    wireFamilyDefault: wireFamily("wire_family_default"),
    capabilityProfile: jsonb("capability_profile"),
    baseUrl: text("base_url"),
    compatibilityProfile: jsonb("compatibility_profile"),
    enabled: boolean("enabled").notNull().default(true),
    // Builtin default `true` (most providers need a real credential). Only a
    // genuinely public/unauthenticated builtin (OpenCode Free) is seeded
    // `false`. When `false`, the snapshot builder emits a routable candidate
    // with zero `provider_accounts` rows instead of marking it `disabled` —
    // see `src/transport/routing/route-catalog.ts`.
    requiresAccount: boolean("requires_account").notNull().default(true),
  },
);

export type Provider = typeof providers.$inferSelect;

// Upstream account credentials plus the full health state machine.
// `tenant_id` null means the account is shared pool-wide; populated means
// tenant-owned/BYOK. Provider routing supplies the concurrency ceiling and
// network-pool policy; the legacy per-account `max_inflight` column is inert
// and must not be repurposed as an override.
export const providerAccounts = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providers.id, { onDelete: "cascade" }),
  tenantId: tenantRefNullable(),
  label: text("label").notNull(),
  credentialCiphertext: bytea("credential_ciphertext"),
  /**
   * HMAC fingerprint of the credential, never the plaintext secret. Nullable
   * for credential-less accounts and legacy rows without an identity.
   */
  credentialFingerprint: text("credential_fingerprint"),
  credentialKind: credentialKind("credential_kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // Health state machine columns.
  status: healthStatus("status").notNull().default("active"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorCategory: text("last_error_category"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  lastRecoveredAt: timestamp("last_recovered_at", { withTimezone: true }),
  modelCooldowns: jsonb("model_cooldowns").notNull().default({}),
  /** Legacy per-account ceiling retained for stored rows only. Routing ignores it. */
  maxInflight: integer("max_inflight"),

  },
  (table) => [
    uniqueIndex("provider_accounts_identity_uidx").on(
      table.providerId,
      sql`coalesce(${table.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.credentialFingerprint,
    ),
    index("provider_accounts_status_cooldown_idx").on(table.status, table.cooldownUntil),
    index("provider_accounts_provider_tenant_idx").on(table.providerId, table.tenantId),
  ],
);


//  OAuth refresh token + cross-process lease, normalized out of
// `provider_accounts` into its own 1:0/1 table. The vast majority of
// provider accounts are `credentialKind: "api_key"`, for which these four
// columns stayed null forever on the shared row; splitting them here keeps
// the hot health-machine row narrow and isolates the fenced compare-and-swap
// lease traffic (`providers/auth/refresh-service.ts`) from unrelated
// account reads/writes.
export const providerOauthStates = pgTable("provider_oauth_states", {
  providerAccountId: uuid("provider_account_id")
    .primaryKey()
    .references(() => providerAccounts.id, { onDelete: "cascade" }),
  refreshCiphertext: bytea("refresh_ciphertext").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // OAuth refresh lease: fenced compare-and-swap coordination so only one
  // process refreshes a given account's OAuth token at a time, and a losing
  // process reloads instead of clobbering a peer's fresher token.
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
});


// One row per (provider_id, model_id, route), with `endpoint_path`
// identifying the route — the same model through two providers, or through
// two routes of one provider, is two rows. `enabled` is a hard routing
// invariant read by ProviderCatalogService, not a display-only flag.
export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    wireFamily: wireFamily("wire_family").notNull(),
    endpointPath: text("endpoint_path").notNull(),
    contextLimit: integer("context_limit"),
    outputLimit: integer("output_limit"),
    modalities: jsonb("modalities"),
    reasoning: boolean("reasoning").notNull().default(false),
    toolCall: boolean("tool_call").notNull().default(false),
    webSearch: boolean("web_search").notNull().default(false),
    cost: jsonb("cost"),
    source: text("source"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    uniqueIndex("models_provider_model_route_uidx").on(
      table.providerId,
      table.modelId,
      table.endpointPath,
    ),
    index("models_provider_enabled_idx").on(table.providerId, table.enabled),
  ],
);

export type Model = typeof models.$inferSelect;

// Tenant-scoped suppression of a GLOBAL/built-in model. Tenants cannot mutate
// the shared `models` row (see `DrizzleProviderCatalogStore.setModelEnabled`),
// so a disable is recorded here and filtered out of that tenant's routing
// snapshot. Tenant-owned/BYOK models are still toggled directly on `models`.
export const tenantDisabledModels = pgTable(
  "tenant_disabled_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    endpointPath: text("endpoint_path").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("tenant_disabled_models_tenant_provider_model_uidx").on(
      t.tenantId,
      t.providerId,
      t.modelId,
      t.endpointPath,
    ),
  ],
);


// Tenant-owned HTTP/HTTPS/SOCKS5 pools share the provider-account health state machine.
export const networkPools = pgTable("network_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  kind: networkPoolKind("kind").notNull(),
  endpointConfig: jsonb("endpoint_config").notNull(),
  credentialCiphertext: bytea("credential_ciphertext"),
  maxInflight: integer("max_inflight"),
  /** Routing weight for weighted selection across the tenant pool group. */
  weight: integer("weight"),
  tenantId: tenantRefRequired(),

  status: healthStatus("status").notNull().default("active"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastLatencyMs: integer("last_latency_ms"),
  lastError: text("last_error"),
  lastErrorCategory: text("last_error_category"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  lastRecoveredAt: timestamp("last_recovered_at", { withTimezone: true }),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  },
  (table) => [
    index("network_pools_tenant_id_idx").on(table.tenantId),
    index("network_pools_status_cooldown_idx").on(table.status, table.cooldownUntil),
  ],
);


// Account and network-pool health events share one table. The entity kind
// selects exactly one owner FK, and the CHECK constraint below preserves
// referential integrity for both variants.
export const healthEvents = pgTable(
  "health_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityKind: healthEntityKind("entity_kind").notNull(),
    accountId: uuid("account_id").references(() => providerAccounts.id, { onDelete: "cascade" }),
    networkPoolId: uuid("network_pool_id").references(() => networkPools.id, {
      onDelete: "cascade",
    }),
    fromStatus: healthStatus("from_status"),
    toStatus: healthStatus("to_status").notNull(),
    reason: text("reason"),
    errorCategory: text("error_category"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("health_events_account_id_created_at_idx").on(table.accountId, table.createdAt),
    index("health_events_network_pool_id_created_at_idx").on(table.networkPoolId, table.createdAt),
    check(
      "health_events_entity_reference_check",
      sql`(${table.entityKind} = 'account' AND ${table.accountId} IS NOT NULL AND ${table.networkPoolId} IS NULL) OR (${table.entityKind} = 'pool' AND ${table.networkPoolId} IS NOT NULL AND ${table.accountId} IS NULL)`,
    ),
  ],
);


// Model aliasing & combos: replaces the dormant, disconnected
// `routing_policies` scaffolding. Aliases resolve a client-facing name to a
// real model; combos back a client-facing name with >=1 real models,
// auto-selected via `fallback` or `round_robin`.
export const modelComboStrategy = pgEnum("model_combo_strategy", ["fallback", "round_robin"]);

/** Canonical `ComboStrategy` union, derived from the enum above. Console
 * domain and routing layers import this instead of hand-typing their own mirror.
 * `ProviderRoutingStrategy` covers the same two values but persists on
 * `provider_routing_settings` beside `rotateCount`; sticky routing is gone. */
export type ComboStrategy = (typeof modelComboStrategy.enumValues)[number];

export const modelAliases = pgTable(
  "model_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    alias: text("alias").notNull(),
    targetModel: text("target_model").notNull(),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("model_aliases_tenant_alias_uidx").on(t.tenantId, t.alias)],
);
export type ModelAlias = typeof modelAliases.$inferSelect;

export const modelCombos = pgTable(
  "model_combos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    name: text("name").notNull(),
    members: jsonb("members").notNull().$type<string[]>(),
    strategy: modelComboStrategy("strategy").notNull().default("fallback"),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("model_combos_tenant_name_uidx").on(t.tenantId, t.name)],
);
export type ModelCombo = typeof modelCombos.$inferSelect;

export const providerRoutingStrategy = pgEnum("provider_routing_strategy", [
  "fallback",
  "round_robin",
]);

export const providerRoutingSettings = pgTable(
  "provider_routing_settings",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    tenantId: tenantRefNullable(),
    strategy: providerRoutingStrategy("strategy").notNull().default("fallback"),
    /** Requests served by one account before round robin advances. */
    rotateCount: integer("rotate_count").notNull().default(1),
    /** Per-account inflight ceiling applied to every account of this provider
     * (the field sits next to the failover/round-robin strategy in the UI).
     * `null` = UNLIMITED concurrency per account. */
    maxInflight: integer("max_inflight"),
    enabled: boolean("enabled").notNull().default(false),
    // When true, this provider's requests always dial direct. When false,
    // dispatch automatically selects among every active network pool the
    // tenant owns (least-loaded/non-cooldown) — never an admin-pinned pool.
    bypassProxy: boolean("bypass_proxy").notNull().default(false),
  },
  (table) => ({
    tenantProviderUnique: uniqueIndex("provider_routing_settings_tenant_provider_idx").on(
      table.tenantId,
      table.providerId,
    ),
    globalProviderUnique: uniqueIndex("provider_routing_settings_global_provider_idx")
      .on(table.providerId)
      .where(sql`tenant_id IS NULL`),
  }),
);

export const poolRoutingStrategy = pgEnum("pool_routing_strategy", [
  "least_loaded",
  "round_robin",
]);
export type PoolRoutingStrategy = (typeof poolRoutingStrategy.enumValues)[number];

/**
 * Per-tenant selection strategy across the tenant's active network pools —
 * the pool-group counterpart to `provider_routing_settings`. `least_loaded`
 * (default) keeps the weighted least-loaded scan with its rotating tie-break;
 * `round_robin` serves `rotate_count` requests per pool before advancing,
 * mirroring the account strategy, and skips capacity/cooldown pools the way
 * account failover does. An absent row reads as the default, so tenants that
 * never touch the toggle own no rows.
 */
export const poolRoutingSettings = pgTable("pool_routing_settings", {
  tenantId: tenantRefPrimaryKey(),
  strategy: poolRoutingStrategy("strategy").notNull().default("least_loaded"),
  /** Requests served by one pool before round robin advances. */
  rotateCount: integer("rotate_count").notNull().default(1),
});
export type PoolRoutingSettings = typeof poolRoutingSettings.$inferSelect;


export const API_KEY_MODES = ["personal", "share"] as const;
export type ApiKeyMode = (typeof API_KEY_MODES)[number];

/**
 * Inbound `/v1/*` keys never store plaintext secrets. Personal keys carry an
 * authentication hash; share templates carry policy and child keys point back
 * to the template that issued them.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    keyHash: text("key_hash"),
    keyMode: text("key_mode").$type<ApiKeyMode>().notNull().default("personal"),
    parentKeyId: uuid("parent_key_id").references(
      (): AnyPgColumn => apiKeys.id,
      { onDelete: "cascade" },
    ),
    issuedClientIp: text("issued_client_ip"),
    issuedClientIpKey: text("issued_client_ip_key"),
    label: text("label").notNull(),
    scopes: jsonb("scopes").notNull().$type<readonly string[]>(),
    // Only the non-secret public key prefix is returned to the owner.
    keyPrefix: text("key_prefix"),
    // Personal keys retain an encrypted copy for the Studio handoff. Shared
    // children are revealed once and persist only their authentication hash.
    keyEncrypted: bytea("key_encrypted"),
    notesTitle: text("notes_title"),
    notesSubtitle: text("notes_subtitle"),
    notesBody: text("notes_body"),
    requestsPerMinute: integer("requests_per_minute"),
    dailyTokenLimit: bigint("daily_token_limit", { mode: "number" }),
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
    lifetimeTokenBudget: bigint("lifetime_token_budget", { mode: "number" }),
    lifetimeTokensConsumed: bigint("lifetime_tokens_consumed", { mode: "number" })
      .notNull()
      .default(0),
    maxConcurrentRequests: integer("max_concurrent_requests"),
    providerAllowlist: jsonb("provider_allowlist").$type<readonly string[]>(),
    modelAllowlist: jsonb("model_allowlist").$type<readonly string[]>(),
    modelDenylist: jsonb("model_denylist").$type<readonly string[]>(),
    modelPrefix: text("model_prefix"),
    createdAt: createdAtColumn(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
    uniqueIndex("api_keys_active_shared_ip_uidx")
      .on(table.issuedClientIpKey)
      .where(sql`${table.parentKeyId} IS NOT NULL AND ${table.revokedAt} IS NULL`),
    index("api_keys_tenant_id_idx").on(table.tenantId),
    index("api_keys_parent_key_id_idx").on(table.parentKeyId),
    check(
      "api_keys_mode_shape_check",
      sql`(
        (${table.keyMode} = 'personal' AND ${table.keyHash} IS NOT NULL
          AND ${table.parentKeyId} IS NULL AND ${table.issuedClientIp} IS NULL
          AND ${table.issuedClientIpKey} IS NULL)
        OR
        (${table.keyMode} = 'share' AND (
          (${table.parentKeyId} IS NULL AND ${table.keyHash} IS NULL
            AND ${table.keyEncrypted} IS NULL
            AND ${table.issuedClientIp} IS NULL AND ${table.issuedClientIpKey} IS NULL)
          OR
          (${table.parentKeyId} IS NOT NULL AND ${table.keyHash} IS NOT NULL
            AND ${table.keyEncrypted} IS NULL
            AND ${table.issuedClientIp} IS NOT NULL AND ${table.issuedClientIpKey} IS NOT NULL)
        ))
      )`,
    ),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;


// Public bearer links for enrolling one shared key per resolved client IP, and
// for handing a personal key to its owner. The hash is the lookup key; the
// token is additionally retained encrypted so the owner's console can show the
// link again instead of losing it after the one response that minted it.
/**
 * Share-link kinds, as a runtime tuple. Route schemas and DTOs project this
 * list rather than restating it.
 */
export const SHARE_LINK_KINDS = ["enroll", "handoff"] as const;

/** One share-link kind. */
export type ShareLinkKind = (typeof SHARE_LINK_KINDS)[number];


export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    // Encrypted bearer token. Present so the console can re-display a stable
    // link; historical rows written before this column carry NULL and simply
    // cannot be shown again.
    tokenEncrypted: bytea("token_encrypted"),
    kind: text("kind").$type<ShareLinkKind>().notNull().default("enroll"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAtColumn(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Retained for historical rows from the retired one-time setup-link flow.
    usedAt: timestamp("used_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("share_links_token_hash_idx").on(table.tokenHash),
    index("idx_share_links_api_key").on(table.apiKeyId),
    index("idx_share_links_active").on(table.active, table.kind, table.expiresAt),
    check("share_links_kind_check", sql`${table.kind} IN ('enroll', 'handoff')`),
  ],
);


/**
 * Console dashboard users — distinct from API-key tenants.
 */
export const consoleUsers = pgTable(
  "console_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    username: text("username").notNull(),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    isActive: boolean("is_active").notNull().default(true),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    isFirstBoot: boolean("is_first_boot").notNull().default(true),
    ...timestampColumns(),
  },
  (table) => [
    index("idx_console_users_tenant_id").on(table.tenantId),
    uniqueIndex("idx_console_users_username").on(table.username),
  ],
);

export type ConsoleUser = typeof consoleUsers.$inferSelect;

/**
 * Console sessions — HTTP-only, signed cookies.
 * Session metadata only; no secrets in JSON.
 */
export const consoleSessions = pgTable(
  "console_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("idx_console_sessions_user_id").on(table.userId),
  ],
);

export type ConsoleSession = typeof consoleSessions.$inferSelect;

/**
 * Console login lockout tracking — fail-closed rate limiting keyed by
 * client IP (login attempts happen before any user identity is known, so
 * this cannot be keyed by `console_users.id`). Persisted so a ban survives
 * a process restart and is shared across every app instance, instead of a
 * static in-process map that a second instance or a redeploy would forget.
 */
export const consoleLockouts = pgTable(
  "console_lockouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ip: text("ip").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    windowUntil: timestamp("window_until", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    reason: text("reason"),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("idx_console_lockouts_ip").on(table.ip),
  ],
);


// Configuration-change audit has its own retention lifecycle; it is separate
// from metadata telemetry and short-lived optional payload capture.
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: createdAtColumn(),
    actor: text("actor").notNull(),
    tenantId: tenantCascadeSetNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    detail: jsonb("detail"),
  },
  (table) => [
    index("admin_audit_log_tenant_id_created_at_id_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
  ],
);


// Runtime preferences are stored in one validated JSONB bag. The filter
// master toggle remains a typed column because it is read on the proxy path.
export interface ConsoleSettingsPreferences {
  tenantConcurrencyLimit?: number | null;
  /** Normalizes provider-native thinking config for non-user final turns. */
  thinkingNormalizationEnabled?: boolean;
  responsesReasoningSummary?: "auto" | "concise" | "detailed";
  telemetryPayloads?: "bounded" | "none";
  privacyMode?: "masked" | "full";
}

export const consoleSettings = pgTable("console_settings", {
  tenantId: tenantRefPrimaryKey(),
  preferences: jsonb("preferences").notNull().default({}).$type<ConsoleSettingsPreferences>(),
  updatedAt: updatedAtColumn(),
});


// CLI Tools (CLI tool configuration): per-tenant mapping table that lets a coding-agent
// slot (e.g. Claude Code's "opus" slot) target a specific Cartethyia model. Rows
// are opaque strings — validation happens at the API boundary against the
// tool registry, not in Postgres.
export const cliToolMappings = pgTable(
  "cli_tool_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    toolId: text("tool_id").notNull(),
    slotKey: text("slot_key").notNull(),
    sourceModel: text("source_model").notNull(),
    targetModel: text("target_model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex("cli_tool_mappings_key").on(table.tenantId, table.toolId, table.slotKey)],
);


// Per-(tenant, tool) settings: whether mappings are active and which mode
// (remote gateway vs local passthrough) the tool is configured for.
export const cliToolSettings = pgTable(
  "cli_tool_settings",
  {
    tenantId: tenantRefRequired(),
    toolId: text("tool_id").notNull(),
    mappingsEnabled: boolean("mappings_enabled").notNull().default(false),
    mode: text("mode").notNull().default("remote"),
    updatedAt: updatedAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.toolId] })],
);


// Metadata-only request telemetry. Retention is configured independently of
// payload capture (`CARTETHYIA_TELEMETRY_RETENTION_DAYS`, default 30 days).
// No prompt text, raw body, API key, encrypted-reasoning payload, or generic
// `payload` column — the schema structurally prevents those fields.
// Correlation columns intentionally have no catalog foreign keys, so a
// telemetry write never depends on provider-row lifetime.
export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: createdAtColumn(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    sourceSurface: telemetrySourceSurface("source_surface"),
    requestedModel: text("requested_model"),
    providerId: text("provider_id"),
    accountId: uuid("account_id"),
    networkPoolId: uuid("network_pool_id"),
    endpoint: text("endpoint"),
    apiKeyId: uuid("api_key_id"),
    userAgent: text("user_agent"),
    clientIp: text("client_ip"),
    latencyMs: integer("latency_ms"),
    ttfbMs: integer("ttfb_ms"),
    stream: boolean("stream"),
    status: telemetryStatus("status"),
    /**
     * HTTP status the client actually received. The `status` enum is the
     * internal terminal state (`completed`/`failed`/…), which collapses every
     * failure to one bucket; this column keeps the wire code, so a 503
     * admission rejection stays distinguishable from a 500 upstream failure
     * in the Usage status breakdown. NULL on rows written before the column.
     */
    httpStatus: integer("http_status"),
    /**
     * Which layer produced the failure: the gateway itself, the upstream
     * provider, or the network in between. Recorded beside `error_category`
     * because the category alone cannot separate them — `invalid_request` is
     * both "the caller sent a bad body" (ours) and "the upstream rejected the
     * body" (theirs), and an operator triaging a failure needs to know which.
     */
    errorOrigin: text("error_origin"),
    errorCategory: text("error_category"),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    tokensPerSec: numeric("tokens_per_sec", { precision: 10, scale: 2 }),
    // Absolute epoch-millisecond event timestamps (~1.8e12) overflow integer
    // (int4): completed requests carrying observed stream timings failed
    // their telemetry insert and vanished from the console. bigint "number"
    // mode is safe here — epoch millis stay far below MAX_SAFE_INTEGER —
    // and keeps the columns JSON-safe like the token-budget bigints above.
    firstContentDeltaAtMs: bigint("first_content_delta_at_ms", { mode: "number" }),
    lastEventAtMs: bigint("last_event_at_ms", { mode: "number" }),
  },
  (table) => [
    index("idx_telemetry_created_at").on(table.createdAt),
    index("telemetry_events_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("telemetry_events_request_id_idx").on(table.requestId),
    index("telemetry_events_tenant_account_created_idx").on(
      table.tenantId,
      table.accountId,
      table.createdAt,
    ),
    /**
     * Serves the public share page's per-key aggregate (`share-usage.ts`):
     * equality on `api_key_id`, range and aggregate on `created_at`. Without
     * it every share render scanned the largest table in the schema.
     */
    index("telemetry_events_api_key_created_idx").on(table.apiKeyId, table.createdAt),
  ],
);

/** Durable aggregates retained after metadata telemetry expires. */
export const TELEMETRY_USAGE_IDENTITY_TYPES = ["account", "api_key"] as const;
export type TelemetryUsageIdentityType = (typeof TELEMETRY_USAGE_IDENTITY_TYPES)[number];

export const telemetryUsageTotals = pgTable(
  "telemetry_usage_totals",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    identityType: text("identity_type").$type<TelemetryUsageIdentityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "telemetry_usage_totals_identity_pk",
      columns: [table.tenantId, table.identityType, table.entityId],
    }),
    check(
      "telemetry_usage_totals_identity_type_check",
      sql`${table.identityType} IN ('account', 'api_key')`,
    ),
  ],
);


export const telemetryPayloads = pgTable(
  "telemetry_payloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    requestId: uuid("request_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Holds `{ _payload_ref }` pointing at the frame file that carries the
     * captured bodies. The bodies themselves are never stored in a column —
     * this row is only the index into the frame store.
     */
    requestBody: jsonb("request_body"),
  },
  (table) => [
    index("telemetry_payloads_request_id_idx").on(table.requestId),
    index("telemetry_payloads_tenant_request_idx").on(table.tenantId, table.requestId),
    index("telemetry_payloads_expires_idx").on(table.expiresAt),
  ],
);


// Studio playground sessions: per-tenant saved chats (+ generated-media refs)
// for the console Studio page. Message/media shapes are validated at the API
// boundary (console/domains/studio.ts), not in Postgres — rows stay opaque
// JSONB so the playground can evolve without migrations.
export const studioSessions = pgTable(
  "studio_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    title: text("title").notNull().default("New session"),
    model: text("model").notNull().default(""),
    systemPrompt: text("system_prompt").notNull().default(""),
    messagesJson: jsonb("messages_json").notNull().default([]),
    mediaJson: jsonb("media_json").notNull().default([]),
    ...timestampColumns(),
  },
  (table) => [index("studio_sessions_tenant_updated_idx").on(table.tenantId, table.updatedAt)],
);

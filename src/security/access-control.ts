// Shared authorization primitives: closed scope model and immutable access decisions.

/**
 * Closed set of authorization scopes.
 * - `routing:invoke`: May call only /v1/* gateway routes within holder's tenant.
 * - `routing:cli_mapping`: May use persisted CLI source→target model mappings.
 * - `dashboard:read`: Reads only holder's tenant configuration and usage.
 * - `dashboard:write`: Modifies only holder's tenant configuration.
 * - `providers:read` / `providers:write`: Reads or modifies provider rows —
 *   including registering a BYOK upstream and its credential.
 * - `models:read` / `models:write`: Reads or modifies catalog model rows.
 * - `platform:admin`: Cross-tenant operator actions (account health, kill-switch, catalog sync).
 *
 * Catalog mutation is deliberately separate from `dashboard:write`. A key
 * minted to read usage, or to change a display setting, must not thereby be
 * able to add an upstream or delete a model: those writes change where traffic
 * is sent and which credentials are used, so they are granted explicitly.
 */
export type AccessScope =
  | "routing:invoke"
  | "routing:cli_mapping"
  | "dashboard:read"
  | "dashboard:write"
  | "providers:read"
  | "providers:write"
  | "models:read"
  | "models:write"
  | "platform:admin";

/** Scopes a tenant API key may hold; `platform:admin` is never assignable. */
export type TenantScope = Exclude<AccessScope, "platform:admin">;

/**
 * The scopes a signed-in console session holds, per principal kind.
 *
 * Stated here rather than inline at the session resolver so the dashboard's
 * authority has one home, and so the catalog scopes are granted by name.
 *
 * They must be granted by name because `dashboard:write` deliberately does not
 * imply them: a tenant API key can hold `dashboard:write`, and such a key must
 * not be able to add an upstream or delete a model. The session is the operator
 * and needs the catalog routes to work, so it holds the catalog scopes
 * explicitly instead — which keeps the separation honest without narrowing the
 * dashboard.
 *
 * A regular console user reads their tenant's configuration and catalog but
 * writes nothing; that read-only ceiling is the pre-existing behaviour and is
 * preserved exactly, just spelled with the catalog read scopes the routes now
 * require.
 */
export function consoleSessionScopes(isPlatformAdmin: boolean): readonly AccessScope[] {
  if (isPlatformAdmin) {
    return [
      "dashboard:read",
      "dashboard:write",
      "providers:read",
      "providers:write",
      "models:read",
      "models:write",
      "platform:admin",
    ];
  }
  return ["dashboard:read", "providers:read", "models:read"];
}

/**
 * Immutable authorization decision snapshot.
 * Contains the principal identity, tenant binding, and scopes.
 * Created at authentication boundary and passed unchanged through routing and provider dispatch.
 *
 * `tenantId` is null for platform:admin cross-tenant operator sessions.
 */
export interface AccessDecision {
  readonly id: string;
  readonly tenantId: string | null;
  /** Scopes present on this key/user. */
  readonly scopes: readonly AccessScope[];
  /** Identity recorded for audit attribution; defaults to `id` if absent. */
  readonly admissionIdentity: string;
}

/**
 * Every scope a tenant API key may be granted, in display order.
 *
 * The single source of truth for what the API-key editor offers: the predicate
 * below is derived from it, and the dashboard renders it directly. Keeping the
 * two in step by hand is how the editor came to offer only the four
 * routing/dashboard scopes while the backend accepted eight — a `providers:write`
 * key could be created through the API but not through the UI.
 *
 * `platform:admin` is deliberately absent: it is a console-session scope for
 * cross-tenant operator actions and is never assignable to a tenant key.
 */
export const TENANT_KEY_SCOPES = [
  "routing:invoke",
  "routing:cli_mapping",
  "dashboard:read",
  "dashboard:write",
  "providers:read",
  "providers:write",
  "models:read",
  "models:write",
] as const satisfies readonly TenantScope[];

/**
 * Determine if a scope is valid for a tenant API key.
 *
 * Tenant keys default to routing:invoke only.
 * platform:admin is never assignable to tenant keys.
 */
export const isValidTenantKeyScope = (scope: AccessScope): scope is TenantScope =>
  (TENANT_KEY_SCOPES as readonly AccessScope[]).includes(scope);

/**
 * Create an immutable frozen AccessDecision.
 * Default tenant keys to routing:invoke scope if scopes are empty.
 */
export function createAccessDecision(input: {
  readonly id: string;
  readonly tenantId: string | null;
  readonly scopes: readonly AccessScope[];
  readonly admissionIdentity?: string;
}): AccessDecision {
  const decision: AccessDecision = {
    id: input.id,
    tenantId: input.tenantId,
    scopes:
      input.scopes.length === 0 && input.tenantId !== null
        ? // Default tenant keys to routing:invoke
          ["routing:invoke"]
        : Array.from(input.scopes),
    admissionIdentity: input.admissionIdentity ?? input.id,
  };

  // Deep freeze the decision
  return Object.freeze({
    ...decision,
    scopes: Object.freeze([...decision.scopes]),
  });
}

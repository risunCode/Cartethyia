import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

// Ownership glossary — one noun, two nulls:
// - `TenantId` is the requesting or owning tenant's UUID.
// - A row's `tenant_id` NULL means GLOBAL/shared: every tenant may use it
//   (all built-in providers/accounts). Populated means tenant-owned (BYOK).
// - A requester's `tenantId` null (see `AccessDecision.tenantId`) means a
//   platform/service identity, not a tenant. `globalOrOwnedBy(col, null)`
//   therefore matches global rows only (`eq(col, NULL)` matches nothing).
export type TenantId = string;

export function globalOrOwnedBy(column: AnyColumn, tenantId: TenantId | null): SQL {
  if (tenantId === null) return isNull(column) as SQL;
  return or(isNull(column), eq(column, tenantId)) as SQL;
}

export function ownedByOnly(column: AnyColumn, tenantId: TenantId): SQL {
  return eq(column, tenantId);
}

/**
 * Resolves a tenant-overridable setting using the one precedence rule every
 * reader of `provider_routing_settings` (and any future tenant-overridable
 * table) must agree on: a tenant-scoped row wins *entirely* over the global
 * (`tenant_id IS NULL`) row — never a per-field merge between the two —
 * falling back to `defaultValue` when neither exists.
 *
 * Two independent readers already depend on this staying identical:
 * `transport/routing/route-catalog.ts` (actual dispatch behavior) and
 * `console/stores/provider-detail.ts` (what the operator sees in the
 * dashboard). A hand-rolled copy of this chain drifting in either reader is
 * exactly the bug class this shares — the proxy and the dashboard silently
 * disagreeing about which setting is in effect.
 */
export function resolveTenantOverride<T>(
  tenantRow: T | undefined,
  globalRow: T | undefined,
  defaultValue: T,
): T {
  return tenantRow ?? globalRow ?? defaultValue;
}

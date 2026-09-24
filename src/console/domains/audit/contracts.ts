import type { ConsoleAccessResolver } from "../../auth/access";
// Audit domain: read-only, tenant-scoped audit-log API for platform admins.

import { errorResponse, requireGlobalAdmin, requireTenantScope } from "../../shared/errors";
import { parseQueryLimit } from "../../shared/query";
import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../../security/access-control";

/**
 * Read-only audit log surface. Every privileged mutation across the console
 * (provider CRUD, key rotation, network pool binding, routing policies,
 * backup/restore, IP bans) already writes a row into `admin_audit_log`; this
 * module makes that trail visible to platform admins via a cursor-paginated,
 * tenant-scoped read API so an operator can actually inspect who did what
 * without SQL access to the primary database.
 *
 * Access rules:
 *   - `platform:admin` scope is required. `dashboard:read` is intentionally
 *     insufficient — audit rows carry cross-tenant metadata (`actor`,
 *     `target`) that ordinary read tokens must never see.
 *   - Rows scoped to a single tenant are visible only to that tenant; rows
 *     with `tenant_id IS NULL` (platform-wide events such as `security.
 *     ip_banned` or `backup.reset`) are visible only to the platform admin
 *     tenant. The resolver's `AccessDecision.tenantId` is authoritative.
 */
export interface AuditEntry {
  id: string;
  createdAt: string;
  actor: string;
  /** Human name resolved from `console_users` when the actor is a user id. */
  actorName?: string;
  tenantId: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
}

export interface AuditListPage {
  entries: readonly AuditEntry[];
  /** Opaque cursor for the next page; `undefined` when the tail is reached. */
  nextCursor?: string;
}

export interface AuditReadStore {
  /**
   * Returns at most `limit` rows newer-first, honoring tenant isolation.
   * The store MUST NOT leak rows across tenants — it filters by
   * `tenant_id = ? OR (tenant_id IS NULL AND platform_admin)`.
   */
  list(params: {
    tenantId: string;
    platformAdmin: boolean;
    limit: number;
    cursor?: string;
    action?: string;
    actor?: string;
  }): Promise<AuditListPage>;
}

/**
 * Write-side audit contract shared by every console route factory.
 *
 * Privileged mutations across the console (provider CRUD, key rotation, pool
 * binding, routing policies) all record the same four fields, so the sink shape
 * lives here beside the read-side types instead of being redeclared per domain.
 */
export interface AuditSink {
  record(entry: {
    access: AccessDecision;
    action: string;
    target: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

export interface AuditRoutesConfig {
  readonly store: AuditReadStore;
  readonly accessResolver: ConsoleAccessResolver;
}

const listQuery = t.Object({
  limit: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
  action: t.Optional(t.String()),
  actor: t.Optional(t.String()),
});

export function createAuditRoutes(config: AuditRoutesConfig): Elysia {
  return new Elysia().get("/audit", { query: listQuery }, async ({ request, query, set }) => {
    try {
      const resolved = config.accessResolver(request);
      const access = requireGlobalAdmin(resolved);
      const { tenantId } = requireTenantScope(resolved, "dashboard:read");
      const limit = parseQueryLimit(query.limit, 50, 200);
      return await config.store.list({
        tenantId,
        platformAdmin: access.scopes.includes("platform:admin"),
        limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.actor ? { actor: query.actor } : {}),
      });
    } catch (e) {
      return errorResponse(e, set, "Audit read failed");
    }
  }) as unknown as Elysia;
}

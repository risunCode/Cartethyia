import { Elysia, t } from "elysia";
import { errorResponse, requireGlobalAdmin, requireTenantScope } from "../shared/errors";
import { parseQueryLimit } from "../shared/query";
import type { AuditRoutesConfig } from "./contracts";

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

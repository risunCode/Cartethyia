import { Database } from "bun:sqlite";
import type { RouteHealth, RouteScope } from "../../../application/contracts";
import { nowIso, orNullString, toErrorKind, toRouteStatus } from "../schema";
import type { AccountHealthRow } from "../mappers";
import type { HealthRepository } from "../records";

/** Hardcoded allowlist of health tables and key columns — defense against interpolation. */
const HEALTH_TABLES = new Set(["provider_account_health", "proxy_health"]);
const HEALTH_KEY_COLUMNS = new Set(["account_id", "proxy_id"]);

export function createHealthRepository(db: () => Database, table: string, keyColumn: string, scope: RouteScope): HealthRepository {
  if (!HEALTH_TABLES.has(table) || !HEALTH_KEY_COLUMNS.has(keyColumn)) {
    throw new Error(`Refusing to query unknown health table: ${table}`);
  }
  const toHealth = (row: AccountHealthRow): RouteHealth => ({
    scope,
    status: toRouteStatus(row.status),
    statusCode: row.status_code,
    failureKind: toErrorKind(row.error_kind),
    sanitizedMessage: orNullString(row.sanitized_message),
    occurredAt: row.occurred_at,
    retryAt: row.retry_at,
  });
  return {
    async get(routeId: string): Promise<RouteHealth | null> {
      const row = db().query(`SELECT status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at FROM ${table} WHERE ${keyColumn} = ?`).get(routeId) as AccountHealthRow | null;
      return row ? toHealth(row) : null;
    },
    async list(): Promise<RouteHealth[]> {
      const rows = db().query(`SELECT status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at FROM ${table}`).all() as AccountHealthRow[];
      return rows.map(toHealth);
    },
    async listWithIds(routeIds?: readonly string[]): Promise<readonly { readonly id: string; readonly health: RouteHealth }[]> {
      const placeholders = routeIds !== undefined && routeIds.length > 0 ? routeIds.map(() => "?").join(",") : "";
      const where = placeholders.length > 0 ? ` WHERE ${keyColumn} IN (${placeholders})` : "";
      const rows = db().query(`SELECT ${keyColumn} AS route_id, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at FROM ${table}${where}`).all(...(routeIds ?? [])) as Array<AccountHealthRow & { route_id: string }>;
      return rows.map((row) => ({ id: row.route_id, health: toHealth(row) }));
    },
    async upsert(routeId: string, health: RouteHealth): Promise<void> {
      // Route health is observability: never fail the caller when the
      // configured account/proxy row is absent (legacy behavior guard).
      const parentTable = scope === "proxy" ? "proxies" : "provider_accounts";
      const parentKey = scope === "proxy" ? "id" : "id";
      if (db().query(`SELECT 1 FROM ${parentTable} WHERE ${parentKey} = ?`).get(routeId) === null) return;
      db().query(
        `INSERT INTO ${table} (${keyColumn}, status, error_kind, status_code, sanitized_message, occurred_at, retry_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(${keyColumn}) DO UPDATE SET status = excluded.status, error_kind = excluded.error_kind, status_code = excluded.status_code, sanitized_message = excluded.sanitized_message, occurred_at = excluded.occurred_at, retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
      ).run(routeId, health.status, health.failureKind, health.statusCode, health.sanitizedMessage, health.occurredAt, health.retryAt, nowIso());
    },
    async clear(routeId: string): Promise<void> {
      db().query(`DELETE FROM ${table} WHERE ${keyColumn} = ?`).run(routeId);
    },
  };
}


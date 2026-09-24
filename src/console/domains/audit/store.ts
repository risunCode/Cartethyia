import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { adminAuditLog, consoleUsers } from "../../../persistence/schema";
import { decodeCursor as decodeGenericCursor, encodeCursor } from "../../../persistence/page-cursor";
import type { AuditEntry, AuditListPage, AuditReadStore } from "./contracts";

/**
 * Opaque, monotonic (createdAt, id) cursor. `createdAt` alone is not unique
 * — two audits in the same millisecond would silently skip one row across
 * pages — so we tie-break on id and encode both.
 */
interface AuditCursor {
  createdAt: string;
  id: string;
}

function decodeCursor(cursor: string | undefined): AuditCursor | undefined {
  const parsed = decodeGenericCursor<AuditCursor>(cursor);
  if (!parsed || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return undefined;
  if (Number.isNaN(new Date(parsed.createdAt).getTime())) return undefined;
  return parsed;
}

function mapAuditRow(
  row: typeof adminAuditLog.$inferSelect,
  actorNames: ReadonlyMap<string, string>,
): AuditEntry {
  const actorName = actorNames.get(row.actor);
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actor: row.actor,
    ...(actorName ? { actorName } : {}),
    tenantId: row.tenantId,
    action: row.action,
    target: row.target,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escape LIKE metacharacters so a name filter matches literally. */
function likePattern(filter: string): string {
  return `%${filter.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

/**
 * Drizzle-backed audit reader used by the console. Rows are filtered by the
 * caller's tenant id; platform admins also observe rows where
 * `tenant_id IS NULL` (platform-wide events such as `security.ip_banned` and
 * `backup.reset`). No cross-tenant leakage is possible without the caller
 * flipping `platformAdmin=true`, which the domain layer only sets when the
 * access decision already carries `platform:admin`.
 */
export class DrizzleAuditReadStore implements AuditReadStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  /**
   * Console user ids whose username, email, or display name matches `filter`
   * (case-insensitive substring). Lets the actor filter accept a human name
   * instead of demanding the raw stored actor id.
   */
  private async resolveUserIdsByName(filter: string): Promise<string[]> {
    const pattern = likePattern(filter);
    const rows = await this.db
      .select({ id: consoleUsers.id })
      .from(consoleUsers)
      .where(
        or(
          ilike(consoleUsers.username, pattern),
          ilike(consoleUsers.email, pattern),
          ilike(consoleUsers.displayName, pattern),
        ),
      )
      .limit(50);
    return rows.map((row) => row.id);
  }

  /**
   * Human names for stored actor ids. Console sessions record
   * `admissionIdentity` (the `console_users` UUID), so the trail reads as
   * UUIDs without this join. Non-user actors (key ids, system strings) have
   * no row and keep their raw value; the entry simply omits `actorName`.
   */
  private async resolveActorNames(actors: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(actors.filter((actor) => UUID_SHAPE.test(actor)))];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const rows = await this.db
      .select({
        id: consoleUsers.id,
        username: consoleUsers.username,
        displayName: consoleUsers.displayName,
        email: consoleUsers.email,
      })
      .from(consoleUsers)
      .where(inArray(consoleUsers.id, ids));
    for (const row of rows) {
      names.set(row.id, row.displayName ?? row.username ?? row.email ?? row.id);
    }
    return names;
  }

  async list(params: {
    tenantId: string;
    platformAdmin: boolean;
    limit: number;
    cursor?: string;
    action?: string;
    actor?: string;
  }): Promise<AuditListPage> {
    const cursor = decodeCursor(params.cursor);
    const tenantFilter = params.platformAdmin
      ? globalOrOwnedBy(adminAuditLog.tenantId, params.tenantId)
      : ownedByOnly(adminAuditLog.tenantId, params.tenantId);
    const filters = [tenantFilter];
    if (params.action) filters.push(eq(adminAuditLog.action, params.action));
    if (params.actor) {
      const accepted = [params.actor, ...(await this.resolveUserIdsByName(params.actor))];
      filters.push(inArray(adminAuditLog.actor, accepted));
    }
    if (cursor) {
      // Rows strictly older than the last-seen (createdAt, id) pair.
      filters.push(
        sql`(${adminAuditLog.createdAt}, ${adminAuditLog.id}) < (${new Date(cursor.createdAt)}, ${cursor.id})`,
      );
    }

    const rows = await this.db
      .select()
      .from(adminAuditLog)
      .where(and(...filters))
      .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
      .limit(params.limit + 1);

    const overflow = rows.length > params.limit;
    const trimmed = overflow ? rows.slice(0, params.limit) : rows;
    const actorNames = await this.resolveActorNames(trimmed.map((row) => row.actor));
    const entries = trimmed.map((row) => mapAuditRow(row, actorNames));
    const lastEntry = entries[entries.length - 1];
    const nextCursor =
      overflow && lastEntry !== undefined
        ? encodeCursor({ createdAt: lastEntry.createdAt, id: lastEntry.id })
        : undefined;
    return nextCursor ? { entries, nextCursor } : { entries };
  }
}

/**
 * Backup and restore HTTP surface.
 *
 * `GET /backup/export` streams the payload as a download; `POST /backup/import`
 * accepts a file and restores it, detecting whether it is one of our own
 * backups or a router export.
 *
 * Both require the operator's console password in the body/query, not merely a
 * session: an export is the entire configuration in the clear — every provider
 * credential and API-key hash — and an import replaces it. A stolen session
 * cookie should not be enough to walk away with the secrets or overwrite them,
 * so this is the one console surface that re-authenticates.
 *
 * The body bound is enforced here, before the JSON parse, because the whole
 * point of the limit is to not buffer an unbounded file.
 */
import { Elysia, t } from "elysia";
import type { ConsoleAccessResolver } from "../auth/access";
import { ConsoleDomainError, errorResponse, requireAnyScope } from "../shared/errors";
import { MAX_BACKUP_BYTES } from "./contracts";
import type { BackupSection } from "./contracts";
import type { BackupService } from "./service";

export interface BackupRoutesConfig {
  readonly accessResolver: ConsoleAccessResolver;
  /**
   * Builds the service for one request. A factory rather than an instance
   * because re-authentication reads the caller's session, and a shared
   * instance would have to hold one request's identity across others.
   */
  readonly backupFor: (request: Request) => BackupService;
}

/**
 * Scopes that may export or restore configuration.
 *
 * `dashboard:write` is the console session. It is the only scope that can
 * actually complete either action: both re-authenticate by verifying the
 * operator's password against their session's user row, and a tenant API key
 * carries no session, so a key reaching this route fails at that gate rather
 * than at the scope check. The scope list is stated in full anyway so the
 * rejection a key receives names the scope it would need, instead of implying
 * the route is open to a credential that can never satisfy it.
 */
const BACKUP_SCOPES = ["dashboard:write"] as const;

const importBody = t.Object({
  password: t.String(),
  backup: t.Unknown(),
});

const exportQuery = t.Object({
  password: t.String(),
  sections: t.Optional(t.String()),
});

function parseSections(raw: string | undefined): readonly BackupSection[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0) as readonly BackupSection[];
}

export function createBackupRoutes(config: BackupRoutesConfig): Elysia {
  return new Elysia({ prefix: "/backup" })
    .get("/export", { query: exportQuery }, async ({ request, query, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const backup = config.backupFor(request);
        const sections = parseSections(query.sections);
        const { payload } = await backup.export({
          password: query.password,
          tenantId: access.tenantId,
          ...(sections === undefined ? {} : { sections }),
        });
        set.headers["content-disposition"] = `attachment; filename="cartethyia-backup-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.json"`;
        set.headers["content-type"] = "application/json; charset=utf-8";
        // A backup must never be cached by a proxy or the browser.
        set.headers["cache-control"] = "no-store";
        return payload;
      } catch (error) {
        return errorResponse(error, set, "Backup export failed");
      }
    })
    .post("/import", { body: importBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) {
          set.status = 413;
          return {
            error: `backup exceeds the ${MAX_BACKUP_BYTES} byte limit`,
            code: "request_too_large",
          };
        }
        // The restoring tenant comes from the caller's own access decision and
        // from nowhere else. A request body may not name the tenant it writes
        // into: that would let any holder of the scope import into, and
        // overwrite, a tenant they are not.
        const result = await config.backupFor(request).restore(body.password, body.backup, access.tenantId);
        set.status = 200;
        return result;
      } catch (error) {
        return errorResponse(error, set, "Backup import failed");
      }
    }) as unknown as Elysia;
}

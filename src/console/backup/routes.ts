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
import { invalidateApiKeyCache } from "../../security/api-key-auth";
import { ConsoleDomainError, errorResponse, requireAnyScope } from "../shared/errors";
import { MAX_BACKUP_BYTES } from "./contracts";
import type { BackupSection } from "./contracts";
import { DELETE_ALL_SCOPES } from "./store";
import type { BackupService } from "./service";
import type { AuditSink } from "../domains/audit/contracts";

export interface BackupRoutesConfig {
  readonly accessResolver: ConsoleAccessResolver;
  /**
   * Builds the service for one request. A factory rather than an instance
   * because re-authentication reads the caller's session, and a shared
   * instance would have to hold one request's identity across others.
   */
  readonly backupFor: (request: Request) => BackupService;
  /**
   * Structurally satisfied by `InMemoryRouteSnapshotService`.
   *
   * A restore replaces the rows that decide where traffic goes — providers,
   * models, aliases, and combos among them — so the cached route snapshot
   * describes a catalog that no longer exists the moment the transaction
   * commits. Without this the data plane keeps dispatching the pre-restore
   * routing (a combo that now points at different members still resolves its
   * old members) until some unrelated console write happens to invalidate.
   */
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * The tenant's API keys, read after a restore so their admission counters can
   * be purged. A restore replaces `api_keys` wholesale, so a key that was
   * revoked after the backup — and had its counters purged by `revokeKey` — can
   * come back with `revoked_at = NULL`; without purging, its lifetime counter
   * is re-seeded from the restored total, granting a fresh full budget on top
   * of everything already spent. Optional so a host that never restores keys
   * need not supply it.
   */
  readonly apiKeyStore?: { list(tenantId: string): Promise<readonly { id: string }[]> };
  /**
   * Structurally satisfied by `ApiKeyAdmissionService`. Purges one key's
   * reservation/counter state. Paired with {@link apiKeyStore} on restore.
   */
  readonly admissionService?: { purgeKey(apiKeyId: string): Promise<void> };
  readonly auditSink?: AuditSink;
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

const deleteAllBody = t.Object({
  password: t.String(),
  scopes: t.Array(t.Union(DELETE_ALL_SCOPES.map((scope) => t.Literal(scope))), { minItems: 1 }),
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
        // Enforce against actual received bytes, not just the declared header:
        // a missing or spoofed content-length would otherwise bypass the 413
        // and buffer an unbounded file into JSON.parse. Elysia has already
        // parsed the body here, so measure the re-serialized form — an
        // over-limit file still fails closed before restore touches the DB.
        const declared = Number(request.headers.get("content-length") ?? "0");
        const actualBytes = JSON.stringify(body ?? null).length;
        if (
          (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) ||
          actualBytes > MAX_BACKUP_BYTES
        ) {
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
        // Routing-visible write: the restore has committed, so the cached
        // snapshot must be rebuilt before the next `/v1/*` dispatch.
        await config.snapshotInvalidator?.invalidate();
        // A restore can re-insert keys the tenant revoked after the backup, and
        // `revokeKey` purged their counters when they went away. Drop the whole
        // auth cache (the restore is rare, and a stale entry for any key must
        // not survive it) and purge admission state for every key the tenant
        // now has, so a resurrected key cannot start with a fresh budget.
        if (result.restored.api_keys !== undefined) {
          invalidateApiKeyCache();
          const keys = await config.apiKeyStore?.list(access.tenantId);
          if (keys && config.admissionService) {
            const admission = config.admissionService;
            await Promise.all(keys.map((key) => admission.purgeKey(key.id)));
          }
        }
        set.status = 200;
        return result;
      } catch (error) {
        return errorResponse(error, set, "Backup import failed");
      }
    })
    .post("/delete-all", { body: deleteAllBody }, async ({ request, body, set }) => {
      try {
        const access = requireAnyScope(config.accessResolver(request), BACKUP_SCOPES);
        if (access.tenantId === null) {
          throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
        }
        const result = await config.backupFor(request).deleteAll(body.password, body.scopes, access.tenantId);
        await config.auditSink?.record({
          access,
          action: "backup.delete_all",
          target: access.tenantId,
          detail: { scopes: [...new Set(body.scopes)], deleted: result.deleted },
        });
        invalidateApiKeyCache();
        await Promise.allSettled([
          config.snapshotInvalidator?.invalidate(),
          ...(config.admissionService
            ? result.apiKeyIds.map((id) => config.admissionService?.purgeKey(id))
            : []),
        ]);
        set.status = 200;
        return { deleted: result.deleted };
      } catch (error) {
        return errorResponse(error, set, "Delete all failed");
      }
    }) as unknown as Elysia;
}

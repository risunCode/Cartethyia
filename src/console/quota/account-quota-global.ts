import { t } from "elysia";
import type { Elysia } from "elysia";
import { and, eq, isNull } from "drizzle-orm";
import { adminAuditLog, providerAccounts } from "../../persistence/schema";
import { requireGlobalAdmin } from "../shared/errors";
import { GLOBAL_QUOTA_LENS, invalidateQuotaCache } from "./quota-cache";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  loadQuotaTarget,
  refreshAccountQuota,
  signalFetch,
  timeoutSignal,
  type QuotaRefreshDeps,
} from "./quota-refresh";
import { sanitizeGlobalAccount } from "./account-quota-view";
import {
  ACCOUNT_STATUSES,
  type AccountQuotaRoutesDeps,
  type AccountStatus,
} from "./account-quota-shared";

/**
 * Registers the platform-admin account/quota routes onto `app`. Every route here
 * authorises through `requireGlobalAdmin` and operates on shared accounts
 * (`tenant_id IS NULL`).
 */
export function registerAccountQuotaGlobalRoutes(
  app: Elysia,
  deps: AccountQuotaRoutesDeps,
  refreshDeps: QuotaRefreshDeps,
): void {
  const { db, accessResolver, redis, snapshotInvalidator } = deps;
  app
    .get("/global/accounts", async ({ request }) => {
      requireGlobalAdmin(accessResolver(request));
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(isNull(providerAccounts.tenantId));
      return { accounts: rows.map(sanitizeGlobalAccount) };
    })
    .patch(
      "/global/accounts/:id",
      {
        body: t.Object({
          active: t.Optional(t.Boolean()),
          status: t.Optional(t.String()),
        }),
      },
      async ({ request, params, body, set }) => {
        const access = requireGlobalAdmin(accessResolver(request));
        if (body.status !== undefined && !ACCOUNT_STATUSES.includes(body.status as AccountStatus)) {
          set.status = 400;
          return {
            error: `status must be one of: ${ACCOUNT_STATUSES.join(", ")}`,
            code: "invalid_status",
          };
        }
        const nextStatus: AccountStatus | undefined =
          body.active !== undefined
            ? body.active
              ? "active"
              : "disabled"
            : (body.status as AccountStatus | undefined);
        if (!nextStatus) {
          set.status = 400;
          return { error: "active or status is required", code: "invalid_request" };
        }
        const updated = await db
          .update(providerAccounts)
          .set({ status: nextStatus })
          .where(
            and(
              eq(providerAccounts.id, params.id),
              isNull(providerAccounts.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        if (updated.length === 0) {
          set.status = 404;
          return { error: `Global account ${params.id} not found`, code: "not_found" };
        }
        await snapshotInvalidator?.invalidate();
        await db.insert(adminAuditLog).values({
          actor: access.admissionIdentity,
          action: "provider_account.global.updated",
          target: params.id,
          detail: { status: nextStatus },
        });
        return { ok: true, status: 200 };
      },
    )
    .delete("/global/accounts/:id", async ({ request, params, set }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const accountId = params.id;
      // Global accounts carry `tenant_id IS NULL`, so the tenant-scoped
      // `DELETE /accounts/:id` can never match them (`NULL = <uuid>` is never
      // true) — the console's delete button 404'd on every shared account.
      // This route is the global-admin counterpart, scoped by `isNull` instead
      // of a tenant id.
      const deleted = await db
        .delete(providerAccounts)
        .where(and(eq(providerAccounts.id, accountId), isNull(providerAccounts.tenantId)))
        .returning({ id: providerAccounts.id });
      if (deleted.length === 0) {
        set.status = 404;
        return { error: `Global account ${accountId} not found`, code: "not_found" };
      }
      // Global accounts cache their quota under the shared lens, so that is the
      // entry to drop — nothing can make the value meaningful again.
      await invalidateQuotaCache(GLOBAL_QUOTA_LENS, accountId, redis);
      await snapshotInvalidator?.invalidate();
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.global.deleted",
        target: accountId,
      });
      return { success: true };
    })
    .post("/global/accounts/:id/quota/refresh", async ({ request, params, set }) => {
      const access = requireGlobalAdmin(accessResolver(request));
      const target = await loadQuotaTarget(db, params.id);
      if (!target) {
        set.status = 404;
        return { error: `Global account ${params.id} not found`, code: "not_found" };
      }
      const outcome = await refreshAccountQuota(
        refreshDeps,
        target,
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
      );
      if (outcome.failure === "missing_credential") {
        set.status = 400;
        return { error: "Global account has no stored credential", code: "missing_credential" };
      }
      if (outcome.quota.error !== null) {
        set.status = 502;
        return {
          ok: false,
          error: outcome.quota.error,
          code: "quota_fetch_failed",
        };
      }
      await db.insert(adminAuditLog).values({
        actor: access.admissionIdentity,
        action: "provider_account.global.refreshed",
        target: target.accountId,
        detail: { providerId: target.providerId },
      });
      return { ok: true, status: 200, accountId: target.accountId };
    });
}

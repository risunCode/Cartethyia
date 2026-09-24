import { t } from "elysia";
import type { Elysia } from "elysia";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { providerAccounts, providers } from "../../persistence/schema";
import { providerDisplayName } from "../../providers/provider-metadata";
import { requireTenantScope } from "../shared/errors";
import {
  GLOBAL_QUOTA_LENS,
  getCachedQuotaEntries,
  getCachedQuotaEntry,
  invalidateQuotaCache,
} from "./quota-cache";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  refreshAccountQuota,
  signalFetch,
  timeoutSignal,
  type QuotaRefreshDeps,
  type QuotaRefreshFailureCode,
} from "./quota-refresh";
import type { ProviderId } from "../../providers/provider-registry";
import {
  DAILY_CHECKIN_PROVIDER_IDS,
  checkinDayKey,
  ledgerKey,
} from "../../workers/daily-checkin";
import {
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../../providers/integrations/buddy/buddy-checkin";
import { buddyAccountUid } from "../../providers/integrations/buddy/buddy-oauth-shared";
import {
  supportsAccountReset,
  consumeAccountResetCredit,
  listAccountResetCredits,
} from "../../providers/operations/account-reset-service";
import {
  enqueueBackgroundQuotaRefresh,
  pendingQuotaRefreshes,
  toQuotaView,
} from "./account-quota-view";
import {
  ACCOUNT_STATUSES,
  type AccountQuotaRoutesDeps,
  type AccountStatus,
} from "./account-quota-shared";

/** Daily check-in only exists on the buddy billing facade; everything else 400s with intent. */
function supportsAccountCheckin(providerId: string): boolean {
  return (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** One account's check-in through the buddy billing facade. */
async function runAccountCheckin(
  account: { id: string; providerId: string },
  credential: string,
  forceClaim: boolean,
): Promise<DailyCheckinResult> {
  return fetchDailyCheckin({
    providerId: account.providerId,
    accountId: account.id,
    credential,
    fetcher: globalThis.fetch,
    ...(forceClaim ? { forceClaim } : {}),
  });
}

/**
 * Reads the sweep ledger for today's check-in slot: a present marker means the
 * sweep already attempted this account today, so the card can show the state
 * without spending an upstream request. Absent (or unreadable) means unknown —
 * never "not claimed", since the sweep may simply not have reached it yet.
 */
async function todayCheckinAttempted(
  redis: AccountQuotaRoutesDeps["redis"],
  accountId: string,
): Promise<boolean> {
  try {
    const marker = await redis.get(ledgerKey(checkinDayKey(), accountId));
    return marker !== null;
  } catch {
    return false;
  }
}

function checkinStateMessage(result: DailyCheckinResult): string {
  switch (result.state) {
    case "claimed":
      return result.credit !== null
        ? `Daily check-in claimed (+${result.credit} credits${result.streakDays !== null ? `, ${result.streakDays}-day streak` : ""})`
        : "Daily check-in claimed";
    case "already_claimed":
      return "Already checked in today";
    case "not_eligible":
      return "Account is not eligible for daily check-in";
    case "event_ended":
      return "Daily check-in event has ended";
    case "unavailable":
      return result.error ?? "Daily check-in is unavailable";
    case "error":
      return result.error ?? "Daily check-in failed";
  }
}

const QUOTA_REFRESH_CONCURRENCY = 5;
const QUOTA_REFRESH_MAX_IDS = 100;

/**
 * How stale a cached value may be before the overview asks for a refresh.
 *
 * The cache TTL is 300 s, so a value older than this is close enough to expiry
 * that re-fetching now avoids the page ever rendering an expired entry. The
 * background queue dedupes, so a page that polls every couple of seconds still
 * produces at most one upstream fetch per account per window.
 */
const QUOTA_STALE_AFTER_MS = 240_000;

/**
 * Registers the tenant-scoped account/quota routes onto `app`. Every route here
 * authorises through `requireTenantScope`, so the caller only ever touches its
 * own tenant's accounts.
 */
export function registerAccountQuotaTenantRoutes(
  app: Elysia,
  deps: AccountQuotaRoutesDeps,
  refreshDeps: QuotaRefreshDeps,
): void {
  const { db, accessResolver, redis, snapshotInvalidator, auditRecorder, providerRegistry } = deps;
  app
    .get("/quota/overview", async ({ request }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select({
          id: providerAccounts.id,
          providerId: providerAccounts.providerId,
          tenantId: providerAccounts.tenantId,
          label: providerAccounts.label,
          credentialKind: providerAccounts.credentialKind,
          status: providerAccounts.status,
          lastError: providerAccounts.lastError,
          lastErrorCategory: providerAccounts.lastErrorCategory,
          lastSuccessAt: providerAccounts.lastSuccessAt,
        })
        .from(providerAccounts)
        .innerJoin(providers, eq(providerAccounts.providerId, providers.id))
        .where(
          and(
            or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
            or(isNull(providers.tenantId), eq(providers.tenantId, access.tenantId)),
          ),
        );

      // One batch read per lens instead of one round trip per account: the page
      // renders every account at once, so per-account reads would make opening
      // it scale with the account count.
      const ownedIds: string[] = [];
      const globalIds: string[] = [];
      for (const row of rows) {
        if (row.tenantId === null) globalIds.push(row.id);
        else ownedIds.push(row.id);
      }
      const [ownedCache, globalCache] = await Promise.all([
        getCachedQuotaEntries(access.tenantId, ownedIds, redis),
        getCachedQuotaEntries(GLOBAL_QUOTA_LENS, globalIds, redis),
      ]);

      const now = Date.now();
      const pending = pendingQuotaRefreshes();
      const providerIds = [...new Set(rows.map((row) => row.providerId))];
      // The dropdown is a quota-page control, not a provider directory: only
      // providers whose registry entry can actually answer a quota fetch
      // appear, so key-only providers with no quota endpoint never show up.
      const quotaProviders = providerIds.filter((providerId) =>
        providerRegistry.hasQuotaCollector(providerId),
      );
      const providersSummary = quotaProviders
        .sort((left, right) => left.localeCompare(right))
        .map((providerId) => ({
          id: providerId,
          name: providerDisplayName(providerId),
          icon: providerId,
        }));
      let refreshing = 0;
      // The sweep's day markers answer "attempted today" without an upstream
      // request; only check-in-capable accounts can carry one, so only they
      // are read.
      const checkinCandidates = rows.filter((row) => supportsAccountCheckin(row.providerId));
      const checkinAttempted = new Map<string, boolean>();
      await Promise.all(
        checkinCandidates.map(async (row) => {
          checkinAttempted.set(row.id, await todayCheckinAttempted(redis, row.id));
        }),
      );
      const accounts = rows.map((row) => {
        const entry =
          row.tenantId === null ? globalCache.get(row.id) : ownedCache.get(row.id);
        const ageMs = entry?.fetchedAt ? now - new Date(entry.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
        // Providers with no quota collector (custom BYOK endpoints, key-only
        // providers) intentionally never refresh: there is no upstream quota
        // endpoint to ask, so enqueueing would only manufacture the
        // "not available" error the page would then have to explain away.
        const canRefresh = providerRegistry.hasQuotaCollector(row.providerId);
        const wantsRefresh = canRefresh && ageMs >= QUOTA_STALE_AFTER_MS;
        if (wantsRefresh) {
          enqueueBackgroundQuotaRefresh(refreshDeps, {
            accountId: row.id,
            providerId: row.providerId,
            tenantId: row.tenantId,
            credentialKind: row.credentialKind,
          });
        }
        const isRefreshing = canRefresh && (pending.has(row.id) || entry === undefined);
        return {
          id: row.id,
          provider: row.providerId,
          name: row.label || row.id,
          credentialHint: row.credentialKind,
          active: row.status === "active",
          quota: entry
            ? toQuotaView(entry.quota, row, {
                fetchedAt: entry.fetchedAt,
                ...(isRefreshing ? { status: "refreshing" as const } : {}),
              })
            : null,
          pending: isRefreshing,
          health: {
            status: row.status,
            sanitizedMessage: row.lastError ?? null,
            lastErrorCategory: row.lastErrorCategory ?? null,
          },
          providerName: providerDisplayName(row.providerId),
          providerIcon: row.providerId,
          // Present only on buddy accounts. `attemptedToday` is the sweep
          // ledger (no upstream cost); the card combines it with the manual
          // trigger result to render claimed / already / due / unknown.
          ...(supportsAccountCheckin(row.providerId)
            ? { checkin: { attemptedToday: checkinAttempted.get(row.id) ?? false } }
            : {}),
        };
      });

      // `refreshing > 0` tells the client to poll quickly; once the worker has
      // filled everything this drops to 0 and the client falls back to its slow
      // cadence without a manual reload.
      return { providers: providersSummary, accounts, refreshing };
    })
    .get("/accounts/:id/quota", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const accountId = params.id;
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // No quota collector means no upstream surface to ask: answer the
      // untracked state directly instead of caching a manufactured error.
      if (!providerRegistry.hasQuotaCollector(account.providerId)) {
        return {
          accountId,
          quota: null,
          health: {
            status: account.status,
            sanitizedMessage: account.lastError ?? null,
            lastErrorCategory: account.lastErrorCategory ?? null,
          },
        };
      }
      const cached = await getCachedQuotaEntry(access.tenantId, accountId, redis);
      if (cached) {
        return {
          accountId,
          quota: toQuotaView(cached.quota, account, { fetchedAt: cached.fetchedAt }),
          health: {
            status: account.status,
            sanitizedMessage: account.lastError ?? null,
            lastErrorCategory: account.lastErrorCategory ?? null,
          },
        };
      }

      // Cold read: this is the one path that legitimately waits on upstream, and
      // it shares the in-flight fetch with any queued background fill so a cold
      // page open never issues two requests for the same account.
      const outcome = await refreshAccountQuota(
        refreshDeps,
        { accountId, providerId: account.providerId, tenantId: account.tenantId, credentialKind: account.credentialKind },
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
      );
      const fresh = await getCachedQuotaEntry(access.tenantId, accountId, redis);
      return {
        accountId,
        quota: toQuotaView(outcome.quota, account, {
          fetchedAt: fresh?.fetchedAt ?? new Date().toISOString(),
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: outcome.quota.error === null ? new Date().toISOString() : null,
        }),
        health: {
          status: account.status,
          sanitizedMessage: account.lastError ?? null,
          lastErrorCategory: account.lastErrorCategory ?? null,
        },
      };
    })
    .post("/accounts/:id/quota/refresh", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const accountId = params.id;
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // Manual refresh on a collectorless provider is a no-op by design, not
      // a 502: there is nothing upstream to probe.
      if (!providerRegistry.hasQuotaCollector(account.providerId)) {
        return { ok: true, status: 200, data: { id: accountId, quota: null } };
      }

      const attemptedAt = new Date().toISOString();
      const outcome = await refreshAccountQuota(
        refreshDeps,
        { accountId, providerId: account.providerId, tenantId: account.tenantId, credentialKind: account.credentialKind },
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
      );
      const httpStatus = outcome.quota.error === null ? 200 : 502;
      set.status = httpStatus;
      return {
        ok: outcome.quota.error === null,
        status: httpStatus,
        data: {
          id: accountId,
          quota: toQuotaView(outcome.quota, account, {
            fetchedAt: attemptedAt,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: outcome.quota.error === null ? attemptedAt : null,
          }),
        },
        message: outcome.quota.error ?? undefined,
      };
    })
    .post(
      "/quota/refresh",
      {
        body: t.Optional(
          t.Object({
            accountIds: t.Optional(t.Array(t.String())),
            ids: t.Optional(t.Array(t.String())),
          }),
        ),
      },
      async ({ request, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const ids = body?.accountIds ?? body?.ids ?? [];
        if (ids.length === 0) {
          set.status = 400;
          return { error: "accountIds must be a non-empty array", code: "invalid_request" };
        }
        if (ids.length > QUOTA_REFRESH_MAX_IDS) {
          set.status = 400;
          return {
            error: `accountIds exceeds the limit of ${QUOTA_REFRESH_MAX_IDS}`,
            code: "invalid_request",
          };
        }
        const accounts = await db
          .select({
            accountId: providerAccounts.id,
            providerId: providerAccounts.providerId,
            tenantId: providerAccounts.tenantId,
            credentialKind: providerAccounts.credentialKind,
          })
          .from(providerAccounts)
          .where(
            and(
              inArray(providerAccounts.id, ids),
              or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
            ),
          );
        // Collectorless accounts are done without a fetch: counted as
        // succeeded with no quota, never as failures.
        const refreshable = accounts.filter((account) => providerRegistry.hasQuotaCollector(account.providerId));

        const timedFetch = signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS));
        const failures: Array<{
          accountId: string;
          code: QuotaRefreshFailureCode;
          message: string;
        }> = [];
        let succeeded = accounts.length - refreshable.length;
        let cursor = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(QUOTA_REFRESH_CONCURRENCY, refreshable.length) },
            async () => {
              while (cursor < refreshable.length) {
                const target = refreshable[cursor++]!;
                const outcome = await refreshAccountQuota(refreshDeps, target, timedFetch);
                if (outcome.failure !== null) {
                  failures.push({
                    accountId: target.accountId,
                    code: outcome.failure,
                    message: outcome.quota.error ?? "Failed to refresh quota",
                  });
                  continue;
                }
                succeeded += 1;
              }
            },
          ),
        );

        return {
          ok: failures.length === 0,
          queued: accounts.length,
          succeeded,
          failed: failures.length,
          failures,
          accountIds: accounts.map((a) => a.accountId),
        };
      },
    )
    .patch(
      "/accounts/:id",
      {
        body: t.Object({
          active: t.Optional(t.Boolean()),
          status: t.Optional(t.String()),
        }),
      },
      async ({ request, params, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
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
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        if (updated.length === 0) {
          set.status = 404;
          return { error: `Account ${params.id} not found`, code: "not_found" };
        }
        // A status flip must not drop a good cached quota: the value is an
        // upstream fact that the flip does not change, and clearing it would
        // blank the card the user is looking at. Only the route snapshot
        // (dispatch eligibility) needs to change.
        await snapshotInvalidator?.invalidate();
        return { ok: true, status: 200 };
      },
    )
    .patch(
      "/accounts/batch",
      {
        body: t.Object({
          ids: t.Array(t.String()),
          active: t.Boolean(),
        }),
      },
      async ({ request, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        if (body.ids.length === 0) return { ok: true, updated: 0 };
        if (body.ids.length > QUOTA_REFRESH_MAX_IDS) {
          set.status = 400;
          return {
            error: `ids exceeds the limit of ${QUOTA_REFRESH_MAX_IDS}`,
            code: "invalid_request",
          };
        }
        const status = body.active ? ("active" as const) : ("disabled" as const);
        const updated = await db
          .update(providerAccounts)
          .set({ status })
          .where(
            and(
              inArray(providerAccounts.id, body.ids),
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        await snapshotInvalidator?.invalidate();
        return {
          ok: true,
          status: 200,
          data: {
            updated: updated.length,
            ids: updated.map((row) => row.id),
          },
        };
      },
    )
    .delete("/accounts/:id", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const accountId = params.id;
      const deleted = await db
        .delete(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .returning({ id: providerAccounts.id });
      if (deleted.length === 0) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // The account is gone, so its cached quota must go with it — unlike a
      // status flip, nothing can make this value meaningful again.
      await invalidateQuotaCache(access.tenantId, accountId, redis);
      await snapshotInvalidator?.invalidate();
      await auditRecorder?.record({
        access,
        action: "provider_account.deleted",
        target: accountId,
      });
      return { success: true };
    })
    .post("/accounts/:id/checkin", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountCheckin(account.providerId)) {
        set.status = 400;
        return {
          error: `Daily check-in is not supported for provider ${account.providerId}`,
          code: "checkin_unsupported",
        };
      }
      // A manual trigger is the operator asserting "try now", so it bypasses
      // the sweep's once-per-day ledger and forces the status probe. The
      // upstream itself stays idempotent: a duplicate claim answers
      // `already_claimed`, never a double grant.
      let result: DailyCheckinResult;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        result = await runAccountCheckin(account, credential, true);
      } catch (error) {
        result = {
          providerId: account.providerId,
          accountId: account.id,
          state: "error",
          credit: null,
          streakDays: null,
          error: error instanceof Error ? error.message : "Daily check-in failed.",
        };
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, state: result.state },
          message: result.error ?? "Daily check-in failed",
          code: "checkin_failed",
        };
      }
      return {
        ok: true,
        status: 200,
        data: {
          id: account.id,
          state: result.state,
          credit: result.credit,
          streakDays: result.streakDays,
        },
        message: checkinStateMessage(result),
      };
    })
    .post("/accounts/:id/activity-report", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountCheckin(account.providerId)) {
        set.status = 400;
        return {
          error: `Activity report is not supported for provider ${account.providerId}`,
          code: "report_unsupported",
        };
      }
      // One report per account per day lights the login streak; more is
      // rate-limit bait, so the sweep's check-in day marker gates this too.
      // The marker only proves an attempt happened today — the growth event is
      // a different upstream call, but sharing the marker keeps the "one
      // growth action per day" budget honest across both buttons.
      let alreadyReported = false;
      try {
        alreadyReported = (await redis.get(ledgerKey(checkinDayKey(), account.id))) !== null;
      } catch {
        alreadyReported = false;
      }
      if (alreadyReported) {
        return {
          ok: true,
          status: 200,
          data: { id: account.id, state: "reported", alreadyToday: true },
          message: "Activity already reported today",
        };
      }
      let result: BuddyActivityReportResult;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        // The growth event scores by uid, and only a JWT carries one. An
        // opaque API key must fail closed here — reporting it under another
        // account's uid would poison someone else's streak.
        const userId = buddyAccountUid(credential);
        if (!userId) {
          set.status = 400;
          return {
            error: "Activity report needs an OAuth account (no uid in this credential)",
            code: "report_requires_oauth",
          };
        }
        result = await fetchBuddyActivityReport({
          providerId: account.providerId,
          accountId: account.id,
          credential,
          userId,
          fetcher: globalThis.fetch,
        });
      } catch (error) {
        result = {
          providerId: account.providerId,
          accountId: account.id,
          state: "error",
          error: error instanceof Error ? error.message : "Activity report failed.",
        };
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, state: result.state },
          message: result.error ?? "Activity report failed",
          code: "report_failed",
        };
      }
      return {
        ok: true,
        status: 200,
        data: { id: account.id, state: result.state, alreadyToday: false },
        message: "Activity reported — login streak lit for today",
      };
    })
    .get("/accounts/:id/resets", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountReset(account.providerId)) {
        return { availableCount: 0, credits: [] };
      }
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const list = await listAccountResetCredits(account.providerId, credential);
        return list ?? { availableCount: 0, credits: [] };
      } catch (err) {
        return { availableCount: 0, credits: [] };
      }
    })
    .post("/accounts/:id/reset", async ({ request, params, set, body }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountReset(account.providerId)) {
        set.status = 400;
        return {
          error: `Reset is not supported for provider ${account.providerId}`,
          code: "reset_unsupported",
        };
      }
      const reqBody = (body && typeof body === "object" ? body : {}) as { creditId?: string };
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const outcome = await consumeAccountResetCredit({
          db,
          accountId: account.id,
          providerId: account.providerId,
          credentialRaw: credential,
          creditId: reqBody.creditId,
          snapshotInvalidator,
        });
        if (!outcome.ok) {
          // A business no-op ("nothing_to_reset", "already_redeemed") is not a
          // client error: the request was well-formed and the provider answered.
          // Only a provider-side failure (4xx/5xx) carries a failure status.
          set.status = outcome.status >= 400 ? outcome.status : 200;
          return {
            ok: false,
            code: outcome.code,
            message: outcome.message ?? `Reset failed: ${outcome.code}`,
          };
        }
        if (auditRecorder) {
          await auditRecorder.record({
            access,
            action: "provider_account.recovered",
            target: account.id,
            detail: { reason: "rate_limit_reset_consumed", provider: account.providerId },
          });
        }
        return {
          ok: true,
          code: outcome.code,
          message: outcome.message ?? "Rate limit reset applied successfully",
          creditId: outcome.creditId,
        };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          code: "reset_failed",
          message: err instanceof Error ? err.message : "Reset operation failed",
        };
      }
    });
}

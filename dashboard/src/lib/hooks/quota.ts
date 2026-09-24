import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import { queryKeys } from "../query-keys";
import { querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


export interface QuotaProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
}

export interface QuotaWindow {
  readonly kind?: string;
  readonly label: string;
  readonly remainingPercent: number | null;
  readonly usedPercent?: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
  readonly recurring?: boolean;
}

export interface QuotaData {
  readonly source: string | null;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: QuotaWindow[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
}


export interface QuotaAccountHealth {
  readonly status: string;
  readonly statusCode?: number | null;
  readonly sanitizedMessage?: string | null;
  readonly lastErrorCategory?: string | null;
  readonly retryAt?: string | null;
}

export interface QuotaEntry {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly credentialHint: string;
  readonly active: boolean;
  readonly quota: QuotaData | null;
  /** True while the gateway is filling this account's cache in the background. */
  readonly pending?: boolean;
  readonly health: QuotaAccountHealth | null;
  readonly providerName: string;
  readonly providerIcon: string;
  /**
   * Present only on buddy-family accounts (`workbuddy`/`cb`/`cbcn`).
   * `attemptedToday` is the sweep's day marker: true means the sweep already
   * tried this account today (no upstream cost to read). False means unknown —
   * the sweep may simply not have reached it yet, never "not claimed".
   */
  readonly checkin?: {
    readonly attemptedToday: boolean;
  };
}

export interface QuotaOverview {
  readonly providers: QuotaProviderSummary[];
  readonly accounts: QuotaEntry[];
  /** Accounts the gateway is currently refreshing; drives the fast poll cadence. */
  readonly refreshing?: number;
}

/** Loads the server-joined provider/account quota projection. */
export async function fetchQuotaOverview(signal?: AbortSignal): Promise<QuotaOverview> {
  return consoleRequest<QuotaOverview>("/quota/overview", signal ? { signal } : undefined);
}

/**
 * Loads the tenant's providers/accounts joined with quota + health.
 *
 * `staleTime: 0` is deliberate: the overview is cheap (one batch cache read
 * server-side) and the gateway fills cold accounts in the background, so the
 * page must re-read to observe that fill. Polling is adaptive — while the
 * server reports accounts still being refreshed it polls at `refreshingMs`,
 * otherwise it drops to `idleMs` — so a warming page converges in seconds and
 * a settled page stops hammering the API without any manual reload.
 */
export function useQuotaOverview(options?: {
  readonly refreshingMs?: number;
  readonly idleMs?: number;
}) {
  const refreshingMs = options?.refreshingMs ?? 2_000;
  const idleMs = options?.idleMs ?? 60_000;
  return useQuery<QuotaOverview>({
    queryKey: queryKeys.quota.all,
    queryFn: (context) => fetchQuotaOverview(querySignal(context)),
    staleTime: 0,
    refetchInterval: (query) => ((query.state.data?.refreshing ?? 0) > 0 ? refreshingMs : idleMs),
    refetchIntervalInBackground: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
  });
}


/** Result of a single-account test (`POST /accounts/:id/quota/refresh`). */
export interface AccountTestResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Tests one account against its upstream provider and refreshes its views. */
export function useRefreshAccountQuota(accountId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.quota.account(accountId);
  return useMutation<AccountTestResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountTestResult>(
        `/accounts/${encodeURIComponent(accountId)}/quota/refresh`,
        {
          method: "POST",
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        // The test stamps lastSuccessAt/lastError on the account row, so the
        // account list (Last check) must refetch too — otherwise the test
        // looks like it did nothing.
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}


/** Aggregated result of one or more `/quota/refresh` batches. */
export interface QuotaRefreshResult {
  readonly ok: boolean;
  readonly queued: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<{ accountId: string; code: string; message: string }>;
}

/** Backend cap on `accountIds` per `/quota/refresh` request (mirrors `QUOTA_REFRESH_MAX_IDS`). */
const QUOTA_REFRESH_BATCH_SIZE = 100;

/** Queues a quota refresh for every account passed and invalidates the overview once queued. */
export function useRefreshAllQuotas() {
  const queryClient = useQueryClient();
  return useMutation<QuotaRefreshResult, ApiErrorShape, string[]>({
    mutationFn: async (accountIds): Promise<QuotaRefreshResult> => {
      const batches: string[][] = [];
      for (let index = 0; index < accountIds.length; index += QUOTA_REFRESH_BATCH_SIZE) {
        batches.push(accountIds.slice(index, index + QUOTA_REFRESH_BATCH_SIZE));
      }
      const results = await Promise.all(
        batches.map((batch) =>
          consoleRequest<QuotaRefreshResult>("/quota/refresh", {
            method: "POST",
            body: JSON.stringify({ accountIds: batch }),
          }),
        ),
      );
      const failures = results.flatMap((result) => result.failures);
      return {
        ok: failures.length === 0,
        queued: results.reduce((sum, result) => sum + result.queued, 0),
        succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
        failed: results.reduce((sum, result) => sum + result.failed, 0),
        failures,
      };
    },
    onSuccess: async (result, accountIds) => {
      const failed = new Set(result.failures.map((failure) => failure.accountId));
      const refreshed = accountIds.filter((accountId) => !failed.has(accountId));
      await Promise.all([
        ...refreshed.map((accountId) =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.quota.account(accountId),
            exact: true,
          }),
        ),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
      ]);
    },
  });
}

/** Enables or disables a single quota-tracked account. */
export function useUpdateAccountActive() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, ApiErrorShape, { id: string; active: boolean }>({
    mutationFn: ({ id, active }) =>
      consoleRequest<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Enables or disables a batch of quota-tracked accounts in one request. */
export function useSetAccountsActiveBatch() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiErrorShape, { ids: string[]; active: boolean }>({
    mutationFn: async ({ ids, active }) => {
      if (ids.length === 0) return;
      await consoleRequest("/accounts/batch", {
        method: "PATCH",
        body: JSON.stringify({ ids, active }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Deletes a quota-tracked account. */
export function useDeleteQuotaAccount() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiErrorShape, string>({
    mutationFn: async (accountId) => {
      await consoleRequest(`/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      });
    },
    onSuccess: async (_result, accountId) => {
      queryClient.removeQueries({ queryKey: queryKeys.quota.account(accountId), exact: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Result of one manual daily check-in trigger (`POST /accounts/:id/checkin`). */
export interface AccountCheckinResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly credit: number | null;
    readonly streakDays: number | null;
  };
}

/** Provider ids whose billing facade exposes the daily check-in routes. */
const CHECKIN_PROVIDER_IDS = new Set(["workbuddy", "cb", "cbcn"]);

/** True when the account can show a daily check-in action on its card. */
export function supportsAccountCheckin(providerId: string): boolean {
  return CHECKIN_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/** Triggers one account's daily check-in against its upstream provider. */
export function useTriggerAccountCheckin(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountCheckinResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountCheckinResult>(
        `/accounts/${encodeURIComponent(accountId)}/checkin`,
        {
          method: "POST",
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Result of one manual growth-activity report (`POST /accounts/:id/activity-report`). */
export interface AccountActivityReportResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly alreadyToday: boolean;
  };
}

/** Result of one manual growth pass: check-in claim + activity report. */
export interface AccountGrowthPassResult {
  /** Human summary covering both steps, e.g. what happened per step. */
  readonly message: string;
  /** True only when both steps succeeded. */
  readonly ok: boolean;
  readonly checkin: AccountCheckinResult;
  readonly report: AccountActivityReportResult;
}

/**
 * Runs the full daily growth pass for one account: check-in claim first, then
 * the growth-activity report. Sequential — the report only fires when the
 * check-in step does not hard-fail, so one toast tells the whole story.
 */
/** Runs the full daily growth pass for one account: check-in claim first, then
 * the growth-activity report. */
export function useTriggerGrowthPass(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountGrowthPassResult, ApiErrorShape, void>({
    mutationFn: async (): Promise<AccountGrowthPassResult> => {
      const checkin = await consoleRequest<AccountCheckinResult>(
        `/accounts/${encodeURIComponent(accountId)}/checkin`,
        { method: "POST" },
      );
      const checkinMsg = checkin.message ?? "Daily check-in done";
      if (!checkin.ok) {
        return {
          ok: false,
          message: `Check-in failed: ${checkinMsg}. Report skipped.`,
          checkin,
          report: { ok: false, message: "Skipped (check-in failed)" },
        };
      }
      const report = await consoleRequest<AccountActivityReportResult>(
        `/accounts/${encodeURIComponent(accountId)}/activity-report`,
        { method: "POST" },
      );
      const reportMsg = report.message ?? "Activity reported";
      return {
        ok: report.ok,
        message: report.ok
          ? `Check-in: ${checkinMsg} · Report: ${reportMsg}`
          : `Check-in: ${checkinMsg} · Report failed: ${reportMsg}`,
        checkin,
        report,
      };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

export interface AccountResetCredit {
  readonly id: string;
  readonly status?: string;
  readonly title?: string;
  readonly grantedAt?: string;
  readonly expiresAt?: string;
}

/** Result of `GET /accounts/:id/resets` — the live saved-reset inventory. */
export interface AccountResetList {
  readonly availableCount: number;
  readonly credits: readonly AccountResetCredit[];
}

/** Result of `POST /accounts/:id/reset`. */
export interface AccountResetResult {
  readonly ok: boolean;
  readonly code: string;
  readonly message?: string;
  readonly creditId?: string;
}

const RESET_PROVIDER_IDS = new Set(["codex", "claude", "anthropic"]);

/** True when the account supports rate-limit reset redemption (Codex & Claude). */
export function supportsAccountReset(providerId: string): boolean {
  return RESET_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/**
 * Reads the account's live saved-reset inventory. Deliberately a separate query
 * from the quota overview: the credit objects live on dedicated provider routes
 * (Codex `/wham/rate-limit-reset-credits`, Claude's probed `cedar_ember` block),
 * and Claude's usage payload leaves that block `null` until asked for it, so a
 * count mirrored onto the quota payload would silently read zero.
 */
export function useAccountResets(accountId: string, enabled: boolean) {
  return useQuery<AccountResetList>({
    queryKey: queryKeys.quota.resets(accountId),
    queryFn: ({ signal }) =>
      consoleRequest<AccountResetList>(
        `/accounts/${encodeURIComponent(accountId)}/resets`,
        signal ? { signal } : undefined,
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** Redeems a saved rate-limit reset for the target account, logged to health_events. */
export function useTriggerAccountReset(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountResetResult, ApiErrorShape, { creditId?: string } | void>({
    mutationFn: async (vars) => {
      return consoleRequest<AccountResetResult>(
        `/accounts/${encodeURIComponent(accountId)}/reset`,
        {
          method: "POST",
          body: JSON.stringify(vars ?? {}),
        },
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

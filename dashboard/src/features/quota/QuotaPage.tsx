import {
  Activity,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Check,
  Clock3,
  EyeOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Badge } from "../../components/ui/badge";
import { DataTable } from "../../components/ui/layout";
import { Inline } from "../../components/ui/inline";
import { StatePanel, EmptyState, LoadingState, ErrorState } from "../../components/ui/state";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { HealthEventsModal } from "../../components/HealthEventsModal";
import { Select } from "../../components/ui/select";

import { Stack } from "../../components/ui/stack";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { toast } from "../../lib/toast";
import {
  useQuotaOverview,
  useRefreshAccountQuota,
  useRefreshAllQuotas,
  useTriggerGrowthPass,
  useTriggerAccountReset,
  useAccountResets,
  useUpdateAccountActive,
  useSetAccountsActiveBatch,
  useDeleteQuotaAccount,
  supportsAccountCheckin,
  supportsAccountReset,
  type QuotaEntry,
} from "../../hooks/quota";
import {
  friendlyQuotaError,
  formatQuotaRefresh,
  formatQuotaWindowLabel,
  formatResetDistance,
  quotaBarTone,
  paginateQuotaWindows,
  accountIdentity,
} from "../../shared/quota-formatters";
import { getErrorMessage } from "../../lib/helpers";


function isEmpty(account: QuotaEntry): boolean {
  return Boolean(
    account.quota?.windows.length &&
    account.quota.windows.every(
      (window) => window.remainingPercent !== null && window.remainingPercent <= 0,
    ),
  );
}

function firstResetAt(account: QuotaEntry): number {
  const resetTimes =
    account.quota?.windows.map((window) =>
      window.resetsAt ? new Date(window.resetsAt).getTime() : Number.POSITIVE_INFINITY,
    ) ?? [];
  return Math.min(...resetTimes, Number.POSITIVE_INFINITY);
}

function QuotaAccountResetModal({
  account,
  onClose,
}: {
  readonly account: QuotaEntry;
  readonly onClose: () => void;
}): ReactNode {
  const resets = useAccountResets(account.id, true);
  const reset = useTriggerAccountReset(account.id);
  const credits = resets.data?.credits ?? [];

  const grantedLabel = (value: string | undefined): string =>
    value ? new Date(value).toLocaleString() : "—";
  const expiryLabel = (value: string | undefined): string =>
    value ? new Date(value).toLocaleString() : "—";
  const remainingLabel = (value: string | undefined): string => {
    if (!value) return "";
    const remaining = new Date(value).getTime() - Date.now();
    if (!Number.isFinite(remaining)) return "";
    if (remaining <= 0) return "expired";
    const days = Math.floor(remaining / 86_400_000);
    if (days >= 1) return `in ${days}d`;
    const hours = Math.floor(remaining / 3_600_000);
    if (hours >= 1) return `in ${hours}h`;
    return `in ${Math.max(1, Math.floor(remaining / 60_000))}m`;
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      size="lg"
      title={`Saved Rate-Limit Resets — ${account.name}`}
    >
      <div className="flex flex-col gap-7">
        <div className="flex items-center justify-between gap-6 rounded-control border border-inner-border bg-surface-2 px-8 py-6">
          <div className="min-w-0">
            <div className="flex items-center gap-4">
              <Zap size={14} className="text-status-success" />
              <span className="text-body font-semibold">Available resets</span>
            </div>
            <p className="mt-2 text-text-tertiary text-badge leading-normal">
              Each credit lifts a spent rate-limit window before its natural reset.
            </p>
          </div>
          <Badge tone={resets.data && resets.data.availableCount > 0 ? "ok" : "disabled"} dot>
            {resets.data?.availableCount ?? 0} reset
            {(resets.data?.availableCount ?? 0) === 1 ? "" : "s"}
          </Badge>
        </div>

        {resets.isPending ? (
          <LoadingState label="Reading saved resets…" />
        ) : resets.isError ? (
          <ErrorState message="Failed to read saved resets" onRetry={() => void resets.refetch()} />
        ) : credits.length === 0 ? (
          <EmptyState
            title="No saved resets"
            message="This account has no saved rate-limit reset credits right now."
            icon={<Zap size={20} />}
          />
        ) : (
          <div className="max-h-170 overflow-y-auto rounded-control border border-inner-border">
            <DataTable headers={["Status", "Title", "Granted", "Expires", ""]}>
              {credits.map((credit) => {
                const available = (credit.status ?? "available") === "available";
                const remaining = remainingLabel(credit.expiresAt);
                return (
                  <tr key={credit.id}>
                    <td className="whitespace-nowrap align-middle">
                      <Badge
                        tone={available ? "ok" : credit.status === "expired" ? "disabled" : "warn"}
                      >
                        {credit.status ?? "available"}
                      </Badge>
                    </td>
                    <td
                      className="text-caption font-medium whitespace-nowrap align-middle text-text-primary"
                    >
                      {credit.title ?? "Rate-limit reset"}
                    </td>
                    <td
                      className="text-badge whitespace-nowrap tabular-nums align-middle text-text-secondary"
                    >
                      {grantedLabel(credit.grantedAt)}
                    </td>
                    <td
                      className="text-badge whitespace-nowrap tabular-nums align-middle text-text-secondary"
                    >
                      {expiryLabel(credit.expiresAt)}
                      {remaining && (
                        <span className="ml-3 text-text-tertiary">
                          ({remaining})
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right align-middle">
                      <Button
                        size="sm"
                        variant={available ? "primary" : "secondary"}
                        disabled={!available || reset.isPending}
                        onClick={() =>
                          reset.mutate(
                            { creditId: credit.id },
                            {
                              onSuccess: (result) => {
                                if (result.ok) {
                                  toast.success(result.message ?? "Rate limit reset applied");
                                } else {
                                  toast.error(result.message ?? "Rate limit reset failed");
                                }
                              },
                              onError: (err) => {
                                toast.error(
                                  getErrorMessage(err, "Unable to redeem rate-limit reset"),
                                );
                              },
                            },
                          )
                        }
                      >
                        Use
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </div>
        )}

        <Inline justify="flex-end" gap="0px">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </Inline>
      </div>
    </Dialog>
  );
}

function QuotaCard({
  account,
  onToggle,
  onDelete,
  onShowHealth,
  onShowResets,
}: {
  readonly account: QuotaEntry;
  readonly onToggle: (account: QuotaEntry, active: boolean) => void;
  readonly onDelete: (account: QuotaEntry) => void;
  readonly onShowHealth: (account: QuotaEntry) => void;
  readonly onShowResets: (account: QuotaEntry) => void;
}): ReactNode {
  const refresh = useRefreshAccountQuota(account.id);
  const growth = useTriggerGrowthPass(account.id);
  const canCheckin = supportsAccountCheckin(account.provider);
  const canReset = supportsAccountReset(account.provider);
  const resets = useAccountResets(account.id, canReset);
  const quota = account.quota;
  const [quotaWindowPage, setQuotaWindowPage] = useState(0);
  const quotaWindows = quota?.windows ?? [];
  const pagination = paginateQuotaWindows(quotaWindows, quotaWindowPage);
  const quotaPageCount = pagination.pageCount;
  useEffect(() => {
    setQuotaWindowPage((current) => Math.min(current, Math.max(0, quotaPageCount - 1)));
  }, [quotaPageCount]);
  const busy = refresh.isPending || growth.isPending;
  const resetCreditsCount = resets.data?.availableCount ?? 0;
  // Manual trigger result wins while fresh; otherwise the sweep ledger tells
  // whether today was already attempted. Neither is a live upstream read, so
  // the label is a state hint, not a guarantee of today's grant.
  const [lastCheckin, setLastCheckin] = useState<{
    readonly state: string;
    readonly credit: number | null;
    readonly streakDays: number | null;
  } | null>(null);
  const [lastReported, setLastReported] = useState(false);
  const attemptedToday = account.checkin?.attemptedToday ?? false;
  const checkinHint = lastCheckin
    ? lastCheckin.state === "claimed"
      ? `Checked in${lastCheckin.credit !== null ? ` +${lastCheckin.credit}` : ""}${lastCheckin.streakDays !== null ? ` · ${lastCheckin.streakDays}d streak` : ""}`
      : lastCheckin.state === "already_claimed"
        ? "Already checked in"
        : lastCheckin.state === "not_eligible"
          ? "Not eligible"
          : lastCheckin.state === "event_ended"
            ? "Event ended"
            : "Check-in unavailable"
    : attemptedToday
      ? "Check-in attempted today"
      : "Check-in due";
  const statusHint = `${checkinHint}${lastReported ? " · Reported today" : ""}`;
  const totalCredits = quotaWindows.reduce((total, window) => {
    const limit = window.limit;
    if (typeof limit !== "number" || !Number.isFinite(limit)) return total;
    const remaining =
      typeof window.remaining === "number" && Number.isFinite(window.remaining)
        ? window.remaining
        : typeof window.used === "number" && Number.isFinite(window.used)
          ? limit - window.used
          : typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)
            ? (limit * window.remainingPercent) / 100
            : null;
    return remaining === null ? total : total + Math.max(0, remaining);
  }, 0);
  const rawError =
    (refresh.error ? getErrorMessage(refresh.error, "Unable to refresh this account") : null) ??
    quota?.error ??
    account.health?.sanitizedMessage;
  const friendly = friendlyQuotaError(rawError);
  const isUnsupported = friendly === "Quota tracking is not supported for this provider";
  const cardError = isUnsupported ? null : friendly;
  const identity = accountIdentity(account.credentialHint, account.name);
  const healthStatus = account.health?.status ?? "unknown";

  return (
    <Card className="overflow-hidden" aria-busy={busy}>
      {/* Header: icon + provider name + plan + account hint + actions */}
      <div className="flex flex-wrap items-center gap-5 px-7 py-4">
        <ProviderIcon icon={account.providerIcon} name={account.providerName} size={32} />
        <div className="min-w-80 flex-1" style={{ flex: "1 1 160px" }}>
          <div className="flex min-w-0 items-center gap-4">
            <div className="truncate text-caption font-bold text-text-primary text-body">
              {account.providerName}
            </div>
            {quota?.plan && (
              <span className="shrink-0 rounded-full bg-accent-soft px-4 py-1 text-micro font-semibold text-accent">
                {quota.plan}
              </span>
            )}
            {healthStatus !== "active" ? (
              <Badge
                tone={
                  healthStatus === "disabled"
                    ? "disabled"
                    : healthStatus === "unknown"
                      ? "default"
                      : "warn"
                }
                dot
                title={account.health?.sanitizedMessage ?? undefined}
              >
                {healthStatus}
                {account.health?.lastErrorCategory ? ` · ${account.health.lastErrorCategory}` : ""}
              </Badge>
            ) : null}
          </div>
          <div className="truncate text-badge text-text-secondary">
            {identity.primary}
          </div>
          {identity.secondary !== null && (
            <div className="truncate text-micro text-text-tertiary">
              {identity.secondary}
            </div>
          )}
          {quota && (
            <div className="truncate text-micro text-text-tertiary">
              {formatQuotaRefresh(quota.lastSuccessAt ?? quota.fetchedAt)}
            </div>
          )}
          {canReset && (
            <div
              className="truncate text-micro flex items-center gap-2 text-text-tertiary"
              title="Saved rate-limit reset credits available on this account"
            >
              {resets.isPending ? (
                "Checking saved resets…"
              ) : resetCreditsCount > 0 ? (
                <>
                  <Zap
                    size={10}
                    className="text-status-success shrink-0"
                    aria-hidden="true"
                  />
                  <span className="reset-credit-live">
                    {resetCreditsCount} rate-limit reset
                    {resetCreditsCount === 1 ? "" : "s"} available
                  </span>
                </>
              ) : (
                "No rate-limit resets available"
              )}
            </div>
          )}
          {canCheckin && (
            <>
              <div title="Daily growth state: manual pass result, else the sweep ledger for today"
               className="truncate text-micro text-text-tertiary">
                {growth.isPending ? "Running growth pass…" : statusHint}
              </div>
              {quotaWindows.some((window) => typeof window.limit === "number" && Number.isFinite(window.limit)) && (
                <div className="truncate text-micro text-text-tertiary">
                  Total credits: {totalCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1.75 gap-3 ml-auto">
          {canReset && (
            <Button
              variant="ghost"
              size="icon"
              className="w-16 h-16 p-0"
              title={
                resets.isPending
                  ? "Checking saved rate-limit resets…"
                  : resetCreditsCount > 0
                    ? `Saved rate-limit resets (${resetCreditsCount} available)`
                    : "Saved rate-limit resets"
              }
              aria-label={`Open saved rate-limit resets for ${account.name}`}
              disabled={busy}
              onClick={() => onShowResets(account)}
            >
              <Zap size={14} />
            </Button>
          )}
          {canCheckin && (
            <Button
              variant="ghost"
              size="icon"
              className="w-16 h-16 p-0"
              title={`Daily growth pass (check-in + activity report) — ${statusHint}`}
              aria-label={`Run daily growth pass for ${account.name}`}
              disabled={busy}
              onClick={() =>
                growth.mutate(undefined, {
                  onSuccess: (result) => {
                    const checkinData = result.checkin.data;
                    if (checkinData) {
                      setLastCheckin({
                        state: checkinData.state,
                        credit: checkinData.credit,
                        streakDays: checkinData.streakDays,
                      });
                    }
                    if (result.report.ok) setLastReported(true);
                    if (result.ok) {
                      toast.success(result.message);
                    } else {
                      toast.error(result.message);
                    }
                  },
                  onError: (err) => {
                    toast.error(getErrorMessage(err, "Unable to run daily growth pass"));
                  },
                })
              }
            >
              {growth.isPending ? <Loader2 size={14} className="animate-spin" /> : <CalendarCheck size={14} />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            title="Health & Error Log"
            aria-label={`Health log for ${account.name}`}
            disabled={busy}
            onClick={() => onShowHealth(account)}
            icon={<Activity size={12} />}
          />
          <Button
            variant="ghost"
            size="sm"
            title="Refresh quota"
            aria-label={`Refresh ${account.name} quota`}
            disabled={busy}
            onClick={() => refresh.mutate()}
            icon={
              refresh.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCcw size={12} />
              )
            }
          />
          <Button
            variant="ghost"
            size="sm"
            title="Delete account"
            aria-label={`Delete ${account.name}`}
            onClick={() => onDelete(account)}
            className="text-red"
            icon={<Trash2 size={12} />}
          />
          <Switch
            checked={account.active}
            disabled={refresh.isPending}
            onChange={(active) => onToggle(account, active)}
            label=""
            id={`switch-${account.id}`}
          />
        </div>
      </div>

      {cardError && (
        <div
          className="flex items-center justify-center gap-4 border-t border-inner-border px-8 py-5 text-center text-badge text-red"
          role="alert"
        >
          <TriangleAlert size={13} className="shrink-0" />
          <span>{cardError}</span>
        </div>
      )}

      {/* Quota progress bars */}
      {quota?.windows.length ? (
        <div
          className="quota-window-list flex flex-col gap-4 border-t border-inner-border px-7 py-4.5"
        >
          <div className="quota-window-section-label text-micro font-bold tracking-label text-text-tertiary">
            QUOTA WINDOWS
          </div>
          {pagination.items.map((window, index) => {
            const remaining = window.remainingPercent ?? null;
            const limit =
              typeof window.limit === "number" && Number.isFinite(window.limit) ? window.limit : null;
            const usedCredits =
              typeof window.used === "number" && Number.isFinite(window.used)
                ? window.used
                : limit !== null && window.usedPercent !== null && window.usedPercent !== undefined
                  ? (limit * window.usedPercent) / 100
                  : null;
            const colors = quotaBarTone(remaining);
            const quotaFillPct = remaining !== null ? Math.max(0, Math.min(100, remaining)) : 0;
            const formatAmount = (value: number): string =>
              value.toLocaleString(undefined, { maximumFractionDigits: 2 });
            const formatPercent = (value: number): string => {
              const rounded = Math.round(value * 10) / 10;
              if (rounded > 0 && rounded < 0.1) return "<0.1";
              return rounded.toLocaleString(undefined, { maximumFractionDigits: 1 });
            };
            const label = formatQuotaWindowLabel(window.label);
            return (
              <div
                className="quota-window-row"
                key={`${window.kind ?? window.label}:${window.resetsAt ?? "none"}:${index}`}
              >
                <div className="quota-window-heading">
                  <span className="text-badge font-semibold text-text-primary">
                    {label}
                  </span>
                </div>
                <div
                  className="quota-bar-track quota-window-bar h-5 rounded-tiny bg-inner-border overflow-hidden"
                  role="progressbar"
                  aria-label={`${label} remaining quota`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={remaining === null ? undefined : quotaFillPct}
                  aria-valuetext={remaining === null ? "Quota only" : `${formatPercent(remaining)}% remaining`}
                >
                  <div
                    className="quota-bar-fill"
                    style={{
                      width: `${quotaFillPct}%`,
                      height: "100%",
                      borderRadius: "3px",
                      background: colors.bar,
                      transition: "width var(--dur-macro) var(--ease-spring)",
                    }}
                  />
                </div>
                <span
                  className="quota-window-remaining text-badge font-bold tabular-nums"
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: colors.text,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {remaining === null ? "—" : `${formatPercent(remaining)}%`}
                </span>
                <div className="quota-window-details">
                  <span className="quota-window-usage tabular-nums">
                    {usedCredits !== null && limit !== null
                      ? `${formatAmount(usedCredits)} / ${formatAmount(limit)} Credits`
                      : "Quota only"}
                  </span>
                  {window.resetsAt && (
                    <span className="quota-window-reset tabular-nums text-right">
                      {formatResetDistance(window.resetsAt, window.recurring)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {pagination.pageCount > 1 && (
            <nav
              aria-label={`Quota windows for ${account.name}`}
              className="quota-window-pagination flex items-center justify-between gap-4 border-t border-inner-border pt-4"
            >
              <span
                aria-live="polite"
                className="text-micro text-text-tertiary"
              >
                Showing {pagination.startIndex + 1}–{pagination.startIndex + pagination.items.length} of {quotaWindows.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Previous quota windows for ${account.name}`}
                  disabled={pagination.page === 0}
                  icon={<ChevronLeft size={13} />}
                  onClick={() => setQuotaWindowPage(pagination.page - 1)}
                  className="h-14 px-4 py-0"
                >
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Next quota windows for ${account.name}`}
                  disabled={pagination.page >= pagination.pageCount - 1}
                  icon={<ChevronRight size={13} />}
                  onClick={() => setQuotaWindowPage(pagination.page + 1)}
                  className="h-14 px-4 py-0"
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
        </div>
      ) : !cardError ? (
        <div
          className="border-t border-inner-border px-7 py-9 text-center text-badge text-text-tertiary"
        >
          {/* A pending fill is a real state with a known end, so it gets its own
              copy instead of the misleading "No quota data" a settled empty
              account would show. */}
          {busy || account.pending ? "Fetching quota…" : "No quota data"}
        </div>
      ) : null}
    </Card>
  );
}

export default function QuotaPage(): ReactNode {
  const [providerFilter, setProviderFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const { data, isLoading, isError, error, isFetching, dataUpdatedAt, refetch } =
    useQuotaOverview();
  const providers = useMemo(
    () =>
      [...(data?.providers ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
    [data?.providers],
  );
  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const refreshingCount = data?.refreshing ?? 0;
  const refreshAll = useRefreshAllQuotas();
  const updateActive = useUpdateAccountActive();
  const setActiveBatch = useSetAccountsActiveBatch();
  const deleteAccountMutation = useDeleteQuotaAccount();
  const [deleteTarget, setDeleteTarget] = useState<QuotaEntry | null>(null);
  const [healthTarget, setHealthTarget] = useState<QuotaEntry | null>(null);
  const [resetTarget, setResetTarget] = useState<QuotaEntry | null>(null);

  const filteredAccounts = useMemo(() => {
    const result = accounts.filter((account) => {
      if (providerFilter !== "all" && account.provider !== providerFilter) return false;
      const hasQuota = Boolean(account.quota?.windows.length);
      if (accountFilter === "untracked") return !hasQuota;
      if (!hasQuota) return false;
      if (accountFilter === "active" && !account.active) return false;
      if (accountFilter === "disabled" && account.active) return false;
      return true;
    });
    // Each card's prominent title is the provider name, so the grid is ordered
    // by provider first and account second: sorting by the account label alone
    // left the visible titles in an order that read as random, and split one
    // provider's accounts across the page. A stable tiebreaker keeps the grid
    // from reshuffling between polls.
    const byProviderThenName = (left: QuotaEntry, right: QuotaEntry): number =>
      left.providerName.localeCompare(right.providerName, undefined, { sensitivity: "base" }) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    return [...result].sort(
      expiringFirst
        ? (left, right) => firstResetAt(left) - firstResetAt(right) || byProviderThenName(left, right)
        : byProviderThenName,
    );
  }, [accountFilter, accounts, expiringFirst, providerFilter]);

  const updateAccount = async (account: QuotaEntry, active: boolean) => {
    try {
      await updateActive.mutateAsync({ id: account.id, active });
      toast.success(`${account.name} ${active ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to update account");
    }
  };

  const turnOffEmpty = async () => {
    const targets = accounts.filter((account) => account.active && isEmpty(account));
    await setActiveBatch.mutateAsync({ ids: targets.map((target) => target.id), active: false });
    toast.success(`Disabled ${targets.length} empty accounts`);
  };

  const turnOnAvailable = async () => {
    const targets = accounts.filter(
      (account) =>
        !account.active &&
        account.quota?.windows.some(
          (window) => window.remainingPercent !== null && window.remainingPercent > 0,
        ),
    );
    await setActiveBatch.mutateAsync({ ids: targets.map((target) => target.id), active: true });
    toast.success(`Enabled ${targets.length} available accounts`);
  };

  const deleteAccount = async (account: QuotaEntry) => {
    await deleteAccountMutation.mutateAsync(account.id);
    toast.success(`${account.name} deleted`);
  };

  const lastUpdated =
    dataUpdatedAt > 0
      ? new Date(dataUpdatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Not updated";
  const emptyCount = accounts.filter(isEmpty).length;

  return (
    <Stack gap="16px" className="dashboard-page min-h-0 flex-1">
      <Card>
        <CardHeader title="Quota" subtitle="Provider account limits and what is left of them" icon={<SlidersHorizontal size={16} />} />
      </Card>
      <Card>
        <CardBody className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex flex-wrap items-center gap-4">
          <Select
            aria-label="Filter quota by provider"
            value={providerFilter}
            onValueChange={setProviderFilter}
            className="w-80 h-16"
            options={[
              { value: "all", label: "All Providers" },
              ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
            ]}
          />
          <Select
            aria-label="Filter quota by account"
            value={accountFilter}
            onValueChange={setAccountFilter}
            className="w-67.5 h-16"
            options={[
              { value: "all", label: "With quota" },
              { value: "active", label: "Active" },
              { value: "disabled", label: "Disabled" },
              { value: "untracked", label: "No quota" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant={expiringFirst ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setExpiringFirst((current) => !current)}
            aria-pressed={expiringFirst}
            icon={<Clock3 size={13} />}
          >
            Expiring first
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red"
            disabled={emptyCount === 0 || isFetching}
            onClick={() => void turnOffEmpty()}
            icon={<EyeOff size={13} />}
          >
            Turn off Empty
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-green"
            disabled={isFetching}
            onClick={() => void turnOnAvailable()}
            icon={<Check size={13} />}
          >
            Turn on Available
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-inner-border pt-5">
        <span className="text-badge text-text-tertiary">
          {filteredAccounts.length} shown
          {emptyCount > 0 ? ` · ${emptyCount} empty` : ""}
        </span>
        <span className="flex items-center gap-5 text-badge text-text-tertiary">
          {refreshingCount > 0
            ? `Refreshing ${refreshingCount} account${refreshingCount === 1 ? "" : "s"}…`
            : `Auto-refresh 60s · ${lastUpdated}`}
          <Button
            variant="secondary"
            size="sm"
            title="Queue quota refresh"
            aria-label="Queue quota refresh"
            disabled={isFetching || refreshAll.isPending || accounts.length === 0}
            icon={<RefreshCw size={13} className={refreshAll.isPending ? "animate-spin" : undefined} />}
            onClick={() =>
              refreshAll.mutate(
                accounts.map((account) => account.id),
                {
                  onSuccess: (result) => {
                    toast.success(
                      result.failed === 0
                        ? `Refreshed ${result.succeeded} quota${result.succeeded === 1 ? "" : "s"}`
                        : `Refreshed ${result.succeeded}, ${result.failed} failed`,
                    );
                  },
                  onError: (err) =>
                    toast.error(err instanceof Error ? err.message : "Unable to refresh quota"),
                },
              )
            }
          >
            Refresh
          </Button>
        </span>
      </div>
        </CardBody>
      </Card>
      <div className="flex min-h-0 flex-1 flex-col gap-6">


      {isLoading ? (
        <StatePanel
          className="min-h-0 flex flex-1 flex-col items-center justify-center"
          kind="loading"
          title="Loading quota data"
          description="Reading provider account limits…"
        />
      ) : isError ? (
        <StatePanel
          className="min-h-0 flex flex-1 flex-col items-center justify-center"
          kind="error"
          title="Unable to load quota data"
          description={
            error instanceof Error ? error.message : "Check the console session and retry."
          }
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : filteredAccounts.length === 0 ? (
        <div className="empty-panel">
          <EmptyState
            title="No account quota data"
            message="Nothing is reporting a quota window yet. Add a provider account and its limits will appear here."
          />
        </div>
      ) : (
        <div
          className="scroll-region"
          style={{
            minHeight: 0,
            flex: 1,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(420px, 100%), 1fr))",
            gap: "12px",
            alignContent: "start",
          }}
        >
          {filteredAccounts.map((account) => (
            <QuotaCard
              key={account.id}
              account={account}
              onToggle={(entry, active) => void updateAccount(entry, active)}
              onDelete={(entry) => setDeleteTarget(entry)}
              onShowHealth={(entry) => setHealthTarget(entry)}
              onShowResets={(entry) => setResetTarget(entry)}
            />
          ))}
        </div>
      )}
      </div>

      {healthTarget && (
        <HealthEventsModal
          summary={{
            providerId: healthTarget.provider,
            accountId: healthTarget.id,
            title: healthTarget.name,
            status: healthTarget.health?.status ?? "unknown",
            errorCategory: healthTarget.health?.lastErrorCategory ?? undefined,
            errorMessage: healthTarget.health?.sanitizedMessage ?? undefined,
            emptyMessage:
              "Status transitions, rate limits, quota refreshes, check-ins, and auto-recoveries will appear here.",
          }}
          onClose={() => setHealthTarget(null)}
        />
      )}

      {resetTarget && (
        <QuotaAccountResetModal account={resetTarget} onClose={() => setResetTarget(null)} />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await deleteAccount(deleteTarget);
        }}
        title="Delete account?"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </Stack>
  );
}

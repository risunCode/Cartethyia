import {
  Activity,
  Download,
  FlaskConical,
  Loader2,
  LockOpen,
  Pencil,
  PowerOff,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../../../data/api";
import { accountErrorLabel } from "../../../lib/format/labels";
import { useMysteriousAccounts } from "../../../lib/privacy-mode";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { HealthEventsModal } from "../../../components/HealthEventsModal";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import {
  useCreateProviderAccount,
  useCreateProviderAccountsBatch,
  useExportProviderAccounts,
  useRecoverAccount,
  useUpdateProviderAccount,
} from "../../../hooks/providers";
import { useProviderAccountInflight } from "../../../hooks/routing";
import { useQuotaOverview, useRefreshAccountQuota, type AccountTestResult, type QuotaWindow } from "../../../hooks/quota";
import { queryKeys } from "../../../data/query-keys";
import {
  assignAccountNames,
  jwtExpiresAt,
  parseCredentialBatch,
  type ParsedCredentialEntry,
} from "../../../lib/credentials";
import { formatResetDistance } from "../../../lib/format/quota";
import {
  activeModelCooldowns,
  lastModelCooldownAt,
} from "../../../components/AccountCooldown";
import { downloadTextFile } from "../../../lib/download";
import { toast } from "../../../lib/toast";
import type { CredentialMode, ProviderAccountResponse } from "../../../data/contracts";



function accountStatusRank(status: string): number {
  if (status === "active") return 0;
  if (status === "cooldown") return 2;
  return 3;
}

function credentialExpiryLabel(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const timestamp = new Date(expiresAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  if (timestamp <= Date.now()) return `Expired ${new Date(expiresAt).toLocaleDateString()}`;
  return `Expires ${formatResetDistance(expiresAt)}`;
}


/**
 * The per-model backoff chip, shared by every status arm of the badge.
 *
 * A model-scoped throttle excludes only the (account, model) pair in the
 * routing catalog, so it is independent of the account-wide status: it can be
 * in force while the account reads `active`, `cooldown`, or `disabled`. Each
 * arm used to render its own chip list, which is how the `disabled` arm lost
 * the operator's last known health of the account.
 */
function ModelCooldownChip({
  cooldowns,
  reason,
}: {
  readonly cooldowns: { count: number; modelId: string; until: string } | undefined;
  readonly reason?: string;
}): ReactNode {
  if (!cooldowns) return null;
  const distance = formatResetDistance(cooldowns.until);
  const soonest = `Soonest: ${cooldowns.modelId} — ${distance}`;
  return (
    <Badge tone="warn" dot title={reason ? `${reason} — ${soonest}` : soonest}>
      {cooldowns.count} model{cooldowns.count === 1 ? "" : "s"} cooling · {distance}
    </Badge>
  );
}

function credentialFamily(account: ProviderAccountResponse): string | undefined {
  if (account.credentialKind === "oauth") return "OAuth";
  if (account.credentialMode === "jwt") return "JWT";
  return undefined;
}

function activeCredentialTone(account: ProviderAccountResponse): "blue" | "ok" {
  return account.credentialKind === "oauth" ? "blue" : "ok";
}

export function AccountStatusBadge({
  account,
}: {
  readonly account: ProviderAccountResponse;
}): ReactNode {
  const cooldownUntilMs = account.cooldownUntil ? new Date(account.cooldownUntil).getTime() : NaN;
  const hasActiveCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now();
  const modelCooldowns = activeModelCooldowns(account);
  // `disabled` is the terminal state, so it is checked first: a disabled row
  // can still carry a stale `cooldownUntil`, and showing "Cooldown" there hid
  // the fact that the account is actually parked. The category/reason are
  // surfaced too, so a disabled account is as diagnosable as a cooldown.
  if (account.status === "disabled") {
    // A rejected credential is not a cooldown: it cannot clear on its own, so
    // the row says what the operator must actually do. The raw category is kept
    // in the tooltip so the reason is still inspectable.
    const family = credentialFamily(account);
    const revoked = account.lastErrorCategory === "auth_invalidated";
    return (
      <Inline gap="4px">
        <Badge tone="disabled" dot title={account.lastError}>
          Disabled{family ? ` - ${family}` : ""}
        </Badge>
        {revoked ? (
          <Badge tone="warn" title={account.lastError}>
            Re-login required
          </Badge>
        ) : account.lastErrorCategory && !(account.lastErrorCategory === "quota_exhausted" && modelCooldowns) ? (
          <Badge tone="warn" title={account.lastError ?? account.lastErrorCategory}>
            {accountErrorLabel(account.lastErrorCategory)}
          </Badge>
        ) : null}
        <ModelCooldownChip cooldowns={modelCooldowns} reason={account.lastErrorCategory === "quota_exhausted" ? account.lastError : undefined} />
      </Inline>
    );
  }
  if (account.status === "active") {
    // An account can be `active` and still have per-model backoffs: the router
    // skips those (account, model) pairs while the account stays usable for
    // every other model. Showing a bare "Active" hid that entirely.
    //
    // The badge stays "Active" even for a static token. Static is a property
    // of the credential, shown in the chip beside this badge, not a status.
    return (
      <Inline gap="4px">
        <Badge tone={activeCredentialTone(account)} dot>
          Active{credentialFamily(account) ? ` - ${credentialFamily(account)}` : ""}
        </Badge>
        {account.lastErrorCategory && !(account.lastErrorCategory === "quota_exhausted" && modelCooldowns) ? (
          <Badge tone="warn" title={account.lastError ?? account.lastErrorCategory}>
            {accountErrorLabel(account.lastErrorCategory)}
          </Badge>
        ) : null}
        <ModelCooldownChip cooldowns={modelCooldowns} reason={account.lastErrorCategory === "quota_exhausted" ? account.lastError : undefined} />
      </Inline>
    );
  }
  if (account.status === "cooldown" || hasActiveCooldown)
    return (
      <Inline gap="4px">
        <Badge tone="warn" dot>
          Cooldown{credentialFamily(account) ? ` - ${credentialFamily(account)}` : ""}{" "}
          {account.cooldownUntil ? `(${formatResetDistance(account.cooldownUntil)})` : ""}
        </Badge>
        {account.lastErrorCategory && !(account.lastErrorCategory === "quota_exhausted" && modelCooldowns) ? (
          <Badge tone="warn" title={account.lastError ?? account.lastErrorCategory}>
            {accountErrorLabel(account.lastErrorCategory)}
          </Badge>
        ) : null}
        <ModelCooldownChip cooldowns={modelCooldowns} reason={account.lastErrorCategory === "quota_exhausted" ? account.lastError : undefined} />
      </Inline>
    );
  return <Badge tone="disabled">Disabled</Badge>;
}


/**
 * One chip for the account's allowance: summed remaining credits when the
 * provider reports them, otherwise the lowest remaining percent. Sits before
 * the inflight chip so the operator sees what is left before how busy it is.
 */
function QuotaPill({ windows }: { readonly windows: readonly QuotaWindow[] | undefined }): ReactNode {
  if (windows === undefined || windows.length === 0) return null;
  let remaining = 0;
  let total = 0;
  let hasCredits = false;
  let lowestPercent: number | null = null;
  for (const window of windows) {
    const limit = typeof window.limit === "number" && Number.isFinite(window.limit) ? window.limit : null;
    const left =
      typeof window.remaining === "number" && Number.isFinite(window.remaining)
        ? window.remaining
        : limit !== null && typeof window.used === "number" && Number.isFinite(window.used)
          ? limit - window.used
          : null;
    if (left !== null && limit !== null) {
      remaining += Math.max(0, left);
      total += limit;
      hasCredits = true;
    }
    if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
      lowestPercent = lowestPercent === null ? window.remainingPercent : Math.min(lowestPercent, window.remainingPercent);
    }
  }
  const text = hasCredits
    ? `${trimNumber(remaining)} of ${trimNumber(total)}`
    : lowestPercent === null
      ? null
      : `${Math.round(lowestPercent)}% left`;
  if (text === null) return null;
  const low = hasCredits ? remaining <= 0 : (lowestPercent ?? 100) <= 10;
  return (
    <span className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap" data-tone={low ? "warn" : undefined} title={hasCredits ? `${trimNumber(remaining)} credits available of ${trimNumber(total)}` : "Lowest remaining percent across this account's quota windows"}>
      <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Quota</span>
      {text}
    </span>
  );
}

function trimNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function AccountRow({
  providerId,
  account,
  inflight,
  quota,
  selected,
  onToggleSelect,
  onDelete,
}: {
  readonly providerId: string;
  readonly account: ProviderAccountResponse;
  readonly inflight?: number;
  readonly quota?: readonly QuotaWindow[];
  readonly selected: boolean;
  readonly onToggleSelect: (accountId: string, next: boolean) => void;
  readonly onDelete: (account: ProviderAccountResponse) => void;
}): ReactNode {
  const update = useUpdateProviderAccount();
  const recover = useRecoverAccount();
  const testQuota = useRefreshAccountQuota(account.id);
  const disabled = account.status === "disabled";
  const cooldownUntilMs = account.cooldownUntil ? new Date(account.cooldownUntil).getTime() : NaN;
  const hasActiveCooldown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now();
  const isRecoverable = account.status === "cooldown" || hasActiveCooldown;
  const [showHistory, setShowHistory] = useState(false);
  const [, setTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const privacy = useMysteriousAccounts(providerId);
  const shown = (account.label?.match(/[^\s@]+@[^\s@]+/)?.[0] ?? account.label) || account.id.slice(0, 8);
  const label = privacy.enabled ? "Mysterious accounts" : shown;
  // The countdown re-renders on a timer. It must be armed by the per-model
  // backoffs too, not only by `cooldownUntil`: a model-scoped 429 writes
  // `modelCooldowns` and deliberately leaves `cooldownUntil` untouched (the
  // account stays routable for every other model), so keying the timer on
  // `cooldownUntil` alone left a per-model badge that never counted down.
  const lastModelCooldownAtValue = lastModelCooldownAt(account);
  const countdownTarget = Math.max(
    hasActiveCooldown && account.cooldownUntil ? cooldownUntilMs : 0,
    lastModelCooldownAtValue ?? 0,
  );
  useEffect(() => {
    if (countdownTarget <= Date.now()) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [countdownTarget]);

  const saveLabel = () => {
    const next = draftLabel.trim();
    setRenaming(false);
    if (!next || next === (account.label ?? "")) return;
    update.mutate(
      { providerId, accountId: account.id, request: { label: next } },
      {
        onSuccess: () => toast.success("Account renamed", next),
        onError: (err) =>
          toast.error(
            "Rename failed",
            (err as { message?: string }).message ?? "Unable to rename account",
          ),
      },
    );
  };
  const toggleEnabled = () => {
    const nextActive = disabled;
    update.mutate(
      {
        providerId,
        accountId: account.id,
        request: { status: nextActive ? "active" : "disabled" },
      },
      {
        onSuccess: () =>
          toast.success(nextActive ? "Account enabled" : "Account disabled", label),
        onError: (err) =>
          toast.error(
            "Update failed",
            (err as { message?: string }).message ?? "Unable to update account",
          ),
      },
    );
  };


  const handleTest = () => {
    testQuota.mutate(undefined, {
      onSuccess: (result) => {
        if (result?.ok) toast.success("Account test passed", label);
        else toast.error("Account test failed", result?.message ?? "Provider reported an error");
      },
      onError: (err) =>
        toast.error(
          "Account test failed",
          (err as { message?: string }).message ?? "Unable to test account",
        ),
    });
  };

  return (
    <>
      <div
        className={`account-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-5 px-5 py-4 border rounded-control bg-surface-2 ${selected ? "border-accent" : "border-inner-border"} hover:bg-hover`}
        role="listitem"
        data-selected={selected ? "true" : undefined}
        style={{ opacity: disabled ? 0.62 : 1 }}
      >
        <div className="flex items-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onToggleSelect(account.id, event.target.checked)}
            aria-label={`Select ${label}`}
            className="cursor-pointer"
          />
        </div>

        <div className="min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-3 min-w-0">
            {renaming ? (
              <Input
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveLabel();
                  if (event.key === "Escape") setRenaming(false);
                }}
                onBlur={saveLabel}
                autoFocus
                aria-label="Account label"
                className="text-body max-w-120"
              />
            ) : (
              <>
                <span className="text-body font-semibold text-text-primary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={account.label || account.id}>
                  {label}
                </span>
                <button
                  type="button"
                  className="shrink-0 grid place-items-center w-10 h-10 p-0 border-0 bg-transparent text-text-tertiary cursor-pointer rounded-tiny hover:bg-inner-border hover:text-text-primary"
                  title="Rename account"
                  aria-label={`Rename ${label}`}
                  onClick={() => {
                    setDraftLabel(account.label ?? "");
                    setRenaming(true);
                  }}
                >
                  <Pencil size={11} />
                </button>
              </>
            )}
          </div>
          <div className="flex items-center flex-nowrap gap-2 min-w-0 overflow-hidden">
            <AccountStatusBadge account={account} />
          </div>
          <div className="flex items-center flex-wrap gap-2 min-w-0">
            {credentialExpiryLabel(account.tokenExpiresAt) ? (
              <span className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap" title={credentialExpiryLabel(account.tokenExpiresAt)}>
                {credentialExpiryLabel(account.tokenExpiresAt)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap" title={`Today: ${account.usageToday.totalTokens.toLocaleString()} tokens, ${account.usageToday.requests.toLocaleString()} requests`}>
              <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">Today</span>
              {account.usageToday.totalTokens.toLocaleString()} tok · {account.usageToday.requests.toLocaleString()} req
            </span>
            <span
              className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap"
              title="Lifetime totals are backfilled from telemetry still retained when tracking starts; new totals survive telemetry cleanup."
            >
              <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">All time</span>
              {account.usageAllTime.totalTokens.toLocaleString()} tok · {account.usageAllTime.requests.toLocaleString()} req
            </span>
            <QuotaPill windows={quota} />
            <span
              className="inline-flex items-center gap-2.5 max-w-full px-3.5 py-1 border border-inner-border rounded-chip bg-surface-1 text-text-secondary text-badge leading-normal whitespace-nowrap"
              title="Concurrency comes from this provider’s Routing Strategy; accounts no longer carry manual ceilings."
            >
              <span className="text-text-tertiary text-micro font-semibold uppercase tracking-label">In flight</span>
              {inflight?.toLocaleString() ?? "—"}
            </span>
          </div>
        </div>

        <div className="account-row-actions flex items-center justify-end gap-3 flex-wrap">
          <Button
            size="icon"
            variant="secondary"
            icon={<Activity size={12} />}
            label="Health"
            aria-label={`Health for ${label}`}
            onClick={() => setShowHistory(true)}
            title="View Health & Error History"
          />
          <Button
            size="icon"
            variant="secondary"
            icon={
              testQuota.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <FlaskConical size={12} />
              )
            }
            label={testQuota.isPending ? "Testing…" : "Test"}
            aria-label={`Test ${label}`}
            disabled={testQuota.isPending}
            onClick={handleTest}
            title="Refresh quota and health for this account"
          />
          <Button
            size="icon"
            variant="secondary"
            icon={disabled ? <LockOpen size={12} /> : <PowerOff size={12} />}
            label={disabled ? "Enable" : "Disable"}
            aria-label={disabled ? `Enable ${label}` : `Disable ${label}`}
            disabled={update.isPending}
            onClick={toggleEnabled}
            title={disabled ? "Enable account" : "Disable account"}
          />
          {isRecoverable ? (
            <Button
              size="icon"
              variant="secondary"
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
              label={recover.isPending ? "Recovering…" : "Recover"}
              aria-label={`Recover ${label}`}
              disabled={recover.isPending}
              onClick={() => recover.mutate({ providerId, accountId: account.id })}
              title="Clear cooldown / restore active status"
            />
          ) : null}
          <Button
            size="icon"
            variant="danger"
            icon={<Trash2 size={12} />}
            label="Delete"
            aria-label={`Delete ${label}`}
            onClick={() => onDelete(account)}
            title="Delete account"
          />
        </div>
      </div>
      {showHistory && (
        <HealthEventsModal
          summary={{
            providerId,
            accountId: account.id,
            title: account.label || account.id.slice(0, 8),
            status: account.status,
            errorCategory: account.lastErrorCategory ?? undefined,
            errorMessage: account.lastError ?? undefined,
            emptyMessage: "Status transitions, rate limits, and auto-recoveries will appear here.",
            staticToken: account.staticToken === true,
            credentialKind: account.credentialKind,
            credentialMode: account.credentialMode,
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
    </>
  );
}

type AccountSortKey = "added" | "label" | "status" | "lastCheck";
type AccountSortValue = `${AccountSortKey}-${"asc" | "desc"}`;

const ACCOUNT_SORT_OPTIONS: ReadonlyArray<{ value: AccountSortValue; label: string }> = [
  { value: "added-asc", label: "Added · oldest" },
  { value: "added-desc", label: "Added · newest" },
  { value: "label-asc", label: "Name · A–Z" },
  { value: "label-desc", label: "Name · Z–A" },
  { value: "status-asc", label: "Status · active first" },
  { value: "status-desc", label: "Status · disabled first" },
  { value: "lastCheck-desc", label: "Last check · newest" },
  { value: "lastCheck-asc", label: "Last check · oldest" },
];

function compareAccounts(
  a: ProviderAccountResponse,
  b: ProviderAccountResponse,
  key: AccountSortKey,
): number {
  const stableTie = (left: ProviderAccountResponse, right: ProviderAccountResponse): number =>
    (left.label || left.id).localeCompare(right.label || right.id) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
  if (key === "added") {
    // The server's stable list position; falls back to creation order for
    // payloads that predate the index.
    return (
      a.sortIndex - b.sortIndex ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
    );
  }
  if (key === "label") return stableTie(a, b);
  if (key === "status") {
    const rank = accountStatusRank(a.status) - accountStatusRank(b.status);
    return rank !== 0 ? rank : stableTie(a, b);
  }
  const at = new Date(a.lastSuccessAt ?? a.createdAt).getTime();
  const bt = new Date(b.lastSuccessAt ?? b.createdAt).getTime();
  return bt - at || stableTie(a, b);
}
export function AccountsList({
  providerId,
  accounts,
  onDelete,
  showGrokProbe = false,
  grokProbePending = false,
  onGrokProbe,
}: {
  readonly providerId: string;
  readonly accounts: readonly ProviderAccountResponse[];
  readonly onDelete: (account: ProviderAccountResponse) => void;
  readonly showGrokProbe?: boolean;
  readonly grokProbePending?: boolean;
  readonly onGrokProbe?: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const update = useUpdateProviderAccount();
  const recover = useRecoverAccount();
  const exportAccounts = useExportProviderAccounts();
  const inflightQuery = useProviderAccountInflight(providerId);
  const inflightByAccount = inflightQuery.data ?? new Map<string, number>();
  const quotaQuery = useQuotaOverview();
  const quotaByAccount = useMemo(() => {
    const map = new Map<string, readonly QuotaWindow[]>();
    for (const entry of quotaQuery.data?.accounts ?? []) {
      if (entry.provider === providerId && entry.quota) map.set(entry.id, entry.quota.windows);
    }
    return map;
  }, [quotaQuery.data, providerId]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<AccountSortValue>("added-asc");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedQuery) return accounts;
    return accounts.filter((account) => {
      const haystack = `${account.label ?? ""} ${account.id} ${account.credentialKind} ${account.status}`.toLowerCase();
      return normalizedQuery.split(/\s+/).every((token) => haystack.includes(token));
    });
  }, [accounts, normalizedQuery]);

  const sorted = useMemo(() => {
    const key = sort.slice(0, sort.lastIndexOf("-")) as AccountSortKey;
    const direction = sort.endsWith("-desc") ? -1 : 1;
    const copy = [...filtered];
    copy.sort((a, b) => direction * compareAccounts(a, b, key));
    return copy;
  }, [filtered, sort]);

  const selectedAccounts = useMemo(
    () => accounts.filter((account) => selected.has(account.id)),
    [accounts, selected],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((account) => selected.has(account.id));
  // The bar is always visible, and each action stays disabled until a row is
  // picked. Enable and Disable only appear when the selection actually has an
  // account in the other state. Recover stays visible either way: a cooldown
  // can sit on a model while the account itself still reads as active.
  const selectionHasDisabled = selectedAccounts.some((account) => account.status === "disabled");
  const selectionHasEnabled = selectedAccounts.some((account) => account.status !== "disabled");
  const nothingSelected = selectedAccounts.length === 0;

  const toggleSelect = (accountId: string, next: boolean) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(accountId);
      else copy.delete(accountId);
      return copy;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (allFilteredSelected) {
        for (const account of filtered) copy.delete(account.id);
      } else {
        for (const account of filtered) copy.add(account.id);
      }
      return copy;
    });
  };

  const runBulk = async (label: string, fn: (account: ProviderAccountResponse) => Promise<unknown>) => {
    if (selectedAccounts.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(selectedAccounts.map((account) => fn(account)));
    const failed = results.filter((result) => result.status === "rejected").length;
    const ok = results.length - failed;
    setBulkBusy(false);
    if (failed === 0) {
      toast.success(`${label} complete`, `${ok} account${ok === 1 ? "" : "s"}`);
    } else {
      toast.error(`${label} partially failed`, `${ok} succeeded, ${failed} failed`);
    }
  };

  const bulkRecover = () =>
    runBulk("Recover", (account) =>
      recover.mutateAsync({ providerId, accountId: account.id }),
    );

  /**
   * Tests every selected account. Unlike the other bulk actions a failed test
   * is a 200 with `ok: false`, not a rejected promise, so it counts `ok`
   * itself instead of going through `runBulk`.
   */
  const bulkTest = async () => {
    if (selectedAccounts.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      selectedAccounts.map((account) =>
        consoleRequest<AccountTestResult>(
          `/accounts/${encodeURIComponent(account.id)}/quota/refresh`,
          { method: "POST" },
        ),
      ),
    );
    let passed = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value?.ok) passed += 1;
      else failed += 1;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
    ]);
    setBulkBusy(false);
    if (failed === 0) toast.success("Test complete", `${passed} passed`);
    else if (passed === 0) toast.error("Test failed", `${failed} account${failed === 1 ? "" : "s"} failed`);
    else toast.error("Test partially failed", `${passed} passed, ${failed} failed`);
  };

  const bulkSetActive = (active: boolean) =>
    runBulk(active ? "Enable" : "Disable", (account) =>
      update.mutateAsync({
        providerId,
        accountId: account.id,
        request: { status: active ? "active" : "disabled" },
      }),
    );

  const bulkExport = async () => {
    if (selectedAccounts.length === 0) return;
    setBulkBusy(true);
    try {
      const body = await exportAccounts.mutateAsync({
        providerId,
        accountIds: selectedAccounts.map((account) => account.id),
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadTextFile(
        `${providerId}-accounts-${stamp}.json`,
        JSON.stringify(body, null, 2),
        "application/json",
      );
      toast.success(
        "Accounts exported",
        `${body.accounts.length} account${body.accounts.length === 1 ? "" : "s"} — contains plaintext credentials`,
      );
    } catch (err) {
      toast.error(
        "Export failed",
        (err as { message?: string }).message ?? "Unable to export accounts",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    await runBulk("Delete", async (account) => {
      // Shared accounts carry `tenant_id IS NULL` and live under the
      // global-admin route; the tenant-scoped path can never match them.
      const path =
        account.tenantId === null
          ? `/global/accounts/${encodeURIComponent(account.id)}`
          : `/accounts/${encodeURIComponent(account.id)}`;
      await consoleRequest(path, { method: "DELETE" });
      queryClient.removeQueries({ queryKey: queryKeys.quota.account(account.id), exact: true });
    });
    setSelected(new Set());
    setBulkDeleteOpen(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
    ]);
  };

  return (
    <Stack gap="8px">
      <div className="flex items-center flex-wrap gap-4 p-4 border border-inner-border rounded-control bg-surface-2">
        <div className="relative flex-none basis-100 min-w-70">
            <Search
              size={13}
              aria-hidden="true"
              className="absolute left-5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
            />
            <Input
              id="accounts-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search accounts..."
              aria-label="Search accounts"
              className="pl-15"
            />
          </div>
        <div className="flex items-center flex-wrap gap-3 min-w-0">
          <Button size="sm" variant="secondary" icon={<FlaskConical size={12} />} disabled={bulkBusy || nothingSelected} onClick={bulkTest}>
            Test
          </Button>
          <Button size="sm" variant="secondary" icon={<RotateCcw size={12} />} disabled={bulkBusy || nothingSelected} onClick={bulkRecover}>
            Recover
          </Button>
          {nothingSelected || selectionHasDisabled ? (
            <Button size="sm" variant="secondary" icon={<LockOpen size={12} />} disabled={bulkBusy || nothingSelected} onClick={() => bulkSetActive(true)}>
              Enable
            </Button>
          ) : null}
          {nothingSelected || selectionHasEnabled ? (
            <Button size="sm" variant="secondary" icon={<PowerOff size={12} />} disabled={bulkBusy || nothingSelected} onClick={() => bulkSetActive(false)}>
              Disable
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" icon={<Download size={12} />} disabled={bulkBusy || nothingSelected} onClick={bulkExport}>
            Export JSON
          </Button>
          {nothingSelected ? null : (
            <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={bulkBusy} onClick={() => setBulkDeleteOpen(true)}>
              Delete
            </Button>
          )}
          {nothingSelected ? null : (
            <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          )}
        </div>
        <div className="flex items-center flex-wrap gap-4 ml-auto min-w-0">
        <label className="inline-flex items-center gap-3 h-15 text-caption font-semibold text-text-secondary [&_.radix-select-trigger]:font-semibold [&_.radix-select-trigger]:bg-hover [&_.radix-select-trigger]:text-text-primary">
          <Select
            size="sm"
            value={sort}
            onValueChange={(value) => setSort(value as AccountSortValue)}
            options={ACCOUNT_SORT_OPTIONS}
            aria-label="Sort accounts by"
          />
        </label>
        {showGrokProbe ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<FlaskConical size={12} className={grokProbePending ? "animate-spin" : ""} />}
            disabled={grokProbePending || accounts.length === 0}
            onClick={onGrokProbe}
            title="Probe every Grok account with the live 407 streaming request"
          >
            {grokProbePending ? "Testing…" : "Test 407"}
          </Button>
        ) : null}
        <label className="inline-flex items-center gap-3 h-15 text-caption font-semibold text-text-secondary">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            aria-label="Select all accounts"
          />
          <span>Select all</span>
        </label>
        </div>
      </div>

      <div className="account-list flex flex-col gap-3 max-h-230 overflow-y-auto pr-1 [container-type:inline-size] [container-name:account-list]" role="list" aria-label="Provider accounts">
        {sorted.map((account) => (
          <AccountRow
            key={account.id}
            providerId={providerId}
            account={account}
            inflight={inflightByAccount.get(account.id) ?? account.inflight}
            quota={quotaByAccount.get(account.id)}
            selected={selected.has(account.id)}
            onToggleSelect={toggleSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
      <div
        className="flex items-center justify-between text-badge text-text-tertiary"
      >
        <span>
          Showing {filtered.length} account{filtered.length === 1 ? "" : "s"}
          {normalizedQuery ? ` (filtered from ${accounts.length})` : ""}
        </span>
      </div>

      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => {
          if (!bulkBusy) setBulkDeleteOpen(false);
        }}
        onConfirm={bulkDelete}
        title={`Delete ${selectedAccounts.length} account${selectedAccounts.length === 1 ? "" : "s"}?`}
        message="This permanently removes the selected accounts and their credentials. This cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </Stack>
  );
}



/** Cap on an imported credential file; a mis-picked file must not stall the tab. */
const CREDENTIAL_FILE_MAX_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_FILE_MAX_MB = CREDENTIAL_FILE_MAX_BYTES / (1024 * 1024);

export function AddAccountModal({
  providerId,
  accounts,
  onClose,
}: {
  readonly providerId: string;
  readonly accounts: readonly ProviderAccountResponse[];
  readonly onClose: () => void;
}): ReactNode {
  const create = useCreateProviderAccount();
  const createBatch = useCreateProviderAccountsBatch();
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>("auto");

  const entries = parseCredentialBatch(secret);
  const isBatch = entries.length > 1;
  const singleEntry = entries.length === 1 ? entries[0] : undefined;
  const detectedKind = credentialMode === "auto" ? singleEntry?.kind : credentialMode;
  const detectedExpiry =
    singleEntry && detectedKind === "jwt" ? jwtExpiresAt(singleEntry.value) : undefined;
  const existingNames = accounts.map((account) => account.label);
  const batchNames = isBatch ? assignAccountNames(entries, providerId, existingNames) : [];
  const requestForEntry = (entry: ParsedCredentialEntry) => {
    const mode: CredentialMode =
      credentialMode === "auto" ? (entry.kind === "jwt" ? "jwt" : "auto") : credentialMode;
    return {
      credentialKind: mode === "auto" && entry.kind === "oauth" ? ("oauth" as const) : ("api_key" as const),
      credentialMode: mode,
      secret: entry.value,
    };
  };
  const submitting = create.isPending || batchSubmitting;

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setSecret(text);
      const parsed = parseCredentialBatch(text);
      if (parsed.length > 1) {
        toast.success("Pasted from clipboard", `Detected ${parsed.length} credentials`);
      } else {
        const kind = parsed[0]?.kind ?? "api_key";
        const detectedLabel =
          kind === "oauth" ? "OAuth export" : kind === "jwt" ? "Static JWT" : "API key";
        toast.success("Pasted from clipboard", `Detected: ${detectedLabel}`);
      }
    } catch {
      toast.error("Clipboard access denied");
    }
  };

  /**
   * Reads a picked `.txt`/`.json` file into the same field the paste path fills.
   *
   * The parser already accepts a JSON array, one credential per line, and
   * newline-delimited JSON exports, so the file only has to become text — the
   * detection, labelling, and batch preview are the shared path, not a second
   * implementation. Size is capped so a mis-picked file cannot freeze the tab
   * building a preview it will never submit.
   */
  const handleFile = (file: File) => {
    if (file.size > CREDENTIAL_FILE_MAX_BYTES) {
      toast.error("File too large", `Credential files must be ${CREDENTIAL_FILE_MAX_MB} MB or smaller.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setSecret(text);
      const parsed = parseCredentialBatch(text);
      if (parsed.length === 0) {
        toast.error("Nothing to import", "That file held no credential the gateway recognises.");
        return;
      }
      toast.success(
        `Imported ${file.name}`,
        parsed.length > 1
          ? `Detected ${parsed.length} credentials`
          : parsed[0]?.kind === "oauth"
            ? "Detected: OAuth export"
            : "Detected: API key",
      );
    };
    reader.onerror = () => toast.error("Could not read that file");
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (entries.length === 0) return;
    if (entries.length === 1) {
      const entry = entries[0] as ParsedCredentialEntry;
      create.mutate(
        {
          providerId,
          request: {
            label: (label.trim() || entry.identity) ?? undefined,
            ...requestForEntry(entry),
          },
        },
        {
          onSuccess: () => {
            toast.success(
              "Account connected",
              `New ${
                entry.kind === "oauth" ? "OAuth" : entry.kind === "jwt" ? "Static JWT" : "API key"
              } account registered successfully`,
            );
            onClose();
          },
          onError: (err) =>
            toast.error(
              "Failed to add account",
              (err as { message?: string }).message ?? "Invalid credentials",
            ),
        },
      );
      return;
    }

    setBatchSubmitting(true);
    try {
      // One request for the whole paste. The server creates every account in a
      // single transaction and reports a per-item outcome, so this is one
      // round-trip instead of N sequential ones — and the account list is
      // invalidated once rather than after every account.
      const result = await createBatch.mutateAsync({
        providerId,
        accounts: entries.map((entry, index) => ({
          label: batchNames[index],
          ...requestForEntry(entry),
        })),
      });

      const failed = result.results.filter((item) => !item.ok);
      const created = result.created;
      if (created > 0) {
        toast.success(
          `${created} account${created === 1 ? "" : "s"} added`,
          failed.length > 0 ? `${failed.length} skipped` : undefined,
        );
      }
      if (failed.length > 0) {
        const detail = failed
          .slice(0, 5)
          .map((item) => `${batchNames[item.index] ?? item.index}: ${item.error ?? "rejected"}`)
          .join("\n");
        toast.error(
          `${failed.length} account${failed.length === 1 ? "" : "s"} skipped`,
          detail + (failed.length > 5 ? `\n…and ${failed.length - 5} more` : ""),
        );
      }
      if (created > 0) onClose();
    } finally {
      setBatchSubmitting(false);
    }
  };

  return (
    <Dialog open={true} onClose={onClose} title="Add Account (API key / JSON)" width={560} footer={
      <>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={submitting || entries.length === 0} onClick={() => void handleSubmit()}>
          {submitting ? "Connecting..." : isBatch ? `Add ${entries.length} Accounts` : "Add Account"}
        </Button>
      </>
    }>
      <div
        className="flex flex-col gap-5"
      >
        {!isBatch && (
          <Input
            label="Account label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={singleEntry?.identity ?? `${providerId} account`}
          />
        )}
        <Select
          label="Credential type"
          id="credential-mode"
          value={credentialMode}
          onValueChange={(value) =>
            setCredentialMode(value === "jwt" || value === "api_key" ? value : "auto")
          }
          options={[
            { value: "auto", label: "Auto — detect JWT, OAuth, or API key" },
            { value: "jwt", label: "JWT — static, no refresh" },
            { value: "api_key", label: "API key — do not decode as JWT" },
          ]}
        />
        <Stack gap="6px" className="min-w-0">
          <div
            className="flex items-center justify-between gap-4"
          >
            <label className="text-caption font-semibold text-text-secondary">
              API key, OAuth token, or exported JSON — one or many
            </label>
            {isBatch ? (
              <Badge tone="accent">Detected: {entries.length} accounts</Badge>
            ) : singleEntry ? (
              <Badge tone={detectedKind === "oauth" || detectedKind === "jwt" ? "accent" : "default"}>
                Detected:{" "}
                {detectedKind === "oauth"
                  ? "OAuth"
                  : detectedKind === "jwt"
                    ? "Static JWT"
                    : "API key"}
                {singleEntry.identity ? ` · ${singleEntry.identity}` : ""}
              </Badge>
            ) : null}
              {singleEntry && detectedKind === "jwt" ? (
                <p className="text-micro text-text-tertiary">
                  Static JWT · no refresh token
                  {detectedExpiry ? ` · expires ${new Date(detectedExpiry).toLocaleString()}` : " · no expiry claim"}
                </p>
              ) : null}
          </div>
          <Inline gap="8px" align="flex-start" className="min-w-0">
            <textarea
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Paste one credential, or many — one per line, a JSON array, or newline-delimited OAuth exports. Kind and account naming are detected automatically…"
              rows={6}
              spellCheck={false}
              className="font-mono tabular-nums flex-1 min-w-0 min-h-65 rounded-control border border-inner-border bg-input-bg px-6 py-5 text-caption text-text-primary resize-y box-border"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePaste()}
              className="shrink-0"
            >
              Paste
            </Button>
            {/* Same field, same parser — the file only replaces typing. Accepts
                the JSON export this dialog produces, plus .txt/.jsonl carrying
                one credential per line. */}
            <label className="btn btn-secondary shrink-0 cursor-pointer">
              <input
                type="file"
                accept=".json,.txt,.jsonl,.ndjson,application/json,text/plain"
                aria-label="Import credentials from a file"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) handleFile(file);
                }}
              />
              Import file
            </label>
          </Inline>
        </Stack>
        {isBatch && (
          <div
            className="flex flex-col gap-2 max-h-75 overflow-y-auto rounded-control border border-inner-border bg-surface-2 px-4 py-5"
          >
            {entries.map((entry, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div
                key={index}
                className="flex items-center justify-between gap-4 text-badge"
              >
                <span className="truncate min-w-0">
                  {batchNames[index]}
                </span>
                <Badge tone={entry.kind === "oauth" ? "accent" : "default"}>
                  {entry.kind === "oauth" ? "OAuth" : "API key"}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

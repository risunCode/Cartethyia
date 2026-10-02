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
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../../data/api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { HealthEventsModal } from "../../components/HealthEventsModal";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import {
  useCreateProviderAccount,
  useExportProviderAccounts,
  useRecoverAccount,
  useUpdateProviderAccount,
} from "../../hooks/providers";
import { useProviderAccountInflight } from "../../hooks/routing";
import { useRefreshAccountQuota, type AccountTestResult } from "../../hooks/quota";
import { queryKeys } from "../../data/query-keys";
import {
  assignAccountNames,
  parseCredentialBatch,
  type ParsedCredentialEntry,
} from "../../shared/credential-extract";
import { formatResetDistance } from "../../shared/quota-formatters";
import {
  activeModelCooldowns,
  lastModelCooldownAt,
} from "../../components/AccountCooldown";
import { downloadTextFile } from "../../shared/download";
import { toast } from "../../shared/toast";
import type { ProviderAccountResponse } from "../../data/contracts";



function accountStatusRank(status: string): number {
  if (status === "active") return 0;
  if (status === "cooldown") return 2;
  return 3;
}

/**
 * What flipping the static-token flag costs, per direction.
 *
 * Both directions are consequential and must not be applied on a single click:
 * turning it *on* stops refreshing, so the account dies at token expiry; turning
 * it *off* hands the credential back to the OAuth sweep, which will try to
 * refresh it on its next pass and — for a pasted token with no working refresh
 * grant — fail and mark the account for re-auth. The operator should confirm
 * either way, so the button never flips the mode silently.
 *
 * Exported so the confirmation copy is testable without a DOM: `Dialog` renders
 * through `createPortal` behind a `mounted` effect, which never runs under
 * `renderToStaticMarkup`, so the dialog's body cannot be asserted through a
 * render.
 */
export function staticTokenWarning(
  enabling: boolean,
  label: string,
): {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
} {
  if (enabling)
    return {
      title: "Mark as static token (no refresh)?",
      message: `${label} will be used exactly as issued and the gateway will stop refreshing it. That is correct for a pasted JWT or access token with no working refresh grant — but the account will simply stop working once the token expires, and it will not recover on its own. You can re-enable refresh later.`,
      confirmLabel: "Mark as static token",
    };
  return {
    title: "Re-enable refresh?",
    message: `${label} returns to normal OAuth refresh handling, and the gateway will try to refresh the credential on its next pass. If this is a pasted token with no working refresh grant, the refresh will fail and the account will be marked for re-auth. Turn it back on to keep using the credential as issued.`,
    confirmLabel: "Re-enable refresh",
  };
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
}: {
  readonly cooldowns: { count: number; modelId: string; until: string } | undefined;
}): ReactNode {
  if (!cooldowns) return null;
  const distance = formatResetDistance(cooldowns.until);
  return (
    <Badge tone="warn" dot title={`Soonest: ${cooldowns.modelId} — ${distance}`}>
      {cooldowns.count} model{cooldowns.count === 1 ? "" : "s"} cooling · {distance}
    </Badge>
  );
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
    const revoked = account.lastErrorCategory === "auth_invalidated";
    return (
      <Inline gap="4px">
        <Badge tone="disabled" dot title={account.lastError}>
          Disabled
        </Badge>
        {revoked ? (
          <Badge tone="warn" title={account.lastError}>
            Re-login required
          </Badge>
        ) : account.lastErrorCategory ? (
          <Badge tone="warn" title={account.lastError}>
            {account.lastErrorCategory}
          </Badge>
        ) : null}
        <ModelCooldownChip cooldowns={modelCooldowns} />
      </Inline>
    );
  }
  if (account.status === "active") {
    // An account can be `active` and still have per-model backoffs: the router
    // skips those (account, model) pairs while the account stays usable for
    // every other model. Showing a bare "Active" hid that entirely.
    //
    // A static-token account is `active` and usable exactly as issued: it is
    // never refreshed, so it carries an informational pill rather than the
    // "Active" one — the operator needs to know it will stop at token expiry
    // and that no refresh is being attempted.
    const staticToken = account.staticToken === true;
    return (
      <Inline gap="4px">
        <Badge tone={staticToken ? "info" : "ok"} dot>
          {staticToken ? "Static token" : "Active"}
        </Badge>
        {staticToken ? (
          <Badge tone="info" title="Used as issued and never refreshed; re-login before it expires.">
            no refresh
          </Badge>
        ) : null}
        <ModelCooldownChip cooldowns={modelCooldowns} />
      </Inline>
    );
  }
  if (account.status === "cooldown" || hasActiveCooldown)
    return (
      <Inline gap="4px">
        <Badge tone="warn" dot>
          Cooldown{" "}
          {account.cooldownUntil ? `(${formatResetDistance(account.cooldownUntil)})` : ""}
        </Badge>
        {account.lastErrorCategory ? (
          <Badge tone="warn" title={account.lastError}>
            {account.lastErrorCategory}
          </Badge>
        ) : null}
        <ModelCooldownChip cooldowns={modelCooldowns} />
      </Inline>
    );
  return <Badge tone="disabled">Disabled</Badge>;
}

/** Compact account-card detail: status is shown in the badge, not raw errors. */
function accountDetail(account: ProviderAccountResponse): string {
  return account.credentialKind === "oauth"
    ? "OAuth"
    : account.credentialKind === "api_key"
      ? "API key"
      : "No credential";
}

function AccountRow({
  providerId,
  account,
  inflight,
  selected,
  onToggleSelect,
  onDelete,
}: {
  readonly providerId: string;
  readonly account: ProviderAccountResponse;
  readonly inflight?: number;
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
  // Holds the direction awaiting confirmation: `true` = about to mark as a
  // static token, `false` = about to re-enable refresh, `null` = no dialog.
  const [staticConfirm, setStaticConfirm] = useState<boolean | null>(null);
  const label = account.label || account.id.slice(0, 8);
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

  // Marks the credential as a static bearer token (used as issued, never
  // refreshed) or returns it to normal OAuth refresh handling. This is the
  // operator's escape hatch for a pasted JWT/access token whose refresh grant
  // is absent or dead while the token itself is still valid.
  //
  // Both directions are consequential — turning it on stops refreshing (death
  // at expiry), turning it off hands the credential back to the OAuth sweep,
  // which fails for a token with no working grant — so each opens a
  // confirmation explaining the cost rather than flipping the mode on one click.
  const staticToken = account.staticToken === true;
  const applyStaticToken = (): Promise<unknown> =>
    update.mutateAsync({
      providerId,
      accountId: account.id,
      request: { staticToken: !staticToken },
    });
  const toggleStaticToken = () => setStaticConfirm(!staticToken);

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
        className="account-row"
        role="listitem"
        data-selected={selected ? "true" : undefined}
        style={{ opacity: disabled ? 0.62 : 1 }}
      >
        <div className="account-row-check">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onToggleSelect(account.id, event.target.checked)}
            aria-label={`Select ${label}`}
            style={{ cursor: "pointer" }}
          />
        </div>

        <div className="account-row-main">
          <div className="account-row-title">
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
                style={{ fontSize: "12.5px", maxWidth: "240px" }}
              />
            ) : (
              <>
                <span className="account-row-name" title={account.label || account.id}>
                  {label}
                </span>
                <button
                  type="button"
                  className="account-row-rename"
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
          <div className="account-row-meta" title={accountDetail(account)}>
            <AccountStatusBadge account={account} />
            <span className="account-row-detail">{accountDetail(account)}</span>
          </div>
          <div
            className="account-row-detail"
            aria-label={`Usage for ${label}`}
            style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}
          >
            <span>
              Today: {account.usageToday.totalTokens.toLocaleString()} tokens ·{" "}
              {account.usageToday.requests.toLocaleString()} requests
            </span>
            <span title="Lifetime totals are backfilled from telemetry still retained when tracking starts; new totals survive telemetry cleanup.">
              All time: {account.usageAllTime.totalTokens.toLocaleString()} tokens ·{" "}
              {account.usageAllTime.requests.toLocaleString()} requests
            </span>
            <span title="Concurrency comes from this provider’s Routing Strategy; accounts no longer carry manual ceilings.">
              In flight: {inflight?.toLocaleString() ?? "—"}
            </span>
          </div>
        </div>

        <div className="account-row-actions">
          <Button
            size="icon"
            variant={staticToken ? "primary" : "secondary"}
            icon={<TriangleAlert size={12} />}
            label={staticToken ? "Static token" : "No refresh"}
            aria-label={
              staticToken
                ? `Static token mode on for ${label}; click to re-enable refresh`
                : `Mark ${label} as a static token (no refresh)`
            }
            disabled={update.isPending}
            onClick={toggleStaticToken}
            title={
              staticToken
                ? "Static token: used as issued, never refreshed. Click to re-enable refresh."
                : "Mark as static token: use this credential as issued and never refresh it (for a pasted JWT/access token)."
            }
          />
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
          }}
          onClose={() => setShowHistory(false)}
        />
      )}
      <ConfirmDialog
        open={staticConfirm !== null}
        onClose={() => setStaticConfirm(null)}
        onConfirm={() =>
          applyStaticToken().then(() =>
            toast.success(
              staticConfirm ? "Marked as static token (no refresh)" : "Refresh re-enabled",
              label,
            ),
          )
        }
        title={staticTokenWarning(staticConfirm === true, label).title}
        message={staticTokenWarning(staticConfirm === true, label).message}
        confirmLabel={staticTokenWarning(staticConfirm === true, label).confirmLabel}
        cancelLabel="Cancel"
      />
    </>
  );
}

type AccountSortKey = "added" | "label" | "status" | "lastCheck";

const ACCOUNT_SORT_OPTIONS: ReadonlyArray<{ value: AccountSortKey; label: string }> = [
  { value: "added", label: "Added" },
  { value: "label", label: "Name" },
  { value: "status", label: "Status" },
  { value: "lastCheck", label: "Last check" },
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
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sortKey, setSortKey] = useState<AccountSortKey>("added");
  const [sortAsc, setSortAsc] = useState(true);
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
    const copy = [...filtered];
    copy.sort((a, b) => (sortAsc ? 1 : -1) * compareAccounts(a, b, sortKey));
    return copy;
  }, [filtered, sortKey, sortAsc]);

  const selectedAccounts = useMemo(
    () => accounts.filter((account) => selected.has(account.id)),
    [accounts, selected],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((account) => selected.has(account.id));

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
      <div className="account-toolbar">
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}>
            <Search
              size={13}
              aria-hidden="true"
              style={{
                position: "absolute",
                left: "10px",
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-tertiary)",
                pointerEvents: "none",
              }}
            />
            <Input
              id="accounts-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search accounts..."
              aria-label="Search accounts"
              style={{ paddingLeft: "30px" }}
            />
          </div>
        <div className="account-toolbar-actions">
        <label className="account-sort">
          <span>Sort</span>
          <Select
            size="sm"
            value={sortKey}
            onValueChange={(value) => setSortKey(value as AccountSortKey)}
            options={ACCOUNT_SORT_OPTIONS}
            aria-label="Sort accounts by"
            style={{ minWidth: "120px" }}
          />
          <button
            type="button"
            className="account-sort-dir"
            onClick={() => setSortAsc((asc) => !asc)}
            aria-label={sortAsc ? "Sort ascending" : "Sort descending"}
            title={sortAsc ? "Ascending" : "Descending"}
          >
            {sortAsc ? "▲" : "▼"}
          </button>
        </label>
        {showGrokProbe ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<FlaskConical size={12} className={grokProbePending ? "animate-spin" : ""} />}
            disabled={grokProbePending || accounts.length === 0}
            onClick={onGrokProbe}
            title="Probe every Grok account with 4.6 high reasoning"
          >
            {grokProbePending ? "Testing…" : "Test 407"}
          </Button>
        ) : null}
        <label className="account-select-all">
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

      {selectedAccounts.length > 0 ? (
        <div className="account-bulkbar">
          <span style={{ fontSize: "11.5px", fontWeight: 600 }}>
            {selectedAccounts.length} selected
          </span>
          <Inline gap="6px" style={{ flexWrap: "wrap", marginLeft: "auto" }}>
            <Button size="sm" variant="secondary" icon={<FlaskConical size={12} />} disabled={bulkBusy} onClick={bulkTest}>
              Test
            </Button>
            <Button size="sm" variant="secondary" icon={<RotateCcw size={12} />} disabled={bulkBusy} onClick={bulkRecover}>
              Recover
            </Button>
            <Button size="sm" variant="secondary" icon={<LockOpen size={12} />} disabled={bulkBusy} onClick={() => bulkSetActive(true)}>
              Enable
            </Button>
            <Button size="sm" variant="secondary" icon={<PowerOff size={12} />} disabled={bulkBusy} onClick={() => bulkSetActive(false)}>
              Disable
            </Button>
            <Button size="sm" variant="secondary" icon={<Download size={12} />} disabled={bulkBusy} onClick={bulkExport}>
              Export JSON
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={bulkBusy} onClick={() => setBulkDeleteOpen(true)}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </Inline>
        </div>
      ) : null}

      <div className="account-list" role="list" aria-label="Provider accounts">
        {sorted.map((account) => (
          <AccountRow
            key={account.id}
            providerId={providerId}
            account={account}
            inflight={inflightByAccount.get(account.id) ?? account.inflight}
            selected={selected.has(account.id)}
            onToggleSelect={toggleSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "11px",
          color: "var(--text-tertiary)",
        }}
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
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  const entries = parseCredentialBatch(secret);
  const isBatch = entries.length > 1;
  const singleEntry = entries.length === 1 ? entries[0] : undefined;
  const isOAuthDetected = singleEntry?.kind === "oauth";
  const existingNames = accounts.map((account) => account.label);
  const batchNames = isBatch ? assignAccountNames(entries, providerId, existingNames) : [];
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
        toast.success(
          "Pasted from clipboard",
          kind === "oauth" ? "Detected: OAuth export" : "Detected: API key",
        );
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
            credentialKind: entry.kind,
            secret: entry.value,
          },
        },
        {
          onSuccess: () => {
            toast.success(
              "Account connected",
              `New ${entry.kind === "oauth" ? "OAuth" : "API key"} account registered successfully`,
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
    let created = 0;
    const failed: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const name = batchNames[index] as string;
      try {
        await create.mutateAsync({
          providerId,
          request: { label: name, credentialKind: entry.kind, secret: entry.value },
        });
        created += 1;
      } catch (err) {
        failed.push(`${name}: ${(err as { message?: string }).message ?? "Invalid credentials"}`);
      }
    }
    setBatchSubmitting(false);
    if (created > 0) {
      toast.success(
        `${created} account${created === 1 ? "" : "s"} added`,
        failed.length > 0 ? `${failed.length} skipped` : undefined,
      );
    }
    if (failed.length > 0) {
      toast.error(
        `${failed.length} account${failed.length === 1 ? "" : "s"} failed`,
        failed.slice(0, 3).join("\n"),
      );
    }
    if (failed.length === 0) onClose();
  };

  return (
    <Dialog open={true} onClose={onClose} title="Add Account (API key / JSON)" width={560}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        {!isBatch && (
          <Input
            label="Account label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={singleEntry?.identity ?? `${providerId} account`}
          />
        )}
        <Stack gap="6px" style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
              API key, OAuth token, or exported JSON — one or many
            </label>
            {isBatch ? (
              <Badge tone="accent">Detected: {entries.length} accounts</Badge>
            ) : (
              singleEntry && (
                <Badge tone={isOAuthDetected ? "accent" : "default"}>
                  Detected: {isOAuthDetected ? "OAuth" : "API key"}
                  {singleEntry.identity ? ` · ${singleEntry.identity}` : ""}
                </Badge>
              )
            )}
          </div>
          <Inline gap="8px" align="flex-start" style={{ minWidth: 0 }}>
            <textarea
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Paste one credential, or many — one per line, a JSON array, or newline-delimited OAuth exports. Kind and account naming are detected automatically…"
              rows={6}
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: "130px",
                borderRadius: "10px",
                border: "1px solid var(--inner-border)",
                background: "var(--input-bg)",
                padding: "10px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                color: "var(--text-primary)",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePaste()}
              style={{ flexShrink: 0 }}
            >
              Paste
            </Button>
            {/* Same field, same parser — the file only replaces typing. Accepts
                the JSON export this dialog produces, plus .txt/.jsonl carrying
                one credential per line. */}
            <label
              className="btn btn-secondary"
              style={{ flexShrink: 0, cursor: "pointer" }}
            >
              <input
                type="file"
                accept=".json,.txt,.jsonl,.ndjson,application/json,text/plain"
                aria-label="Import credentials from a file"
                style={{ display: "none" }}
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
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              maxHeight: "150px",
              overflowY: "auto",
              borderRadius: "10px",
              border: "1px solid var(--inner-border)",
              background: "var(--surface-2)",
              padding: "8px 10px",
            }}
          >
            {entries.map((entry, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div
                key={index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  fontSize: "11.5px",
                }}
              >
                <span className="truncate" style={{ minWidth: 0 }}>
                  {batchNames[index]}
                </span>
                <Badge tone={entry.kind === "oauth" ? "accent" : "default"}>
                  {entry.kind === "oauth" ? "OAuth" : "API key"}
                </Badge>
              </div>
            ))}
          </div>
        )}
        <Inline justify="flex-end" gap="8px" style={{ marginTop: "6px" }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={submitting || entries.length === 0}
            onClick={() => void handleSubmit()}
          >
            {submitting
              ? "Connecting..."
              : isBatch
                ? `Add ${entries.length} Accounts`
                : "Add Account"}
          </Button>
        </Inline>
      </div>
    </Dialog>
  );
}

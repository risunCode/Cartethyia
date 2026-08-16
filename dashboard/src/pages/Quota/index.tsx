
import { CheckCircle2, Gauge, Layers, Trash2, TriangleAlert, Users } from "lucide-solid";
import { Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { ApiError, apiRaw, sanitizeErrorMessage } from "@lib/api";
import { consoleFailure, consolePatch, adminApiPath } from "@lib/console-api";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Dialog } from "@components/ui/dialog";
import { StatePanel } from "@components/ui/state";
import { Switch } from "@components/ui/switch";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { StatusBadge, type StatusBadgeStatus } from "@components/shared/StatusBadge";
import { VirtualTable, type VirtualTableColumn } from "@components/shared/VirtualTable";
import { ProgressBar } from "@components/patterns/progress-bar";
import { formatNumber, formatTime } from "@lib/format";
import {
  MAX_DETAIL_QUOTA_PROBES,
  fetchAllAccounts,
  formatQuotaCountdown,
  formatQuotaPercent,
  probeAccountQuotas,
  quotaUsageTone,
  type AccountQuotaWindow,
  type AccountRecord,
} from "@components/shared/quota-contracts";

/** Requirement 4: quota data refreshes every 30 seconds without a reload. */
const QUOTA_REFRESH_MS = 30_000;
const PAGE_STEP = 25;
const SAFE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;

/** One quota-visible account with its quota window or surfaced error. */
interface QuotaAccountRow {
  readonly account: AccountRecord;
  readonly quota: AccountQuotaWindow | null;
  readonly healthError: { readonly message: string; readonly retryAt: string | null } | null;
}

interface QuotaSnapshot {
  readonly rows: readonly QuotaAccountRow[];
  /** Accounts filtered out because their provider has no quota contract. */
  readonly filteredNoQuota: number;
  /** True when the account list exceeded the per-refresh probe budget. */
  readonly truncated: boolean;
  readonly fetchedAt: string;
}

/** Batch result contract returned by the API's account batch endpoints. */
interface BatchResultShape {
  processed?: unknown;
  succeeded?: unknown;
  failed?: unknown;
  errors?: unknown;
}

/**
 * Loads every account and its quota window. Accounts whose provider exposes
 * no quota endpoint (degraded probe) are filtered out and counted, per
 * Requirement 4.7.
 */
async function fetchQuotaSnapshot(): Promise<QuotaSnapshot> {
  const accounts = [...(await fetchAllAccounts())];
  accounts.sort((left, right) => left.providerId.localeCompare(right.providerId) || left.label.localeCompare(right.label));
  const truncated = accounts.length > MAX_DETAIL_QUOTA_PROBES;
  const targets = accounts.slice(0, MAX_DETAIL_QUOTA_PROBES);
  const outcomes = await probeAccountQuotas(targets, MAX_DETAIL_QUOTA_PROBES);
  const rows: QuotaAccountRow[] = [];
  let filteredNoQuota = 0;
  for (const account of targets) {
    const outcome = outcomes.get(account.id);
    if (!outcome) continue;
    if (outcome.kind === "unsupported") {
      filteredNoQuota += 1;
      continue;
    }
    if (outcome.kind === "error") {
      rows.push({ account, quota: null, healthError: { message: outcome.message, retryAt: null } });
      continue;
    }
    rows.push({ account, quota: outcome.window, healthError: null });
  }
  return { rows, filteredNoQuota, truncated, fetchedAt: new Date().toISOString() };
}

/**
 * Flips one account's active flag. The browser contract reaches this through
 * PATCH /console/providers/:id/accounts/batch with a single-item payload
 * (the API's per-account PATCH is not a browser-facing route).
 */
async function setAccountActive(providerId: string, accountId: string, enabled: boolean): Promise<void> {
  const result = await consolePatch<BatchResultShape>(`/providers/${encodeURIComponent(providerId)}/accounts/batch`, {
    items: [{ accountId, enabled }],
  });
  const failed = typeof result?.failed === "number" ? result.failed : 0;
  if (failed > 0) {
    const firstError = Array.isArray(result?.errors) && typeof result.errors[0] === "string" ? result.errors[0] : undefined;
    throw new Error(sanitizeErrorMessage(firstError ?? "account update failed", "account update failed"));
  }
}

/** DELETEs one account through the per-account API endpoint (204 on success). */
async function deleteAccount(providerId: string, accountId: string): Promise<void> {
  const response = await apiRaw(
    adminApiPath(`/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`),
    { method: "DELETE" },
  );
  if (response.ok) return;
  let code = `http_${response.status}`;
  let message = `request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (body.error && typeof body.error === "object") {
      if (typeof body.error.code === "string" && SAFE_CODE.test(body.error.code)) code = body.error.code;
      if (typeof body.error.message === "string") message = body.error.message;
    }
  } catch {
    // Non-JSON error bodies keep the status fallback text.
  }
  throw new ApiError(response.status, code, message);
}

interface AccountHealthView {
  readonly status: StatusBadgeStatus;
  readonly label: string;
  readonly message: string | null;
  readonly retryAt: string | null;
}

/** Derives the account health view from the record, quota errors, and re-auth state. */
function rowHealth(row: QuotaAccountRow): AccountHealthView {
  if (!row.account.enabled) return { status: "offline", label: "Inactive", message: "Account disabled", retryAt: null };
  if (row.account.reauthRequired) return { status: "down", label: "Down", message: "Re-authentication required", retryAt: null };
  if (row.healthError) return { status: "down", label: "Down", message: row.healthError.message, retryAt: row.healthError.retryAt };
  if (!row.quota) return { status: "pending", label: "Unknown", message: null, retryAt: null };
  return { status: "active", label: "Active", message: null, retryAt: null };
}

/** Renders the quota window bar with the exhausted ("quota empty") indicator. */
function QuotaWindowCell(props: { row: QuotaAccountRow }): JSX.Element {
  const quota = props.row.quota;
  if (!quota) return <span class="text-[var(--text-3)]">—</span>;
  const exhausted = quota.remaining <= 0 || (quota.remainingPercent ?? 0) <= 0;
  return (
    <div class="min-w-[170px] space-y-1">
      <ProgressBar value={quota.usedPercent} tone={exhausted ? "danger" : quotaUsageTone(quota.usedPercent)} />
      <div class="flex flex-wrap items-center gap-1.5">
        <Show when={exhausted}>
          <Badge tone="err">Quota empty</Badge>
        </Show>
        <span class="text-[10px] tabular-nums text-[var(--text-3)]">
          {formatQuotaPercent(quota.usedPercent)} used · {formatNumber(quota.remaining)} left
        </span>
      </div>
    </div>
  );
}

function EndpointRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="flex items-center justify-between gap-3">
      <dt class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">{props.label}</dt>
      <dd class="truncate font-mono text-[11.5px] text-[var(--text-1)]" title={props.value}>
        {props.value}
      </dd>
    </div>
  );
}

/** Quota Management page — every account's quota window with lifecycle actions. */
export default function Quota(): JSX.Element {
  const [resource, { refetch }] = createResource(fetchQuotaSnapshot);
  const [visibleCount, setVisibleCount] = createSignal(PAGE_STEP);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<QuotaAccountRow | null>(null);

  const snapshot = createMemo(() => (resource.error ? null : resource() ?? null));
  const rows = createMemo(() => snapshot()?.rows ?? []);
  const initialLoading = createMemo(() => resource.loading && snapshot() === null);
  const errorInfo = createMemo(() => (resource.error ? consoleFailure(resource.error) : null));

  const summary = createMemo(() => {
    let quotaEmpty = 0;
    let active = 0;
    for (const row of rows()) {
      const quota = row.quota;
      if (quota && (quota.remaining <= 0 || (quota.remainingPercent ?? 0) <= 0)) quotaEmpty += 1;
      if (row.account.enabled) active += 1;
    }
    return { total: rows().length, active, quotaEmpty, filtered: snapshot()?.filteredNoQuota ?? 0 };
  });

  onMount(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refetch();
    }, QUOTA_REFRESH_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  const reportActionError = (cause: unknown): void => {
    setActionError(cause instanceof Error ? sanitizeErrorMessage(cause.message, "request failed") : "request failed");
  };

  const toggleActive = async (row: QuotaAccountRow, next: boolean): Promise<void> => {
    setBusyId(row.account.id);
    setActionError(null);
    try {
      await setAccountActive(row.account.providerId, row.account.id, next);
      await refetch();
    } catch (cause) {
      reportActionError(cause);
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const row = pendingDelete();
    if (!row) return;
    setPendingDelete(null);
    setBusyId(row.account.id);
    setActionError(null);
    try {
      await deleteAccount(row.account.providerId, row.account.id);
      await refetch();
    } catch (cause) {
      reportActionError(cause);
    } finally {
      setBusyId(null);
    }
  };

  const columns: VirtualTableColumn<QuotaAccountRow>[] = [
    {
      key: "account",
      label: "Account",
      render: (row) => (
        <div class="max-w-[230px]">
          <div class="truncate text-[12px] font-semibold text-[var(--text-1)]">{row.account.label}</div>
          <div class="truncate text-[10px] text-[var(--text-3)]">{row.account.email ?? row.account.id}</div>
        </div>
      ),
    },
    {
      key: "provider",
      label: "Provider",
      render: (row) => <span class="font-mono text-[10.5px] text-[var(--text-2)]">{row.account.providerId}</span>,
    },
    {
      key: "health",
      label: "Health",
      width: "220px",
      render: (row) => {
        const health = rowHealth(row);
        return (
          <div class="space-y-0.5">
            <StatusBadge status={health.status} label={health.label} />
            <Show when={health.message}>
              {(message) => (
                <p class="flex items-center gap-1 text-[10px] text-[var(--status-danger)]" role="alert" title={message()}>
                  <TriangleAlert size={11} aria-hidden="true" />
                  <span class="truncate">{message()}</span>
                  <Show when={health.retryAt}>
                    <span class="shrink-0 text-[var(--text-3)]">· retry {formatQuotaCountdown(health.retryAt)}</span>
                  </Show>
                </p>
              )}
            </Show>
          </div>
        );
      },
    },
    { key: "quota", label: "Quota window", width: "190px", render: (row) => <QuotaWindowCell row={row} /> },
    {
      key: "reset",
      label: "Resets",
      render: (row) => (
        <span class="tabular-nums" title={row.quota?.resetsAt ? formatTime(row.quota.resetsAt) : undefined}>
          {row.quota?.resetsAt ? formatQuotaCountdown(row.quota.resetsAt) : "—"}
          <Show when={row.quota?.retryAt}>
            {(retryAt) => <span class="ml-1 text-[var(--text-3)]">· retry {formatQuotaCountdown(retryAt())}</span>}
          </Show>
        </span>
      ),
    },
    {
      key: "active",
      label: "Active",
      align: "center",
      render: (row) => (
        <Switch
          checked={row.account.enabled}
          disabled={busyId() === row.account.id}
          onChange={(next) => void toggleActive(row, next)}
          label={`${row.account.enabled ? "Deactivate" : "Activate"} ${row.account.label}`}
        />
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (row) => (
        <Button
          size="icon"
          variant="ghost"
          disabled={busyId() === row.account.id}
          onClick={() => setPendingDelete(row)}
          aria-label={`Delete ${row.account.label}`}
        >
          <Trash2 size={13} aria-hidden="true" />
        </Button>
      ),
    },
  ];

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Quota Management</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">
            Account quota windows and health across providers. Auto-refreshes every 30 seconds.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={resource.loading && snapshot() !== null}>
            <Badge tone="info">Refreshing…</Badge>
          </Show>
          <Show when={snapshot()}>
            {(current) => (
              <Badge tone="neutral" className="font-mono">
                Fetched {formatTime(current().fetchedAt)}
              </Badge>
            )}
          </Show>
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </header>

      <section aria-label="Quota summary">
        <Show
          when={!initialLoading()}
          fallback={
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCardSkeleton label="Accounts" />
              <MetricCardSkeleton label="Active accounts" />
              <MetricCardSkeleton label="Quota empty" />
              <MetricCardSkeleton label="No quota support" />
            </div>
          }
        >
          <div class="grid animate-fade-in grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Accounts" value={formatNumber(summary().total)} icon={Users} tone="accent" description="Quota-visible accounts" />
            <MetricCard label="Active" value={formatNumber(summary().active)} icon={CheckCircle2} tone="success" description="Enabled accounts" />
            <MetricCard
              label="Quota empty"
              value={formatNumber(summary().quotaEmpty)}
              icon={TriangleAlert}
              tone={summary().quotaEmpty > 0 ? "danger" : "success"}
              description="Exhausted quota windows"
            />
            <MetricCard label="No quota support" value={formatNumber(summary().filtered)} icon={Layers} tone="neutral" description="Filtered from this list" />
          </div>
        </Show>
        <Show when={summary().filtered > 0}>
          <p role="note" class="mt-2 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[11px] text-[var(--text-3)]">
            {summary().filtered} account{summary().filtered === 1 ? "" : "s"} hidden — the provider exposes no quota endpoint
            (GET /console/accounts/:id/quota is unavailable).
          </p>
        </Show>
        <Show when={snapshot()?.truncated}>
          <p role="note" class="mt-2 text-[11px] text-[var(--status-warning)]">
            Showing the first {MAX_DETAIL_QUOTA_PROBES} accounts — refresh cycles probe in this budget to keep the API responsive.
          </p>
        </Show>
      </section>

      <Show when={actionError()}>
        {(message) => (
          <p class="text-[12px] font-medium text-[var(--status-danger)]" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Show
        when={!errorInfo()}
        fallback={
          <Show when={errorInfo()}>
            {(info) => (
              <StatePanel
                kind={info().degraded ? "degraded" : "error"}
                title={info().degraded ? "Quota data degraded" : "Failed to load quota data"}
                description={`${info().message} (${info().code})`}
                action={
                  <Button variant="secondary" onClick={() => void refetch()}>
                    Retry
                  </Button>
                }
              />
            )}
          </Show>
        }
      >
        <VirtualTable
          title="Accounts"
          subtitle={`${rows().length} quota-visible account${rows().length === 1 ? "" : "s"} · toggle active or delete`}
          icon={Gauge}
          iconColor="#bf5af2"
          items={rows()}
          columns={columns}
          rowKey={(row) => row.account.id}
          pageSize={visibleCount()}
          onLoadMore={() => setVisibleCount((count) => count + PAGE_STEP)}
          hasMore={visibleCount() < rows().length}
          loading={initialLoading()}
          emptyMessage={
            summary().filtered > 0
              ? "All accounts were filtered — their providers expose no quota endpoint."
              : "No accounts are configured yet."
          }
          ariaLabel="Accounts with quota windows"
        />
      </Show>

      <Card density="compact">
        <CardHeader title="Endpoint reference" sub="V2 admin routes behind this page" />
        <dl class="grid gap-2 text-[11.5px] sm:grid-cols-2">
          <EndpointRow label="Accounts" value="GET /console/accounts" />
          <EndpointRow label="Quota window" value="GET /console/accounts/:id/quota" />
          <EndpointRow label="Toggle active" value="PATCH /console/providers/:id/accounts/batch" />
          <EndpointRow label="Delete account" value="DELETE /console/providers/:id/accounts/:accountId" />
        </dl>
      </Card>

      <Show when={pendingDelete()}>
        {(row) => (
          <Dialog
            open
            title="Delete account?"
            onClose={() => setPendingDelete(null)}
            footer={
              <>
                <Button variant="secondary" onClick={() => setPendingDelete(null)}>
                  Cancel
                </Button>
                <Button variant="danger" disabled={busyId() === row().account.id} onClick={() => void confirmDelete()}>
                  Delete
                </Button>
              </>
            }
          >
            <p class="text-sm text-[var(--text-2)]">
              Permanently delete <span class="font-semibold text-[var(--text-1)]">{row().account.label}</span> on provider{" "}
              <span class="font-mono text-[12px]">{row().account.providerId}</span>? This cannot be undone.
            </p>
          </Dialog>
        )}
      </Show>
    </div>
  );
}

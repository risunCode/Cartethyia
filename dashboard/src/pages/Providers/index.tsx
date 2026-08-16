
import { ArrowLeft, CheckCircle2, CircleAlert, Gauge, Layers, Server, Timer, TriangleAlert, Users } from "lucide-solid";
import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { StatePanel } from "@components/ui/state";
import { LoadingState } from "@components/shared/LoadingState";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { StatusBadge, type StatusBadgeStatus } from "@components/shared/StatusBadge";
import { VirtualTable, type VirtualTableColumn } from "@components/shared/VirtualTable";
import { ProgressBar } from "@components/patterns/progress-bar";
import { consoleFailure, consoleGet } from "@lib/console-api";
import { formatDuration, formatNumber, formatTime } from "@lib/format";
import {
  MAX_DETAIL_QUOTA_PROBES,
  MAX_LIST_QUOTA_PROBES,
  PER_PROVIDER_PROBE_LIMIT,
  aggregateQuota,
  fetchAllAccounts,
  fetchProviderCatalog,
  fetchProviderScopedAccounts,
  formatQuotaCountdown,
  formatQuotaPercent,
  isRecordValue,
  probeAccountQuotas,
  providerRequiresCredentials,
  quotaUsageTone,
  toBoundedString,
  toFiniteNumber,
  type AccountRecord,
  type ProviderCatalogEntry,
  type QuotaAggregate,
  type QuotaProbeOutcome,
} from "@components/shared/quota-contracts";

/** Requirement 3: provider data refreshes every 60 seconds without a reload. */
const PROVIDERS_REFRESH_MS = 60_000;
const PAGE_STEP = 25;
const TELEMETRY_ROUTE = "/telemetry/upstream?period=24h&group_by=provider";
const TELEMETRY_PROVIDER_KEYS = ["provider", "provider_id", "providerId", "group"] as const;

/** Per-provider success rate and latency derived from upstream telemetry. */
interface ProviderTelemetry {
  readonly requests: number;
  readonly errors: number;
  readonly successRatePercent: number | null;
  readonly avgLatencyMs: number | null;
}

interface ProviderState {
  readonly status: StatusBadgeStatus;
  readonly reason: string | null;
  readonly lastError: string | null;
}

interface ProviderRow {
  readonly entry: ProviderCatalogEntry;
  readonly accounts: readonly AccountRecord[];
  readonly state: ProviderState;
  readonly quota: QuotaAggregate | null;
  readonly quotaProbed: boolean;
  readonly telemetry: ProviderTelemetry | null;
}

interface ProvidersSnapshot {
  readonly rows: readonly ProviderRow[];
  readonly fetchedAt: string;
  readonly telemetryAvailable: boolean;
  readonly accountsUnavailable: boolean;
}

interface ProviderDetailSnapshot {
  readonly providerId: string;
  readonly accounts: readonly AccountRecord[];
  readonly quotaByAccount: ReadonlyMap<string, QuotaProbeOutcome>;
  readonly telemetry: ProviderTelemetry | null;
  readonly fetchedAt: string;
}

interface QuotaWindowRow {
  readonly account: AccountRecord;
  readonly outcome: QuotaProbeOutcome | null;
}

/**
 * Reads grouped upstream telemetry (GET /telemetry/upstream) and
 * returns per-provider aggregates, or null when the API does not expose
 * the telemetry service for this deployment.
 */
async function fetchProviderTelemetry(): Promise<Map<string, ProviderTelemetry> | null> {
  let payload: unknown;
  try {
    payload = await consoleGet<unknown>(TELEMETRY_ROUTE);
  } catch {
    return null;
  }
  if (!isRecordValue(payload) || !Array.isArray(payload.items)) return null;
  const totals = new Map<string, { requests: number; errors: number; latencyWeight: number; latencySum: number }>();
  for (const raw of payload.items) {
    if (!isRecordValue(raw)) continue;
    const metadata = isRecordValue(raw.metadata) ? raw.metadata : {};
    let providerId: string | null = null;
    for (const key of TELEMETRY_PROVIDER_KEYS) {
      providerId = toBoundedString(metadata[key], 128);
      if (providerId) break;
    }
    if (!providerId) continue;
    const count = toFiniteNumber(raw.count) ?? 0;
    const errors = toFiniteNumber(raw.errors) ?? 0;
    const latencyMs = toFiniteNumber(raw.latencyMs);
    const current = totals.get(providerId) ?? { requests: 0, errors: 0, latencyWeight: 0, latencySum: 0 };
    current.requests += count;
    current.errors += errors;
    if (latencyMs !== null) {
      current.latencyWeight += count;
      current.latencySum += latencyMs * count;
    }
    totals.set(providerId, current);
  }
  const byProvider = new Map<string, ProviderTelemetry>();
  for (const [providerId, value] of totals) {
    byProvider.set(providerId, {
      requests: value.requests,
      errors: value.errors,
      successRatePercent:
        value.requests > 0
          ? Math.max(0, Math.min(100, ((value.requests - value.errors) / value.requests) * 100))
          : null,
      avgLatencyMs: value.latencyWeight > 0 ? value.latencySum / value.latencyWeight : null,
    });
  }
  return byProvider;
}

/**
 * Derives the active/degraded/down status of one provider from its catalog
 * entry and account list. When the account list itself is unavailable the
 * catalog flags are the only honest signal.
 */
function deriveProviderState(
  entry: ProviderCatalogEntry,
  accounts: readonly AccountRecord[],
  quotaErrorMessages: readonly string[],
  accountsUnavailable: boolean,
): ProviderState {
  if (!entry.enabled) {
    return { status: "down", reason: "Provider is disabled", lastError: "The provider is disabled in the catalog." };
  }
  if (accountsUnavailable) {
    return { status: "active", reason: "Account list unavailable — status from catalog only", lastError: null };
  }
  if (accounts.length === 0) {
    return providerRequiresCredentials(entry)
      ? { status: "degraded", reason: "No accounts connected", lastError: null }
      : { status: "active", reason: null, lastError: null };
  }
  const enabledAccounts = accounts.filter((account) => account.enabled);
  if (enabledAccounts.length === 0) {
    return { status: "down", reason: "All accounts are disabled", lastError: "Every account of this provider is disabled." };
  }
  const reauthAccounts = enabledAccounts.filter((account) => account.reauthRequired);
  const firstReauth = reauthAccounts[0];
  if (reauthAccounts.length === enabledAccounts.length) {
    return {
      status: "down",
      reason: "All enabled accounts require re-authentication",
      lastError: firstReauth ? `Account “${firstReauth.label}” requires re-authentication` : null,
    };
  }
  const lastError = firstReauth
    ? `Account “${firstReauth.label}” requires re-authentication`
    : quotaErrorMessages[0] ?? null;
  if (reauthAccounts.length > 0) {
    return { status: "degraded", reason: `${reauthAccounts.length} of ${accounts.length} accounts need re-authentication`, lastError };
  }
  const disabled = accounts.length - enabledAccounts.length;
  if (disabled > 0) {
    return { status: "degraded", reason: `${disabled} of ${accounts.length} accounts disabled`, lastError };
  }
  return { status: "active", reason: null, lastError };
}

/** Builds the provider fleet snapshot from catalog, accounts, telemetry, and quota probes. */
async function fetchProvidersSnapshot(): Promise<ProvidersSnapshot> {
  const catalog = [...(await fetchProviderCatalog())];
  let accounts: AccountRecord[] = [];
  let accountsUnavailable = false;
  try {
    accounts = [...(await fetchAllAccounts())];
  } catch {
    accountsUnavailable = true;
  }
  const telemetry = await fetchProviderTelemetry();

  // Providers that only exist as accounts still get a row so nothing routes invisibly.
  const knownIds = new Set(catalog.map((entry) => entry.id));
  for (const providerId of new Set(accounts.map((account) => account.providerId))) {
    if (knownIds.has(providerId)) continue;
    catalog.push({
      id: providerId,
      name: providerId,
      protocols: [],
      credentialKinds: ["unknown"],
      enabled: true,
      configured: true,
      accountCount: 0,
      modelCount: 0,
      enabledModelCount: 0,
      models: [],
    });
  }

  // Bounded quota probing: up to PER_PROVIDER_PROBE_LIMIT accounts per provider
  // within a global budget, preferring enabled accounts.
  const targetsByProvider = new Map<string, AccountRecord[]>();
  const probeTargets: AccountRecord[] = [];
  for (const entry of catalog) {
    const providerAccounts = accounts.filter((account) => account.providerId === entry.id);
    const enabledAccounts = providerAccounts.filter((account) => account.enabled);
    const pool = enabledAccounts.length > 0 ? enabledAccounts : providerAccounts;
    const budget = Math.max(0, MAX_LIST_QUOTA_PROBES - probeTargets.length);
    const targets = pool.slice(0, Math.min(PER_PROVIDER_PROBE_LIMIT, budget));
    if (targets.length === 0) continue;
    targetsByProvider.set(entry.id, targets);
    probeTargets.push(...targets);
  }
  const quotaOutcomes = accountsUnavailable
    ? new Map<string, QuotaProbeOutcome>()
    : await probeAccountQuotas(probeTargets, probeTargets.length);

  const severity: Record<StatusBadgeStatus, number> = {
    down: 0,
    error: 0,
    degraded: 1,
    warning: 1,
    offline: 2,
    pending: 2,
    active: 3,
    healthy: 3,
  };
  const rows: ProviderRow[] = catalog.map((entry) => {
    const providerAccounts = accounts.filter((account) => account.providerId === entry.id);
    const outcomes = (targetsByProvider.get(entry.id) ?? [])
      .map((account) => quotaOutcomes.get(account.id))
      .filter((outcome): outcome is QuotaProbeOutcome => outcome !== undefined);
    const quotaErrorMessages = outcomes.flatMap((outcome) => (outcome.kind === "error" ? [outcome.message] : []));
    return {
      entry,
      accounts: providerAccounts,
      state: deriveProviderState(entry, providerAccounts, quotaErrorMessages, accountsUnavailable),
      quota: aggregateQuota(outcomes),
      quotaProbed: outcomes.length > 0,
      telemetry: telemetry?.get(entry.id) ?? null,
    };
  });
  rows.sort(
    (left, right) => severity[left.state.status] - severity[right.state.status] || left.entry.name.localeCompare(right.entry.name),
  );

  return {
    rows,
    fetchedAt: new Date().toISOString(),
    telemetryAvailable: telemetry !== null,
    accountsUnavailable,
  };
}

/** Loads one provider's detail: scoped accounts, quota windows, and telemetry. */
async function fetchProviderDetail(row: ProviderRow | null): Promise<ProviderDetailSnapshot | null> {
  if (!row) return null;
  let accounts = row.accounts;
  try {
    accounts = [...(await fetchProviderScopedAccounts(row.entry.id))];
  } catch {
    // Keep the snapshot rows when the scoped listing is unavailable.
  }
  const telemetry = await fetchProviderTelemetry();
  const targets = accounts.slice(0, MAX_DETAIL_QUOTA_PROBES);
  const quotaByAccount = await probeAccountQuotas(targets, MAX_DETAIL_QUOTA_PROBES);
  return {
    providerId: row.entry.id,
    accounts,
    quotaByAccount,
    telemetry: telemetry?.get(row.entry.id) ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

function accountStatusView(account: AccountRecord): { status: StatusBadgeStatus; label: string; detail: string | null } {
  if (!account.enabled) return { status: "offline", label: "Disabled", detail: "Account is inactive" };
  if (account.reauthRequired) return { status: "down", label: "Down", detail: "Re-authentication required" };
  return { status: "active", label: "Active", detail: null };
}

/** Quota usage cell for the provider list: aggregate bar or explicit "no quota". */
function QuotaCell(props: { aggregate: QuotaAggregate | null; probed: boolean }): JSX.Element {
  const ready = (): QuotaAggregate | null => {
    const aggregate = props.aggregate;
    return aggregate !== null && aggregate.windows > 0 ? aggregate : null;
  };
  return (
    <Show
      when={ready()}
      keyed
      fallback={
        <Show when={props.probed} fallback={<span class="text-[var(--text-3)]">—</span>}>
          <Badge tone="neutral">No quota</Badge>
        </Show>
      }
    >
      {(aggregate) => (
        <div class="min-w-[120px] space-y-1">
          <ProgressBar value={aggregate.usedPercent} tone={quotaUsageTone(aggregate.usedPercent)} />
          <span class="text-[10px] tabular-nums text-[var(--text-3)]">{formatQuotaPercent(aggregate.usedPercent)} used</span>
        </div>
      )}
    </Show>
  );
}

/** Renders one account's quota probe outcome: window, unsupported, or error. */
function QuotaOutcomeCell(props: { outcome: QuotaProbeOutcome | null }): JSX.Element {
  if (props.outcome === null) return <span class="text-[var(--text-3)]">—</span>;
  if (props.outcome.kind === "unsupported") return <Badge tone="neutral">No quota endpoint</Badge>;
  if (props.outcome.kind === "error") {
    return (
      <div class="space-y-1">
        <Badge tone="err">Quota error</Badge>
        <p class="max-w-[220px] truncate text-[10px] text-[var(--status-danger)]" role="alert" title={props.outcome.message}>
          {props.outcome.message}
        </p>
      </div>
    );
  }
  const window = props.outcome.window;
  return (
    <div class="min-w-[150px] space-y-1">
      <ProgressBar value={window.remainingPercent} tone={quotaUsageTone(window.usedPercent)} />
      <span class="block text-[10px] tabular-nums text-[var(--text-3)]">
        {formatQuotaPercent(window.remainingPercent)} left · {formatNumber(window.remaining)} of {formatNumber(window.limit)}
      </span>
      <Show when={window.retryAt}>
        {(retryAt) => <span class="block text-[9px] text-[var(--text-3)]">retry {formatQuotaCountdown(retryAt())}</span>}
      </Show>
    </div>
  );
}

function FactRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
      <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{props.label}</div>
      <div class="mt-1 truncate text-[12px] font-semibold text-[var(--text-1)]" title={props.value}>
        {props.value}
      </div>
    </div>
  );
}

/** Providers page — fleet status with drill-down detail per provider. */
export default function Providers(): JSX.Element {
  const [resource, { refetch }] = createResource(fetchProvidersSnapshot);
  const [selected, setSelected] = createSignal<ProviderRow | null>(null);
  const [detailResource, { refetch: refetchDetail }] = createResource(selected, fetchProviderDetail);
  const [visibleProviders, setVisibleProviders] = createSignal(PAGE_STEP);
  const [visibleWindows, setVisibleWindows] = createSignal(PAGE_STEP);
  const [visibleEndpoints, setVisibleEndpoints] = createSignal(PAGE_STEP);

  const snapshot = createMemo(() => (resource.error ? null : resource() ?? null));
  const rows = createMemo(() => snapshot()?.rows ?? []);
  const detail = createMemo(() => (detailResource.error ? null : detailResource() ?? null));
  const initialLoading = createMemo(() => resource.loading && snapshot() === null);
  const errorInfo = createMemo(() => (resource.error ? consoleFailure(resource.error) : null));
  const telemetryUnavailable = createMemo(() => (snapshot() ? !snapshot()?.telemetryAvailable : false));
  const accountsUnavailable = createMemo(() => snapshot()?.accountsUnavailable === true);

  const statusCounts = createMemo(() => {
    const counts = { active: 0, degraded: 0, down: 0 };
    for (const row of rows()) {
      if (row.state.status === "active") counts.active += 1;
      else if (row.state.status === "degraded") counts.degraded += 1;
      else if (row.state.status === "down") counts.down += 1;
    }
    return counts;
  });
  const quotaTracked = createMemo(() => rows().filter((row) => (row.quota?.windows ?? 0) > 0).length);

  // A refreshed snapshot swaps the selected row object so the detail view
  // follows the 60-second refresh cycle without a manual reload.
  createEffect(() => {
    const current = snapshot();
    const active = selected();
    if (!current || !active) return;
    const next = current.rows.find((row) => row.entry.id === active.entry.id) ?? null;
    if (next !== active) setSelected(next);
  });

  onMount(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refetch();
    }, PROVIDERS_REFRESH_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  const detailRows = createMemo<QuotaWindowRow[]>(() => {
    const current = detail();
    if (!current) return [];
    return current.accounts.map((account) => ({ account, outcome: current.quotaByAccount.get(account.id) ?? null }));
  });
  const detailTelemetry = createMemo(() => detail()?.telemetry ?? selected()?.telemetry ?? null);
  const detailAggregate = createMemo(() =>
    aggregateQuota(detailRows().flatMap((row) => (row.outcome ? [row.outcome] : []))),
  );
  const detailAccounts = createMemo(() => detail()?.accounts ?? selected()?.accounts ?? []);
  const enabledDetailAccounts = createMemo(() => detailAccounts().filter((account) => account.enabled).length);
  const detailMetrics = createMemo(() => {
    const telemetry = detailTelemetry();
    return {
      successRateLabel: telemetry?.successRatePercent !== null && telemetry?.successRatePercent !== undefined ? `${telemetry.successRatePercent.toFixed(1)}%` : "—",
      successRateTone:
        telemetry === null || telemetry.successRatePercent === null
          ? ("neutral" as const)
          : telemetry.successRatePercent >= 99
            ? ("success" as const)
            : telemetry.successRatePercent >= 95
              ? ("warning" as const)
              : ("danger" as const),
      successRateDescription: telemetry
        ? `${formatNumber(telemetry.requests)} requests · ${formatNumber(telemetry.errors)} errors`
        : "Telemetry unavailable",
      latencyLabel: telemetry?.avgLatencyMs !== null && telemetry?.avgLatencyMs !== undefined ? formatDuration(telemetry.avgLatencyMs) : "—",
      latencyTone: (telemetry?.avgLatencyMs !== null && telemetry?.avgLatencyMs !== undefined ? "info" : "neutral") as "info" | "neutral",
    };
  });
  const detailQuotaView = createMemo(() => {
    const aggregate = detailAggregate();
    if (aggregate === null || aggregate.windows === 0) {
      return { remainingLabel: "—", tone: "neutral" as const, description: "No quota windows exposed" };
    }
    return {
      remainingLabel: formatQuotaPercent(aggregate.remainingPercent),
      tone: quotaUsageTone(aggregate.usedPercent),
      description: `${formatNumber(aggregate.remaining)} of ${formatNumber(aggregate.limit)} left · ${aggregate.windows} window${aggregate.windows === 1 ? "" : "s"}`,
    };
  });

  const providerColumns: VirtualTableColumn<ProviderRow>[] = [
    {
      key: "name",
      label: "Provider",
      render: (row) => (
        <button
          type="button"
          onClick={() => setSelected(row)}
          class="flex max-w-[260px] flex-col items-start rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label={`View details for ${row.entry.name}`}
        >
          <span class="truncate text-[12px] font-semibold text-[var(--text-1)]">{row.entry.name}</span>
          <span class="truncate font-mono text-[10px] text-[var(--text-3)]">{row.entry.id}</span>
        </button>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "220px",
      render: (row) => (
        <div class="space-y-1">
          <StatusBadge
            status={row.state.status}
            label={row.state.status === "active" ? "Active" : row.state.status === "degraded" ? "Degraded" : "Down"}
          />
          <Show when={row.state.status === "down" && row.state.lastError}>
            {(message) => (
              <p class="flex items-center gap-1 text-[10px] text-[var(--status-danger)]" role="alert" title={message()}>
                <CircleAlert size={11} aria-hidden="true" />
                <span class="truncate">{message()}</span>
              </p>
            )}
          </Show>
          <Show when={row.state.status !== "down" && row.state.reason}>
            {(reason) => (
              <p class="truncate text-[10px] text-[var(--text-3)]" title={reason()}>
                {reason()}
              </p>
            )}
          </Show>
        </div>
      ),
    },
    {
      key: "accounts",
      label: "Accounts",
      align: "right",
      render: (row) => (
        <span class="tabular-nums" title={`${row.accounts.filter((account) => account.enabled).length} of ${row.accounts.length} enabled`}>
          {row.accounts.filter((account) => account.enabled).length}/{row.accounts.length}
        </span>
      ),
    },
    { key: "quota", label: "Quota used", width: "150px", render: (row) => <QuotaCell aggregate={row.quota} probed={row.quotaProbed} /> },
    {
      key: "latency",
      label: "Avg latency",
      align: "right",
      render: (row) => (
        <span
          class="tabular-nums"
          title={row.telemetry ? "24h upstream telemetry" : "Upstream telemetry unavailable on this API"}
        >
          {row.telemetry?.avgLatencyMs !== null && row.telemetry?.avgLatencyMs !== undefined
            ? formatDuration(row.telemetry.avgLatencyMs)
            : "—"}
        </span>
      ),
    },
    {
      key: "success",
      label: "Success rate",
      align: "right",
      render: (row) => (
        <span class="tabular-nums" title={row.telemetry ? `${formatNumber(row.telemetry.errors)} errors in 24h` : "Upstream telemetry unavailable on this API"}>
          {row.telemetry?.successRatePercent !== null && row.telemetry?.successRatePercent !== undefined
            ? `${row.telemetry.successRatePercent.toFixed(1)}%`
            : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (row) => (
        <Button size="sm" variant="secondary" onClick={() => setSelected(row)} aria-label={`Open ${row.entry.name} details`}>
          Details
        </Button>
      ),
    },
  ];

  const quotaWindowColumns: VirtualTableColumn<QuotaWindowRow>[] = [
    {
      key: "account",
      label: "Account",
      render: (row) => (
        <div class="max-w-[220px]">
          <div class="truncate text-[12px] font-semibold text-[var(--text-1)]">{row.account.label}</div>
          <div class="truncate text-[10px] text-[var(--text-3)]">{row.account.email ?? row.account.id}</div>
        </div>
      ),
    },
    { key: "remaining", label: "Remaining", width: "180px", render: (row) => <QuotaOutcomeCell outcome={row.outcome} /> },
    {
      key: "used",
      label: "Used",
      align: "right",
      render: (row) => (
        <span class="tabular-nums">
          {row.outcome !== null && row.outcome.kind === "ready" ? formatQuotaPercent(row.outcome.window.usedPercent) : "—"}
        </span>
      ),
    },
    {
      key: "reset",
      label: "Resets",
      render: (row) => (
        <span
          class="tabular-nums"
          title={row.outcome !== null && row.outcome.kind === "ready" && row.outcome.window.resetsAt
            ? formatTime(row.outcome.window.resetsAt)
            : undefined}
        >
          {row.outcome !== null && row.outcome.kind === "ready" ? formatQuotaCountdown(row.outcome.window.resetsAt) : "—"}
        </span>
      ),
    },
    {
      key: "checked",
      label: "Last checked",
      render: (row) =>
        row.outcome !== null && row.outcome.kind === "ready" && row.outcome.window.lastChecked ? (
          <span class="tabular-nums">{formatTime(row.outcome.window.lastChecked)}</span>
        ) : (
          <span class="text-[var(--text-3)]">—</span>
        ),
    },
  ];

  const endpointColumns: VirtualTableColumn<AccountRecord>[] = [
    {
      key: "account",
      label: "Account",
      render: (account) => (
        <div class="max-w-[220px]">
          <div class="truncate text-[12px] font-semibold text-[var(--text-1)]">{account.label}</div>
          <div class="truncate text-[10px] text-[var(--text-3)]">{account.email ?? account.id}</div>
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "200px",
      render: (account) => {
        const view = accountStatusView(account);
        return (
          <div class="space-y-0.5">
            <StatusBadge status={view.status} label={view.label} />
            <Show when={view.detail}>
              {(detailMessage) => (
                <p class="truncate text-[10px] text-[var(--text-3)]" title={detailMessage()}>
                  {detailMessage()}
                </p>
              )}
            </Show>
          </div>
        );
      },
    },
    {
      key: "credential",
      label: "Credential state",
      render: (account) =>
        account.reauthRequired ? (
          <Badge tone="warn">Re-authentication required</Badge>
        ) : account.enabled ? (
          <Badge tone="ok">Valid</Badge>
        ) : (
          <Badge tone="neutral">Inactive</Badge>
        ),
    },
  ];

  const listSection = (
    <>
      <section aria-label="Fleet summary">
        <Show
          when={!initialLoading()}
          fallback={
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCardSkeleton label="Providers" />
              <MetricCardSkeleton label="Active providers" />
              <MetricCardSkeleton label="Needs attention" />
              <MetricCardSkeleton label="Quota tracked" />
            </div>
          }
        >
          <div class="grid animate-fade-in grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Providers" value={formatNumber(rows().length)} icon={Server} tone="accent" description="Registered in the catalog" />
            <MetricCard label="Active" value={formatNumber(statusCounts().active)} icon={CheckCircle2} tone="success" description="Routing normally" />
            <MetricCard
              label="Needs attention"
              value={formatNumber(statusCounts().degraded + statusCounts().down)}
              icon={TriangleAlert}
              tone={statusCounts().degraded + statusCounts().down > 0 ? "warning" : "success"}
              description="Degraded or down"
            />
            <MetricCard label="Quota tracked" value={formatNumber(quotaTracked())} icon={Gauge} tone="info" description="Providers with quota windows" />
          </div>
        </Show>
        <Show when={telemetryUnavailable()}>
          <p role="note" class="mt-2 text-[11px] text-[var(--text-3)]">
            Upstream telemetry is unavailable on this API — latency and success rate stay hidden until the telemetry service responds.
          </p>
        </Show>
        <Show when={accountsUnavailable()}>
          <p role="note" class="mt-2 text-[11px] text-[var(--status-warning)]">
            Account listing is unavailable — statuses reflect catalog state only.
          </p>
        </Show>
      </section>

      <Show
        when={!errorInfo()}
        fallback={
          <Show when={errorInfo()}>
            {(info) => (
              <StatePanel
                kind={info().degraded ? "degraded" : "error"}
                title={info().degraded ? "Provider catalog degraded" : "Failed to load providers"}
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
          title="All providers"
          subtitle={`${rows().length} provider${rows().length === 1 ? "" : "s"} · sorted by health`}
          icon={Server}
          iconColor="#0a84ff"
          items={rows()}
          columns={providerColumns}
          rowKey={(row) => row.entry.id}
          pageSize={visibleProviders()}
          onLoadMore={() => setVisibleProviders((count) => count + PAGE_STEP)}
          hasMore={visibleProviders() < rows().length}
          loading={initialLoading()}
          emptyMessage="No providers are registered in the API catalog."
          ariaLabel="Providers sorted by health"
        />
      </Show>
    </>
  );

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Providers</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">
            Provider fleet status, quota usage, latency, and success rate. Auto-refreshes every 60 seconds.
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

      <Show when={selected()} fallback={listSection}>
        {(active) => (
          <section class="space-y-4" aria-label={`Details for ${active().entry.name}`}>
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)} aria-label="Back to provider list">
                <ArrowLeft size={13} aria-hidden="true" /> Back
              </Button>
              <h3 class="text-lg font-bold text-[var(--text-1)]">{active().entry.name}</h3>
              <code class="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--accent)]">
                {active().entry.id}
              </code>
              <StatusBadge
                status={active().state.status}
                label={active().state.status === "active" ? "Active" : active().state.status === "degraded" ? "Degraded" : "Down"}
              />
              <Show when={active().state.reason}>
                {(reason) => (
                  <p class="text-xs text-[var(--text-3)]" title={reason()}>
                    {reason()}
                  </p>
                )}
              </Show>
            </div>

            <Show
              when={!detailResource.error}
              fallback={
                <StatePanel
                  kind="error"
                  title="Failed to load provider detail"
                  description={`${consoleFailure(detailResource.error)?.message ?? "unknown error"} (${consoleFailure(detailResource.error)?.code ?? "unknown"})`}
                  action={
                    <Button variant="secondary" onClick={() => void refetchDetail()}>
                      Retry
                    </Button>
                  }
                />
              }
            >
              <Show
                when={detailResource.loading && detail() === null}
                fallback={
                  <>
                    <section aria-label="Provider metrics" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <MetricCard
                        label="Success rate (24h)"
                        value={detailMetrics().successRateLabel}
                        icon={Gauge}
                        tone={detailMetrics().successRateTone}
                        description={detailMetrics().successRateDescription}
                      />
                      <MetricCard
                        label="Avg latency"
                        value={detailMetrics().latencyLabel}
                        icon={Timer}
                        tone={detailMetrics().latencyTone}
                        description="24h request-weighted upstream average"
                      />
                      <MetricCard
                        label="Active accounts"
                        value={`${enabledDetailAccounts()}/${detailAccounts().length}`}
                        icon={Users}
                        tone={enabledDetailAccounts() > 0 ? "success" : "danger"}
                        description="Enabled provider accounts"
                      />
                      <MetricCard
                        label="Quota remaining"
                        value={detailQuotaView().remainingLabel}
                        icon={Layers}
                        tone={detailQuotaView().tone}
                        description={detailQuotaView().description}
                      />
                    </section>

                    <Card density="compact">
                      <CardHeader title="Endpoint status" icon={Server} iconColor="#0a84ff" sub="Catalog registration and account readiness" />
                      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        <FactRow label="Enabled" value={active().entry.enabled ? "Yes" : "No"} />
                        <FactRow label="Configured" value={active().entry.configured ? "Yes" : "No"} />
                        <FactRow label="Protocols" value={active().entry.protocols.length > 0 ? active().entry.protocols.join(", ") : "—"} />
                        <FactRow label="Credential kinds" value={active().entry.credentialKinds.join(", ")} />
                        <FactRow label="Models" value={`${active().entry.enabledModelCount}/${active().entry.modelCount} enabled`} />
                        <FactRow label="Accounts" value={`${enabledDetailAccounts()} of ${detailAccounts().length} active`} />
                      </div>
                    </Card>

                    <VirtualTable
                      title="Quota windows"
                      subtitle={`${detailRows().length} account snapshot${detailRows().length === 1 ? "" : "s"} · remaining, used, and reset time`}
                      icon={Gauge}
                      iconColor="#bf5af2"
                      items={detailRows()}
                      columns={quotaWindowColumns}
                      rowKey={(row) => row.account.id}
                      pageSize={visibleWindows()}
                      onLoadMore={() => setVisibleWindows((count) => count + PAGE_STEP)}
                      hasMore={visibleWindows() < detailRows().length}
                      emptyMessage="This provider has no accounts to report quota for."
                      ariaLabel="Account quota windows"
                    />

                    <VirtualTable
                      title="Endpoint accounts"
                      subtitle={`${detailAccounts().length} account${detailAccounts().length === 1 ? "" : "s"} on this provider`}
                      icon={Users}
                      iconColor="#30d158"
                      items={detailAccounts()}
                      columns={endpointColumns}
                      rowKey={(account) => account.id}
                      pageSize={visibleEndpoints()}
                      onLoadMore={() => setVisibleEndpoints((count) => count + PAGE_STEP)}
                      hasMore={visibleEndpoints() < detailAccounts().length}
                      emptyMessage="This provider has no accounts."
                      ariaLabel="Provider endpoint accounts"
                    />
                  </>
                }
              >
                <LoadingState variant="skeleton" rows={6} label={`Loading ${active().entry.name} detail`} />
              </Show>
            </Show>
          </section>
        )}
      </Show>
    </div>
  );
}

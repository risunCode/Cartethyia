import { CheckCircle2, Gauge, Server, TriangleAlert } from "lucide-solid";
import { Show, createMemo, createResource, onCleanup, onMount, type JSX } from "solid-js";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { consoleGet } from "@lib/console-api";
import { formatNumber } from "@lib/format";
import {
  PER_PROVIDER_PROBE_LIMIT,
  aggregateQuota,
  fetchAllAccounts,
  fetchProviderCatalog,
  isRecordValue,
  probeAccountQuotas,
  providerRequiresCredentials,
  toBoundedString,
  toFiniteNumber,
  type AccountRecord,
  type ProviderCatalogEntry,
  type QuotaAggregate,
  type QuotaProbeOutcome,
} from "@lib/quota-contracts";

/** Provider data refreshes every 60 seconds without a reload. */
const PROVIDERS_REFRESH_MS = 60_000;
const TELEMETRY_ROUTE = "/telemetry/upstream?period=24h&group_by=provider";
const TELEMETRY_PROVIDER_KEYS = ["provider", "provider_id", "providerId", "group"] as const;

type ProviderStatus = "active" | "degraded" | "down";

interface ProviderTelemetry {
  readonly requests: number;
  readonly errors: number;
  readonly successRatePercent: number | null;
  readonly avgLatencyMs: number | null;
}

interface ProviderState {
  readonly status: ProviderStatus;
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

/** Reads /telemetry/upstream and groups counts/errors/latency per provider. */
async function fetchProviderTelemetry(): Promise<Map<string, ProviderTelemetry> | null> {
  let payload: unknown;
  try {
    payload = await consoleGet<unknown>(TELEMETRY_ROUTE);
  } catch {
    return null;
  }
  if (!isRecordValue(payload)) return null;
  const groups = Array.isArray(payload["groups"]) ? payload["groups"] : Array.isArray(payload) ? payload : [];
  if (groups.length === 0) return null;

  const totals = new Map<string, { requests: number; errors: number; latencyWeight: number; latencySum: number }>();
  for (const raw of groups) {
    if (!isRecordValue(raw)) continue;
    const metadata = isRecordValue(raw["metadata"]) ? raw["metadata"] : {};
    let providerId: string | null = null;
    for (const key of TELEMETRY_PROVIDER_KEYS) {
      providerId = toBoundedString(metadata[key], 128);
      if (providerId) break;
    }
    if (!providerId) continue;
    const count = toFiniteNumber(raw["count"]) ?? 0;
    const errors = toFiniteNumber(raw["errors"]) ?? 0;
    const latencyMs = toFiniteNumber(raw["latencyMs"]);
    const current = totals.get(providerId) ?? { requests: 0, errors: 0, latencyWeight: 0, latencySum: 0 };
    current.requests += count;
    current.errors += errors;
    if (latencyMs !== null && count > 0) {
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
      successRatePercent: value.requests > 0 ? ((value.requests - value.errors) / value.requests) * 100 : null,
      avgLatencyMs: value.latencyWeight > 0 ? value.latencySum / value.latencyWeight : null,
    });
  }
  return byProvider;
}

function deriveProviderState(
  entry: ProviderCatalogEntry,
  accounts: readonly AccountRecord[],
  quotaErrorMessages: readonly string[],
): ProviderState {
  if (!entry.enabled) {
    return { status: "down", reason: "Provider is disabled", lastError: "The provider is disabled in the catalog." };
  }
  if (quotaErrorMessages.length > 0) {
    return { status: "degraded", reason: "Quota probe error", lastError: quotaErrorMessages[0] };
  }
  if (accounts.length === 0) {
    return providerRequiresCredentials(entry)
      ? { status: "degraded", reason: "No accounts connected", lastError: null }
      : { status: "active", reason: null, lastError: null };
  }
  const enabledAccounts = accounts.filter((account) => account.enabled);
  if (enabledAccounts.length === 0) {
    return { status: "degraded", reason: "All accounts inactive", lastError: null };
  }
  return { status: "active", reason: null, lastError: null };
}

async function fetchProvidersSnapshot(): Promise<ProvidersSnapshot> {
  let catalog: readonly ProviderCatalogEntry[] = [];
  let accounts: readonly AccountRecord[] = [];
  let accountsUnavailable = false;
  try {
    catalog = await fetchProviderCatalog();
  } catch {
    catalog = [];
  }
  try {
    accounts = await fetchAllAccounts();
  } catch {
    accounts = [];
    accountsUnavailable = true;
  }

  const targetsByProvider = new Map<string, readonly AccountRecord[]>();
  const quotaOutcomes = new Map<string, QuotaProbeOutcome>();
  const quotaErrorMessages: string[] = [];
  for (const entry of catalog) {
    const providerAccounts = accounts.filter((account) => account.providerId === entry.id);
    const targets = providerAccounts.slice(0, PER_PROVIDER_PROBE_LIMIT);
    if (targets.length === 0) continue;
    const outcomes = await probeAccountQuotas(targets, targets.length);
    targetsByProvider.set(entry.id, targets);
    for (const [accountId, outcome] of outcomes) {
      quotaOutcomes.set(accountId, outcome);
      if (outcome.kind === "error") quotaErrorMessages.push(outcome.message);
    }
  }

  const telemetry = await fetchProviderTelemetry();

  const rows: ProviderRow[] = catalog.map((entry) => {
    const providerAccounts = accounts.filter((account) => account.providerId === entry.id);
    const outcomes = (targetsByProvider.get(entry.id) ?? [])
      .map((account) => quotaOutcomes.get(account.id))
      .filter((outcome): outcome is QuotaProbeOutcome => outcome !== undefined);
    return {
      entry,
      accounts: providerAccounts,
      state: deriveProviderState(entry, providerAccounts, quotaErrorMessages),
      quota: aggregateQuota(outcomes),
      quotaProbed: outcomes.length > 0,
      telemetry: telemetry?.get(entry.id) ?? null,
    };
  });

  return { rows, fetchedAt: new Date().toISOString(), telemetryAvailable: telemetry !== null, accountsUnavailable };
}

/**
 * Providers page — fleet status summary. Auto-refreshes every 60 seconds.
 * The four KPI tiles are the single source of truth; no provider list / drill-down.
 */
export default function Providers(): JSX.Element {
  const [resource, { refetch }] = createResource(fetchProvidersSnapshot);

  onMount(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      void refetch();
    }, PROVIDERS_REFRESH_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  const snapshot = createMemo<ProvidersSnapshot | null>(() => (resource.error ? null : resource() ?? null));
  const rows = createMemo<readonly ProviderRow[]>(() => snapshot()?.rows ?? []);
  const initialLoading = createMemo(() => resource.loading && snapshot() === null);
  const statusCounts = createMemo(() => {
    const counts = { active: 0, degraded: 0, down: 0 };
    for (const row of rows()) counts[row.state.status] += 1;
    return counts;
  });
  const quotaTracked = createMemo(() => rows().filter((row) => row.quotaProbed).length);
  const telemetryUnavailable = createMemo(() => (snapshot() ? !snapshot()?.telemetryAvailable : false));
  const accountsUnavailable = createMemo(() => snapshot()?.accountsUnavailable ?? false);

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Providers</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">
            Provider fleet status. Auto-refreshes every 60 seconds.
          </p>
        </div>
      </header>

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
          <div class="grid animate-fade-in grid-cols-2 gap-3 card-stagger lg:grid-cols-4">
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
    </div>
  );
}

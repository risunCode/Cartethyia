import { useMemo, useEffect, useRef, useState, type ReactNode } from "react";
import { EyeOff, Gauge } from "lucide-react";
import { Switch } from "../../../components/ui/switch";
import { useRoutingStrategy } from "../../../hooks/routing-strategy";
import { useQuotaOverview } from "../../../hooks/quota";
import { useProviderAccountInflight } from "../../../hooks/routing";
import { useMysteriousAccounts } from "../../../lib/privacy-mode";
/**
 * The provider-wide usage floor, shown above the account list.
 *
 * An account whose remaining allowance is at or below the floor is skipped at
 * routing time and the request fails over to the next account, so the caller
 * never sees an error for a spent account. Credit mode sums the account's
 * remaining credit; percent mode uses its aggregate credit percentage and
 * lowest independent percentage-only window.
 */
export function UsageFloorControl({ providerId }: { readonly providerId: string }): ReactNode {
  const routing = useRoutingStrategy(providerId, false);
  const quota = useQuotaOverview();
  const inflight = useProviderAccountInflight(providerId);
  const allowance = useMemo(() => combinedAllowance(quota.data?.accounts ?? [], providerId), [quota.data, providerId]);
  const seenInflight = useRef<number | null>(null);
  const inflightTotal = useMemo(
    () => [...(inflight.data?.values() ?? [])].reduce((sum, count) => sum + count, 0),
    [inflight.data],
  );
  useEffect(() => {
    if (seenInflight.current === null) {
      seenInflight.current = inflightTotal;
      return;
    }
    if (seenInflight.current === inflightTotal) return;
    seenInflight.current = inflightTotal;
    void quota.refetch();
  }, [inflightTotal, quota]);
  const [value, setValue] = useState("40");
  const [unit, setUnit] = useState<"credit" | "percent">("percent");
  const enabled = routing.usageFloor !== null;

  useEffect(() => {
    if (routing.usageFloor !== null) setValue(String(routing.usageFloor));
    setUnit(routing.usageFloorUnit);
  }, [routing.usageFloor, routing.usageFloorUnit]);

  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000;

  const commit = (next: number | null, nextUnit: "credit" | "percent") => {
    if (next !== null && !valid) return;
    routing.setUsageFloor(next, nextUnit);
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-5 px-6 py-5 border border-inner-border rounded-control bg-surface-2">
        <div>
          <div className="flex items-center gap-3 text-body font-semibold text-text-primary">
            <Gauge size={14} />
            <span>Usage floor</span>
            <span className="badge text-micro tracking-label">BETA</span>
          </div>
          <p className="mt-0.5 text-badge leading-normal text-text-tertiary">
            Per account. Skip an account once its remaining allowance reaches this, and send the request to the next one.
          </p>
        </div>
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          {allowance !== null && (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro font-semibold tracking-label uppercase text-text-tertiary">
                <span>Active accounts</span>
                <strong className="text-text-secondary">{allowance.accounts}</strong>
                <span className="ml-2">Total quota</span>
              </div>
              <div
                className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption font-semibold tabular-nums text-text-primary"
                title="Combined allowance across active accounts; the usage floor is evaluated per account"
              >
                <strong className="font-bold">{formatCount(allowance.remaining)} credits available</strong>
                <span className="font-medium opacity-75">of {formatCount(allowance.total)}</span>
                <span className="font-medium opacity-75">({allowance.percent}%)</span>
              </div>
            </div>
          )}
          <div className="flex flex-col items-start gap-2 self-end md:ml-auto md:items-end">
            <div className="flex items-center gap-4">
              <label className="flex items-center h-16 border border-inner-border rounded-control bg-surface-1 overflow-hidden">
                <input
                  type="number"
                  min={0}
                  max={1_000_000}
                  value={enabled ? value : ""}
                  placeholder="40"
                  disabled={!enabled}
                  aria-label="Usage floor amount"
                  className="w-32 h-full px-4 border-0 bg-transparent text-text-primary font-mono text-body tabular-nums text-right disabled:text-text-tertiary"
                  onChange={(event) => setValue(event.target.value)}
                  onBlur={() => {
                    if (enabled) commit(parsed, unit);
                  }}
                />
                <select
                  value={unit}
                  disabled={!enabled}
                  aria-label="Usage floor unit"
                  className="h-full px-3 border-0 border-l border-inner-border bg-hover text-text-secondary text-badge font-semibold cursor-pointer disabled:cursor-default disabled:opacity-60"
                  onChange={(event) => {
                    const next = event.target.value === "credit" ? "credit" : "percent";
                    setUnit(next);
                    if (enabled) commit(parsed, next);
                  }}
                >
                  <option value="percent">%</option>
                  <option value="credit">credits</option>
                </select>
              </label>
              <Switch
                checked={enabled}
                aria-label="Usage floor"
                onChange={(next) => commit(next ? (valid ? parsed : 40) : null, unit)}
              />
            </div>
            <p className="text-micro leading-normal text-text-tertiary">
              {routing.usageFloor !== null
                ? `Floor ${formatCount(routing.usageFloor)} ${routing.usageFloorUnit === "credit" ? "credits" : "%"} per account`
                : "Floor off · exhausted quota windows are still skipped"}
            </p>
            {routing.saveFailed ? (
              <p role="alert" className="text-micro leading-normal text-red">
                Usage floor save failed. The last saved setting has been restored.
              </p>
            ) : null}
          </div>
        </div>
      </section>
      <PrivacyModeControl providerId={providerId} />
    </div>
  );
}

/** Hides this provider's account emails. Other providers keep their own choice. */
function PrivacyModeControl({ providerId }: { readonly providerId: string }): ReactNode {
  const { enabled, setEnabled } = useMysteriousAccounts(providerId);
  return (
    <div className="flex items-center justify-between flex-wrap gap-6 px-6 py-5 border border-inner-border rounded-control bg-surface-2">
      <div className="min-w-0 flex-auto basis-110">
        <div className="flex items-center gap-3 text-body font-semibold text-text-primary">
          <EyeOff size={14} />
          <span>Mysterious accounts</span>
        </div>
        <p className="mt-0.5 text-badge leading-normal text-text-tertiary">Hide this provider's emails and usernames. Stored in this browser only.</p>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <Switch checked={enabled} aria-label="Mysterious accounts" onChange={setEnabled} />
      </div>
    </div>
  );
}

/**
 * Sums remaining and limit across active accounts only; disabled credentials
 * cannot serve requests and should not inflate the routable balance summary.
 */
function combinedAllowance(
  accounts: readonly { readonly provider: string; readonly active: boolean; readonly quota: { readonly windows: readonly { readonly accounting?: "pooled" | "independent"; readonly kind?: string; readonly limit?: number | null; readonly remaining?: number | null; readonly used?: number | null }[] } | null }[],
  providerId: string,
): { readonly accounts: number; readonly remaining: number; readonly total: number; readonly percent: number } | null {
  let remaining = 0;
  let total = 0;
  let activeAccounts = 0;
  let hasQuota = false;
  for (const account of accounts) {
    if (account.provider !== providerId || !account.active) continue;
    activeAccounts += 1;
    if (account.quota === null) continue;
    for (const window of account.quota.windows) {
      if (!isPooledWindow(account.provider, window)) continue;
      const limit = typeof window.limit === "number" && Number.isFinite(window.limit) ? window.limit : null;
      if (limit === null) continue;
      const left =
        typeof window.remaining === "number" && Number.isFinite(window.remaining)
          ? window.remaining
          : typeof window.used === "number" && Number.isFinite(window.used)
            ? limit - window.used
            : null;
      if (left === null) continue;
      remaining += Math.min(limit, Math.max(0, left));
      total += limit;
      hasQuota = true;
    }
  }
  return activeAccounts > 0 && hasQuota
    ? { accounts: activeAccounts, remaining, total, percent: total > 0 ? Math.round((remaining / total) * 100) : 0 }
    : null;
}

function isPooledWindow(
  providerId: string,
  window: { readonly accounting?: "pooled" | "independent"; readonly kind?: string },
): boolean {
  if (window.accounting !== undefined) return window.accounting === "pooled";
  const isBuddyProvider = providerId === "cb" || providerId === "cbcn" || providerId === "workbuddy";
  return isBuddyProvider && (window.kind?.startsWith("quota:") === true || window.kind?.startsWith("bonus:") === true);
}

function formatCount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

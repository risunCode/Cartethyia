import { useMemo, useEffect, useRef, useState, type ReactNode } from "react";
import { EyeOff, Gauge } from "lucide-react";
import { Switch } from "../../../components/ui/switch";
import { useRoutingStrategy } from "../../../hooks/use-routing-strategy";
import { useQuotaOverview } from "../../../hooks/quota";
import { useProviderAccountInflight } from "../../../hooks/routing";
import { usePrivacyMode } from "../../../lib/privacy-mode";
/**
 * The provider-wide usage floor, shown above the account list.
 *
 * An account whose remaining allowance is at or below the floor is skipped at
 * routing time and the request fails over to the next account, so the caller
 * never sees an error for a spent account. Credit mode sums the account's
 * remaining credit; percent mode takes its lowest remaining percent.
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
    <div className="account-controls">
    <div className="usage-floor">
      <div className="usage-floor-copy">
        <div className="usage-floor-title">
          <Gauge size={14} />
          <span>Usage floor</span>
          <span className="badge">BETA</span>
        </div>
        <p>
          Per account. Skip an account once its remaining allowance reaches this, and send the request to the next one.
        </p>
        {allowance !== null && (
          <p className="usage-floor-total" data-tone={allowanceTone(allowance)} title={`${formatCount(allowance.remaining)} credits available of ${formatCount(allowance.total)} across all accounts`}>
            <span className="usage-floor-scope">All accounts</span>
            <strong>{formatCount(allowance.remaining)}</strong>
            {` credits available of ${formatCount(allowance.total)}`}
            <span className="usage-floor-percent">{` (${allowance.percent}%)`}</span>
          </p>
        )}
      </div>
      <div className="usage-floor-control">
        <Switch
          checked={enabled}
          aria-label="Usage floor"
          onChange={(next) => commit(next ? (valid ? parsed : 40) : null, unit)}
        />
        <label className="usage-floor-value">
          <input
            type="number"
            min={0}
            max={1_000_000}
            value={enabled ? value : ""}
            placeholder="40"
            disabled={!enabled}
            aria-label="Usage floor amount"
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => {
              if (enabled) commit(parsed, unit);
            }}
          />
          <select
            value={unit}
            disabled={!enabled}
            aria-label="Usage floor unit"
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
      </div>
    </div>
    <PrivacyModeControl />
    </div>
  );
}

/** Hides account emails and proxy addresses behind one label. */
function PrivacyModeControl(): ReactNode {
  const { enabled, setEnabled } = usePrivacyMode();
  return (
    <div className="usage-floor">
      <div className="usage-floor-copy">
        <div className="usage-floor-title">
          <EyeOff size={14} />
          <span>Privacy mode</span>
        </div>
        <p>Hide email or username. Accounts and proxies read as mysterious.</p>
      </div>
      <div className="usage-floor-control">
        <Switch checked={enabled} aria-label="Privacy mode" onChange={setEnabled} />
      </div>
    </div>
  );
}

/**
 * Sums remaining and limit across every account of this provider, so the floor
 * area shows the pool's combined allowance rather than one account's.
 */
function combinedAllowance(
  accounts: readonly { readonly provider: string; readonly quota: { readonly windows: readonly { readonly limit?: number | null; readonly remaining?: number | null; readonly used?: number | null }[] } | null }[],
  providerId: string,
): { readonly remaining: number; readonly total: number; readonly percent: number } | null {
  let remaining = 0;
  let total = 0;
  let counted = false;
  for (const account of accounts) {
    if (account.provider !== providerId || account.quota === null) continue;
    for (const window of account.quota.windows) {
      const limit = typeof window.limit === "number" && Number.isFinite(window.limit) ? window.limit : null;
      if (limit === null) continue;
      const left =
        typeof window.remaining === "number" && Number.isFinite(window.remaining)
          ? window.remaining
          : typeof window.used === "number" && Number.isFinite(window.used)
            ? limit - window.used
            : null;
      if (left === null) continue;
      remaining += Math.max(0, left);
      total += limit;
      counted = true;
    }
  }
  return counted ? { remaining, total, percent: total > 0 ? Math.round((remaining / total) * 100) : 0 } : null;
}

function formatCount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Green while the pool is healthy, amber under a third, red once it is nearly spent. */
function allowanceTone(allowance: { readonly percent: number }): "ok" | "warn" | "err" {
  if (allowance.percent <= 10) return "err";
  if (allowance.percent < 34) return "warn";
  return "ok";
}

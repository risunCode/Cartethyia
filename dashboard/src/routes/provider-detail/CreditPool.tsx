import type { ReactNode } from "react";
import { useQuotaOverview, type QuotaEntry } from "../../hooks/quota";
import { useRoutingStrategy } from "../../hooks/use-routing-strategy";
import { Switch } from "../../components/ui/switch";
import { Inline } from "../../components/ui/inline";
import { formatCredits } from "../../shared/format";

export interface CreditPoolTotals {
  /** Credits spent across every account's windows. */
  readonly used: number;
  /** Credits the provider granted across every account's windows. */
  readonly limit: number;
  /** Accounts that actually reported a credit window — the honest denominator. */
  readonly accounts: number;
}

/**
 * Sums one provider's absolute credit windows into a single pool.
 *
 * Only windows with a positive absolute `limit` and an absolute `used` or
 * `remaining` value contribute. Percent windows are left out here — they feed
 * `lowestRemainingPercent` instead, and the floor compares in whichever unit
 * each account reported.
 */
export function aggregateCreditPool(entries: readonly QuotaEntry[]): CreditPoolTotals | null {
  let used = 0;
  let limit = 0;
  const contributors = new Set<string>();
  for (const entry of entries) {
    let contributed = false;
    for (const window of entry.quota?.windows ?? []) {
      const windowLimit =
        typeof window.limit === "number" && Number.isFinite(window.limit) && window.limit > 0
          ? window.limit
          : null;
      if (windowLimit === null) continue;
      let windowUsed: number | null = null;
      if (typeof window.used === "number" && Number.isFinite(window.used)) {
        windowUsed = window.used;
      } else if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
        windowUsed = windowLimit - window.remaining;
      }
      if (windowUsed === null) continue;
      limit += windowLimit;
      used += Math.min(windowLimit, Math.max(0, windowUsed));
      contributed = true;
    }
    if (contributed) contributors.add(entry.id);
  }
  if (limit <= 0) return null;
  return { used, limit, accounts: contributors.size };
}

export interface PercentQuotaSummary {
  /** Lowest remaining percent across every account's percent windows. */
  readonly minRemaining: number;
  /** Accounts that actually reported a percent window. */
  readonly accounts: number;
}

/**
 * Percent twin of `aggregateCreditPool`: the most exhausted quota percent is
 * what decides routing, so the card shows the minimum remaining — the figure
 * the floor compares against.
 */
export function lowestRemainingPercent(entries: readonly QuotaEntry[]): PercentQuotaSummary | null {
  let min: number | null = null;
  const contributors = new Set<string>();
  for (const entry of entries) {
    for (const window of entry.quota?.windows ?? []) {
      const value =
        typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)
          ? Math.min(100, Math.max(0, window.remainingPercent))
          : null;
      if (value === null) continue;
      min = min === null ? value : Math.min(min, value);
      contributors.add(entry.id);
    }
  }
  if (min === null) return null;
  return { minRemaining: min, accounts: contributors.size };
}

/**
 * The provider's total balance: every account's credit windows summed into one
 * pool, or the lowest remaining quota percent when the provider reports
 * percent windows instead of absolute credits. Shown as a simple
 * available-versus-total summary — one card, no credit/quota split.
 *
 * Sits above the account list so the operator reads "how much is left" before
 * "which account", which is the order the question is asked. Renders nothing
 * for a provider whose accounts report neither credits nor percents.
 */
export function CreditPoolCard({
  providerId,
  accountCount,
}: {
  readonly providerId: string;
  readonly accountCount: number;
}): ReactNode {
  const overview = useQuotaOverview();
  const routing = useRoutingStrategy(providerId, false);
  const entries = (overview.data?.accounts ?? []).filter((entry) => entry.provider === providerId);
  const pool = aggregateCreditPool(entries);
  const percent = pool === null ? lowestRemainingPercent(entries) : null;

  const usedPercent = pool ? Math.min(100, Math.max(0, (pool.used / pool.limit) * 100)) : 0;
  const remaining = pool ? Math.max(0, pool.limit - pool.used) : 0;
  const accountsLabel = `${accountCount} ${accountCount === 1 ? "account" : "accounts"}`;
  const hasBalance = pool !== null || percent !== null;

  return (
    <div
      style={{
        padding: "14px 16px",
        borderRadius: "14px",
        border: "1px solid var(--inner-border)",
        background: "var(--glass-bg)",
      }}
    >
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.12em",
          color: "var(--text-secondary)",
        }}
      >
        TOTAL Credits or Quota
      </p>
      {pool ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: "12px",
              marginTop: "10px",
            }}
          >
            <span style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--status-success)",
                }}
              >
                {formatCredits(remaining)}
              </span>{" "}
              available of{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatCredits(pool.limit)}
              </span>{" "}
              total
            </span>
          </div>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: "10.5px",
              color: "var(--text-tertiary)",
            }}
          >
            {formatCredits(pool.used)} used ({Math.round(usedPercent)}%) across {pool.accounts}{" "}
            {pool.accounts === 1 ? "account" : "accounts"}
          </p>
        </>
      ) : percent ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: "12px",
              marginTop: "10px",
            }}
          >
            <span style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--status-success)",
                }}
              >
                {Math.round(percent.minRemaining)}%
              </span>{" "}
              remaining at the lowest account
            </span>
          </div>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: "10.5px",
              color: "var(--text-tertiary)",
            }}
          >
            Lowest remaining quota across {percent.accounts}{" "}
            {percent.accounts === 1 ? "account" : "accounts"} — the figure the
            minimum balance compares against
          </p>
        </>
      ) : null}

      {routing.isLoading || routing.isError ? null : (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
            marginTop: hasBalance ? "12px" : "10px",
            paddingTop: hasBalance ? "12px" : 0,
            borderTop: hasBalance ? "1px solid var(--inner-border)" : undefined,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <label htmlFor="credit-limit-enabled" style={{ fontSize: "12.5px", fontWeight: 600 }}>
              Minimum balance
            </label>
            <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              Keep at least this much unused on every account — credits for
              credit providers, percent for quota providers. Accounts at or
              below it are skipped until the next quota sweep refills them.
              Opt-in per provider; off unless enabled. Applied globally to all{" "}
              {accountsLabel} in this provider.
            </div>
          </div>
          <Inline gap="10px" style={{ flexShrink: 0, alignItems: "center" }}>
            <Switch
              id="credit-limit-enabled"
              checked={routing.creditLimitEnabled}
              onChange={routing.setCreditLimitEnabled}
              aria-label="Enable the minimum balance"
            />
            <input
              type="number"
              aria-label="Minimum balance per account"
              min={0}
              max={1000000000}
              disabled={!routing.creditLimitEnabled}
              value={routing.creditLimit}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  routing.setCreditLimit(Math.max(0, Math.min(1000000000, Math.round(value))));
              }}
              className="form-input"
              style={{ width: "110px", padding: "6px 8px", textAlign: "right" }}
            />
          </Inline>
        </div>
      )}
    </div>
  );
}

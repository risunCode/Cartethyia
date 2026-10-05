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
 * `remaining` value contribute. A percentage is utilization, not a credit
 * balance, so percentage-only windows are left out of this card.
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

/**
 * The provider's total credits: every account's credit windows summed into one
 * pool and shown as a simple available-versus-total summary.
 *
 * Sits above the account list so the operator reads "how much is left" before
 * "which account", which is the order the question is asked. Renders nothing
 * for a provider whose accounts report no credit window.
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

  const usedPercent = pool ? Math.min(100, Math.max(0, (pool.used / pool.limit) * 100)) : 0;
  const remaining = pool ? Math.max(0, pool.limit - pool.used) : 0;
  const accountsLabel = `${accountCount} ${accountCount === 1 ? "account" : "accounts"}`;

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
        TOTAL CREDITS
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
              credits available of{" "}
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
      ) : null}

      {routing.isLoading || routing.isError ? null : (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
            marginTop: pool ? "12px" : "10px",
            paddingTop: pool ? "12px" : 0,
            borderTop: pool ? "1px solid var(--inner-border)" : undefined,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <label htmlFor="credit-limit-enabled" style={{ fontSize: "12.5px", fontWeight: 600 }}>
              Minimum balance
            </label>
            <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              Keep at least this many credits unused on every account. Accounts at or below this
              balance are skipped by routing. Applied globally to all {accountsLabel} in this
              provider.
            </div>
          </div>
          <Inline gap="10px" style={{ flexShrink: 0, alignItems: "center" }}>
            <Switch
              id="credit-limit-enabled"
              checked={routing.creditLimitEnabled}
              onChange={routing.setCreditLimitEnabled}
              aria-label="Enable the global credit limit"
            />
            <input
              type="number"
              aria-label="Credit limit per account"
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

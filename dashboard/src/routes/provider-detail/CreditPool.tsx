import type { ReactNode } from "react";
import { useQuotaOverview, type QuotaEntry } from "../../hooks/quota";
import { formatCredits } from "../../shared/format";
import { quotaBarTone } from "../../shared/quota-formatters";

export interface CreditPoolTotals {
  /** Credits spent across every account's windows. */
  readonly used: number;
  /** Credits the provider granted across every account's windows. */
  readonly limit: number;
  /** Accounts that actually reported a credit window — the honest denominator. */
  readonly accounts: number;
}

/**
 * Sums one provider's credit windows into a single pool.
 *
 * Only windows that report a positive `limit` can be summed: a window without
 * one is a rate limit or an unbounded bucket, and folding it in as zero would
 * quietly shrink the pool. `used` prefers the reported figure and falls back to
 * the percentage, so a provider that reports only one of the two still counts.
 * Returns null when nothing contributes, which is how a provider with no credit
 * system (RPM/TPM only) opts out of the card entirely.
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
      } else if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
        windowUsed = (windowLimit * window.usedPercent) / 100;
      } else if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
        windowUsed = windowLimit - window.remaining;
      }
      limit += windowLimit;
      used += Math.min(windowLimit, Math.max(0, windowUsed ?? 0));
      contributed = true;
    }
    if (contributed) contributors.add(entry.id);
  }
  if (limit <= 0) return null;
  return { used, limit, accounts: contributors.size };
}

/**
 * The provider's credit pool: every account's credits summed into one bar.
 *
 * Sits above the account list so the operator reads "how much is left" before
 * "which account", which is the order the question is asked. Renders nothing
 * for a provider whose accounts report no credit window.
 *
 * Every figure here names itself, and the bar agrees with the headline: the
 * fill is the remaining fraction and the headline reads "N credits available of
 * M total", so the green bar and the sentence beside it are the same quantity.
 * The spent figure moves to the caption rather than sharing the headline with
 * the remainder — a bare `450.81 / 3,000` under a label that says neither is
 * what made the card ambiguous. The quota page draws its bars the same way
 * (green = credit still available), so the pool and the account rows below it
 * read alike.
 */
export function CreditPoolCard({ providerId }: { readonly providerId: string }): ReactNode {
  const overview = useQuotaOverview();
  const entries = (overview.data?.accounts ?? []).filter((entry) => entry.provider === providerId);
  const pool = aggregateCreditPool(entries);
  if (!pool) return null;

  const usedPercent = Math.min(100, Math.max(0, (pool.used / pool.limit) * 100));
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const remaining = Math.max(0, pool.limit - pool.used);
  const tone = quotaBarTone(remainingPercent);

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
        CREDIT POOL
      </p>
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
              color: tone.text,
            }}
          >
            {formatCredits(remaining)}
          </span>{" "}
          credits available of{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCredits(pool.limit)}</span> total
        </span>
      </div>
      <div
        className="quota-bar-track"
        role="progressbar"
        aria-label="Credits remaining"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remainingPercent)}
        aria-valuetext={`${formatCredits(remaining)} of ${formatCredits(pool.limit)} credits remaining`}
        style={{
          marginTop: "8px",
          height: "10px",
          borderRadius: "4px",
          background: "var(--inner-border)",
          overflow: "hidden",
        }}
      >
        <div
          className="quota-bar-fill"
          style={{
            width: `${remainingPercent}%`,
            height: "100%",
            borderRadius: "3px",
            background: tone.bar,
            transition: "width var(--dur-macro) var(--ease-spring)",
          }}
        />
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
    </div>
  );
}

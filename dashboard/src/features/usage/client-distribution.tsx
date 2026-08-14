import { useId } from "react";
import { Card, CardHeader } from "../../components/ui/card";

export interface ClientDistributionItem {
  readonly family: string;
  readonly label: string;
  readonly count: number;
  readonly percentage: number;
  readonly tone: string;
  readonly source?: string | null;
  readonly confidence?: string | null;
}

interface ClientDistributionProps {
  readonly items: readonly ClientDistributionItem[];
  readonly total: number | null;
  readonly unknownCount: number | null;
  readonly isLoading?: boolean;
}

function boundedPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    Math.max(0, value),
  );
}

/**
 * Renders the daemon-provided client-family distribution without deriving
 * identity from raw browser headers. Unknown requests remain visible in the
 * denominator instead of being silently discarded.
 */
export function ClientDistribution({
  items,
  total,
  unknownCount,
  isLoading = false,
}: ClientDistributionProps) {
  const labelId = useId();
  const visibleItems = items.filter(
    (item) => item.count > 0 && boundedPercentage(item.percentage) > 0,
  );
  const safeTotal = total === null ? null : Math.max(0, total);
  const safeUnknown = unknownCount === null ? null : Math.max(0, unknownCount);

  const unknownDetails =
    safeUnknown === null
      ? "Unknown client total unavailable"
      : `Unknown: ${formatCount(safeUnknown)}`;
  return (
    <Card>
      <CardHeader
        title="Client distribution"
        sub="Bounded client-family metadata across canonical requests"
      />
      {isLoading ? (
        <div
          className="h-24 animate-pulse rounded-xl bg-[var(--surface-muted)]"
          aria-label="Loading client distribution"
        />
      ) : (
        <div className="space-y-4" aria-labelledby={labelId}>
          <span id={labelId} className="sr-only">
            Client distribution totals
          </span>
          {safeTotal === null ? (
            <p
              className="rounded-xl border border-dashed border-[var(--inner-border)] px-3 py-4 text-xs text-[var(--text-3)]"
              role="status"
            >
              Client distribution is unavailable from the daemon.
            </p>
          ) : (
            <>
              <div
                className="flex h-3 overflow-hidden rounded-full bg-[var(--surface-muted)]"
                role="img"
                aria-label={`${formatCount(safeTotal)} requests distributed across detected and unknown clients`}
              >
                {visibleItems.map((item) => (
                  <span
                    key={item.family}
                    className="min-w-0 transition-[width] duration-300"
                    style={{
                      width: `${boundedPercentage(item.percentage)}%`,
                      backgroundColor: item.tone,
                    }}
                    title={`${item.label}: ${formatCount(item.count)} (${boundedPercentage(item.percentage).toFixed(1)}%)${item.source ? ` · source ${item.source}` : ""}${item.confidence ? ` · confidence ${item.confidence}` : ""}`}
                  />
                ))}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((item) => (
                  <div
                    key={item.family}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--inner-border)] px-3 py-2 text-xs"
                    title={`${item.source ? `Source: ${item.source}` : "Source unavailable"} · ${item.confidence ? `Confidence: ${item.confidence}` : "Confidence unavailable"}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: item.tone }}
                        aria-hidden="true"
                      />
                      <span className="truncate text-[var(--text-1)]">
                        {item.label}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--text-2)]">
                      {formatCount(item.count)} ·{" "}
                      {boundedPercentage(item.percentage).toFixed(1)}%
                    </span>
                  </div>
                ))}
                <div
                  className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-dashed border-[var(--inner-border)] px-3 py-2 text-xs"
                  title={unknownDetails}
                >
                  <span className="text-[var(--text-2)]">Unknown</span>
                  <span className="shrink-0 tabular-nums text-[var(--text-2)]">
                    {safeUnknown === null ? "—" : formatCount(safeUnknown)}
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-[var(--text-3)]">
                Total requests: {formatCount(safeTotal)}. Percentages include
                unknown client origin.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

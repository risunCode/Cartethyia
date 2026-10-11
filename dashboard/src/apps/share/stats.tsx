import { ChevronRight, Scaling } from "lucide-react";
import { Card } from "../../components/ui/card";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useShareData, type ShareFamilyStatsData, type ShareLinkPolicyData } from "../../hooks/share-data";
import {
  RAW_TOKEN_SCALE,
  TOKEN_SCALES,
  TOKEN_SCALE_AUTO,
  tokenScaleValue,
} from "../../lib/format/tokens";

const STATS_TABLE_SCROLL_CLASS =
  "max-h-168 w-full min-w-0 overflow-x-auto overflow-y-auto touch-pan-x touch-pan-y [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-card [&_thead_th]:bg-surface-2";
const STATS_TABLE_CLASS =
  "w-full border-collapse text-caption [&_th]:border-b [&_th]:border-inner-border [&_th]:px-5 [&_th]:py-3 [&_th]:text-left [&_th]:font-mono [&_th]:text-micro [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-label [&_th]:text-text-tertiary [&_td]:border-b [&_td]:border-surface-muted [&_td]:px-5 [&_td]:py-4 [&_td]:text-text-secondary [&_tr:last-child_td]:border-b-0 [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap";

/**
 * Live stats subscription shared by every consumer on the page.
 *
 * The stream ticks every couple of seconds. Subscribing in the page component
 * itself would re-render the whole share page — key panel, model allowlist,
 * notes — on every tick, which is what made the page feel heavy on a phone.
 * Holding the subscription in a provider and passing children through keeps
 * that subtree referentially stable: a tick re-renders only the components
 * that actually read this context. One subscription, not one per consumer, so
 * the gateway sees a single stream per open page.
 *
 * The token unit lives here too, for the same reason: one reading governs every
 * token figure on the page (quota rows, KPI tile, both tables), and splitting it
 * per component would let the hero and the table disagree about the same number.
 * The reading defaults to the exact count — a share recipient checking a quota
 * wants the number, not a rounded `84K` — and `auto` is one click away for
 * anyone who would rather see the compact unit each figure lands on.
 */
const ShareStatsContext = createContext<{
  readonly data: ShareFamilyStatsData | null;
  readonly loading: boolean;
  /** `TOKEN_SCALE_AUTO`, a `TOKEN_SCALES` index, or `RAW_TOKEN_SCALE`. */
  readonly unit: number;
  readonly cycleUnit: () => void;
}>({ data: null, loading: true, unit: RAW_TOKEN_SCALE, cycleUnit: () => undefined });

/** The viewer's chosen token unit, remembered across reloads. */
const TOKEN_UNIT_STORAGE_KEY = "cartethyia:share-token-unit";

/**
 * Reads the remembered unit. Every failure path answers the default — the exact
 * count — because storage throws in a private window and a stale or hand-edited
 * value must not put the page into a unit it cannot render.
 */
function readStoredUnit(): number {
  try {
    const raw = window.localStorage.getItem(TOKEN_UNIT_STORAGE_KEY);
    if (raw === null) return RAW_TOKEN_SCALE;
    if (raw === "auto") return TOKEN_SCALE_AUTO;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= RAW_TOKEN_SCALE
      ? parsed
      : RAW_TOKEN_SCALE;
  } catch {
    return RAW_TOKEN_SCALE;
  }
}

/** The unit one click past `unit`: raw → auto → coarsest → … → K → raw. */
function nextTokenUnit(unit: number): number {
  if (unit === TOKEN_SCALE_AUTO) return 0;
  if (unit >= RAW_TOKEN_SCALE) return TOKEN_SCALE_AUTO;
  return unit + 1;
}

/** The switch's label: a compact suffix, `raw`, or the default-unit marker. */
function tokenUnitLabel(unit: number): string {
  if (unit === TOKEN_SCALE_AUTO) return "auto";
  if (unit >= RAW_TOKEN_SCALE) return "raw";
  return TOKEN_SCALES[unit]?.suffix ?? "auto";
}

export function ShareStatsProvider({
  path,
  children,
}: {
  readonly path: string;
  readonly children: ReactNode;
}): ReactElement {
  const state = useShareData<ShareFamilyStatsData>(path, { streamEvent: "stats" });
  const [unit, setUnit] = useState<number>(() =>
    typeof window === "undefined" ? RAW_TOKEN_SCALE : readStoredUnit(),
  );
  const cycleUnit = useCallback(() => {
    setUnit((current) => {
      const next = nextTokenUnit(current);
      try {
        window.localStorage.setItem(
          TOKEN_UNIT_STORAGE_KEY,
          next === TOKEN_SCALE_AUTO ? "auto" : String(next),
        );
      } catch {
        // A private window or a full quota: the unit still applies for this
        // view, it just is not remembered.
      }
      return next;
    });
  }, []);
  return (
    <ShareStatsContext.Provider value={{ data: state.data, loading: state.loading, unit, cycleUnit }}>
      {children}
    </ShareStatsContext.Provider>
  );
}

/**
 * The token-unit switch.
 *
 * One control, not one per figure: the reading a viewer picks is a property of
 * the page, and a recipient scanning the quota bar and the top-models table is
 * comparing the same tokens. The page opens on the exact count, matching what
 * the usage page does; the compact units are for lining figures up by eye, and
 * `auto` picks the unit each value lands on.
 */
function TokenUnitSwitch(): ReactElement {
  const { unit, cycleUnit } = useContext(ShareStatsContext);
  const current = tokenUnitLabel(unit);
  const next = tokenUnitLabel(nextTokenUnit(unit));
  return (
    <button
      type="button"
      className="ml-auto inline-flex min-h-6 items-center gap-1 rounded-full border border-inner-border bg-surface-2 px-2 text-text-secondary font-mono text-micro font-bold uppercase tracking-[0.04em] cursor-pointer hover:border-accent hover:text-text-primary"
      aria-label={`Token unit: currently ${current}, switch to ${next}`}
      title={`Show ${next}`}
      onClick={cycleUnit}
    >
      <Scaling size={11} aria-hidden="true" />
      {current}
    </button>
  );
}

/** Hero quota rows, kept live without re-rendering the page around them. */
export function LiveShareQuotaPanel({
  policy,
}: {
  readonly policy: ShareLinkPolicyData;
}): ReactElement {
  const { data } = useContext(ShareStatsContext);
  return <ShareQuotaPanel policy={policy} stats={data} />;
}

/** Collapsible activity section, same treatment as the quota rows above. */
export function LiveShareStatsSection(): ReactElement {
  const { data, loading } = useContext(ShareStatsContext);
  return <ShareStatsSection stats={data} loading={loading} />;
}

/** A token figure in the viewer's chosen unit. */
function useTokenFormat(): (value: number) => string {
  const { unit } = useContext(ShareStatsContext);
  return useCallback((value: number) => tokenScaleValue(value, unit), [unit]);
}

/**
 * A whole-number count with thousands separators — requests, errors, and other
 * tallies. Deliberately not compacted: "1.2K requests" hides the exact figure
 * an operator checks against a limit, and a request count is small enough to
 * read in full. Tokens keep the unit switch because their magnitudes are large.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.max(0, Math.round(value)).toLocaleString();
}

/** Mean tokens/sec with one decimal, or an em dash when nothing reported a rate. */
export function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  return `${Number(value.toFixed(1))} t/s`;
}

/** Mean time-to-first-token: sub-second in ms, longer as seconds, else an em dash. */
export function formatTtft(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}s`;
  return `${Math.round(value)}ms`;
}

/** "2 min ago" / "3 h ago" / a date once it is older than a day. */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Hour-of-day label for the axis, in the viewer's locale. */
function hourLabel(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

/**
 * The family quota, drawn in the hero.
 *
 * The figures are family totals — every key this link has issued — because the
 * allowance is shared, so a per-recipient number would understate what the link
 * has actually spent. A row with no limit shows its running total and no fill.
 */
export function ShareQuotaPanel({
  policy,
  stats,
}: {
  readonly policy: ShareLinkPolicyData;
  readonly stats: ShareFamilyStatsData | null;
}): ReactElement {
  const format = useTokenFormat();
  const rows: readonly { label: string; used: number; limit: number | null }[] = [
    { label: "Lifetime", used: stats?.totals?.totalTokens ?? 0, limit: policy.oneTimeLimit },
    { label: "Daily", used: stats?.totals?.todayTokens ?? 0, limit: policy.dailyLimit },
    { label: "Monthly", used: stats?.totals?.monthTokens ?? 0, limit: policy.monthlyLimit },
  ];
  const recipients = stats?.recipients;
  return (
    <div className="mt-5 flex flex-col gap-6 border-t border-inner-border pt-9">
      {rows.map((row) => {
        const limited = row.limit !== null && row.limit > 0;
        const ratio = limited ? Math.min(1, row.used / (row.limit as number)) : 1;
        // A row with no limit is a full green bar: there is no ceiling, so the
        // whole track reads as "unlimited". A limited row keeps the same green
        // track as the allowance and lays a red "used" fill over it, growing
        // left to right with the used fraction — so the red advances across the
        // green as usage climbs and, at (or past) the limit, the green is gone
        // and the bar is wholly red. Plenty of green means headroom; a bar that
        // is mostly red means the allowance is nearly spent.
        return (
          <div className="flex items-center gap-6 max-sm:flex-col max-sm:items-stretch max-sm:gap-3" key={row.label}>
            <span className="w-39 shrink-0 text-text-secondary font-mono text-micro uppercase tracking-label max-sm:w-auto">{row.label}</span>
            <div
              className="relative h-4 flex-1 overflow-hidden rounded-tiny bg-teal max-sm:flex-none"
              title={
                limited
                  ? `${format(row.used)} of ${format(row.limit as number)} used`
                  : `${format(row.used)} used (no limit set)`
              }
            >
              {limited ? (
                <div
                  className="h-full rounded-tiny bg-red transition-[width] duration-200"
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              ) : null}
            </div>
            <span className="whitespace-nowrap text-text-secondary font-mono text-micro [&>strong]:text-text-primary [&>strong]:font-semibold max-sm:self-start">
              <strong>{format(row.used)}</strong>
              {limited ? ` / ${format(row.limit as number)}` : " used"}
            </span>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex min-h-14 items-center gap-3.5 rounded-pill border border-inner-border bg-surface-2 px-5 py-2.5 text-text-secondary font-mono text-badge leading-[1.3]">RPM {policy.requestsPerMinute ?? "unlimited"}</span>
        <span className="inline-flex min-h-14 items-center gap-3.5 rounded-pill border border-inner-border bg-surface-2 px-5 py-2.5 text-text-secondary font-mono text-badge leading-[1.3]">Concurrent {policy.maxConcurrentRequests ?? "unlimited"}</span>
        {recipients ? (
          <span className="inline-flex min-h-14 items-center gap-3.5 rounded-pill border border-inner-border bg-surface-2 px-5 py-2.5 text-text-secondary font-mono text-badge leading-[1.3]">
            {recipients.active} / {recipients.total} recipients active
          </span>
        ) : null}
        <TokenUnitSwitch />
      </div>
    </div>
  );
}

/** 24-bar activity strip; gaps in the window read as empty bars, not a gap. */
function HourlySparkline({
  hourly,
}: {
  readonly hourly: ShareFamilyStatsData["hourly"];
}): ReactElement {
  const format = useTokenFormat();
  const max = Math.max(1, ...hourly.map((bucket) => bucket.requests));
  const slot = 10;
  const width = hourly.length * slot;
  const height = 44;
  // The bar under the pointer. Hover and drag both set it; leaving the strip
  // clears it, so the readout never lingers on a bar the pointer has left.
  const [active, setActive] = useState<number | null>(null);
  const bucketAt = (strip: HTMLDivElement, clientX: number): number | null => {
    const rect = strip.getBoundingClientRect();
    if (rect.width === 0 || hourly.length === 0) return null;
    const index = Math.floor(((clientX - rect.left) / rect.width) * hourly.length);
    return index >= 0 && index < hourly.length ? index : null;
  };
  const shown = active !== null ? hourly[active] : undefined;
  return (
    <div>
      <div className="mb-2 flex min-h-9 items-baseline gap-4 text-text-tertiary font-mono text-badge [&>strong]:text-text-primary [&>strong]:font-head [&>strong]:text-body-lg [&>strong]:font-semibold" aria-live="polite">
        {shown ? (
          <>
            <strong>{format(shown.tokens)}</strong>
            <span>
              {hourLabel(shown.hour)} · {formatCount(shown.requests)} req
            </span>
          </>
        ) : (
          <span>drag a bar</span>
        )}
      </div>
      <div
        className="cursor-crosshair touch-none"
        onPointerEnter={(event) => setActive(bucketAt(event.currentTarget, event.clientX))}
        onPointerMove={(event) => setActive(bucketAt(event.currentTarget, event.clientX))}
        onPointerLeave={() => setActive(null)}
      >
        <svg
          className="h-22 w-full"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Requests per hour over the last 24 hours"
        >
          {hourly.map((bucket, index) => {
            const barHeight = Math.round((bucket.requests / max) * (height - 4));
            return (
              <rect
                key={bucket.hour}
                className={`${bucket.requests === 0 ? "fill-track" : "fill-teal"}${index === active ? " fill-text-primary" : ""}`}
                x={index * slot + 1}
                y={height - Math.max(2, barHeight)}
                width={slot - 3}
                height={Math.max(2, barHeight)}
                rx={1.5}
              >
                <title>{`${format(bucket.tokens)} tokens · ${formatCount(bucket.requests)} requests`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="mt-1.5 flex justify-between text-text-tertiary font-mono text-micro">
        <span>{hourly.length ? hourLabel(hourly[0]!.hour) : ""}</span>
        <span>last 24h</span>
        <span>{hourly.length ? hourLabel(hourly[hourly.length - 1]!.hour) : ""}</span>
      </div>
    </div>
  );
}

/** A labelled count with a proportional bar, shared by the model and IP tables. */
function BarCell({
  value,
  max,
  label,
}: {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}): ReactElement {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="flex min-w-55 items-center gap-4 max-sm:min-w-32">
      <div className="h-3 min-w-0 flex-1 overflow-hidden rounded-tiny bg-surface-muted">
        <div className="h-full rounded-tiny bg-teal" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span className="min-w-8 text-right font-mono text-micro text-text-secondary">{label}</span>
    </div>
  );
}

/**
 * Family activity: KPIs, a 24-hour strip, top models and top client IPs.
 *
 * Collapsed by default — the page's job is to hand out a key, and this is the
 * evidence behind the quota, not the thing the recipient came for. IPs arrive
 * already masked from the gateway; nothing here unmasks them.
 */
export function ShareStatsSection({
  stats,
  loading,
}: {
  readonly stats: ShareFamilyStatsData | null;
  readonly loading: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const format = useTokenFormat();
  const totals = stats?.totals;
  const models = stats?.models ?? [];
  const ips = stats?.clientIps ?? [];
  const maxModelTokens = Math.max(1, ...models.map((model) => model.tokens));
  const maxIpRequests = Math.max(1, ...ips.map((ip) => ip.requests));

  return (
    <Card surface="muted" className="min-w-0 border-glass-border-2 bg-glass-bg p-5 backdrop-blur-md backdrop-saturate-150">
      <button
        type="button"
        className="group flex w-full cursor-pointer items-center gap-3 bg-transparent p-0 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-text-secondary transition-transform duration-200${open ? " rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span className="text-text-secondary font-mono text-badge font-bold tracking-label transition-colors duration-150 group-hover:text-text-primary">STATS &amp; ACTIVITY</span>
        <span className="ml-auto flex flex-wrap items-center gap-2 text-text-tertiary font-mono text-micro max-medium:hidden">
          <span>{ips.length} IPs</span>
          <span>·</span>
          <span>{models.length} models</span>
          <span>·</span>
          <span>{formatCount(totals?.requests ?? 0)} req</span>
        </span>
      </button>

      {open ? (
        <div className="mt-5 flex flex-col gap-5">
          {loading && !stats ? (
            <p className="py-9 text-center text-text-tertiary text-caption">Loading activity…</p>
          ) : !stats ? (
            <p className="py-9 text-center text-text-tertiary text-caption">Activity is unavailable right now.</p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-5 max-wide:grid-cols-2 max-narrow:grid-cols-1">
                <div className="flex flex-col gap-3 rounded-panel border border-inner-border bg-surface-2 px-7 py-6">
                  <span className="text-text-tertiary font-mono text-micro uppercase tracking-label">Requests</span>
                  <span className="font-head text-display font-semibold tracking-tight">{formatCount(totals?.requests ?? 0)}</span>
                  <span className="text-text-secondary text-micro">
                    {formatCount(totals?.errors ?? 0)} errors
                  </span>
                </div>
                <div className="flex flex-col gap-3 rounded-panel border border-inner-border bg-surface-2 px-7 py-6">
                  <span className="text-text-tertiary font-mono text-micro uppercase tracking-label">Tokens</span>
                  <span className="font-head text-display font-semibold tracking-tight">{format(totals?.totalTokens ?? 0)}</span>
                  <span className="text-text-secondary text-micro">all time</span>
                </div>
                <div className="flex flex-col gap-3 rounded-panel border border-inner-border bg-surface-2 px-7 py-6">
                  <span className="text-text-tertiary font-mono text-micro uppercase tracking-label">Last hour</span>
                  <span className="font-head text-display font-semibold tracking-tight">{formatCount(totals?.lastHourRequests ?? 0)}</span>
                  <span className="text-text-secondary text-micro">requests in 60 min</span>
                </div>
                <div className="flex flex-col gap-3 rounded-panel border border-inner-border bg-surface-2 px-7 py-6">
                  <span className="text-text-tertiary font-mono text-micro uppercase tracking-label">Models</span>
                  <span className="font-head text-display font-semibold tracking-tight">{models.length}</span>
                  <span className="text-text-secondary text-micro">in use</span>
                </div>
              </div>

              <HourlySparkline hourly={stats.hourly} />

              <section aria-label="Top models">
                <div className="flex items-center justify-between gap-6">
                  <h3 className="text-text-secondary font-mono text-badge font-bold tracking-label transition-colors duration-150">TOP MODELS</h3>
                </div>
                {models.length === 0 ? (
                  <p className="py-9 text-center text-text-tertiary text-caption">No model traffic yet.</p>
                ) : (
                  <div className={STATS_TABLE_SCROLL_CLASS}>
                    <table className={STATS_TABLE_CLASS}>
                      <thead>
                        <tr>
                          <th scope="col" aria-label="Rank" />
                          <th scope="col">Model</th>
                          <th scope="col" className="text-right">
                            Req
                          </th>
                          <th scope="col" className="text-right" title="Average output tokens per second">
                            Avg t/s
                          </th>
                          <th scope="col" className="text-right" title="Average time to first token">
                            TTFT
                          </th>
                          <th scope="col">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {models.map((model, index) => (
                          <tr key={model.modelId}>
                            <td className="w-13 font-mono text-micro text-text-tertiary">{index + 1}</td>
                            <td>
                              <span className="flex min-w-0 flex-col gap-1 [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:text-text-primary [&_code]:text-caption [&_span]:font-mono [&_span]:text-micro [&_span]:text-text-tertiary">
                                <code title={model.modelId}>{model.modelId}</code>
                              </span>
                            </td>
                            <td className="text-right">{formatCount(model.requests)}</td>
                            <td className="text-right">{formatRate(model.avgTokensPerSec)}</td>
                            <td className="text-right">{formatTtft(model.avgTtfbMs)}</td>
                            <td>
                              <BarCell
                                value={model.tokens}
                                max={maxModelTokens}
                                label={format(model.tokens)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-label="Client IPs">
                <div className="flex items-center justify-between gap-6">
                  <h3 className="text-text-secondary font-mono text-badge font-bold tracking-label transition-colors duration-150">CLIENT IPS</h3>
                </div>
                {ips.length === 0 ? (
                  <p className="py-9 text-center text-text-tertiary text-caption">No client addresses recorded yet.</p>
                ) : (
                  <div className={STATS_TABLE_SCROLL_CLASS}>
                    <table className={STATS_TABLE_CLASS}>
                      <thead>
                        <tr>
                          <th scope="col">Address</th>
                          <th scope="col">Client</th>
                          <th scope="col" className="text-right">
                            Req
                          </th>
                          <th scope="col">Tokens</th>
                          <th scope="col">Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ips.map((ip) => (
                          <tr key={ip.ip}>
                            <td>
                              <code>{ip.ip}</code>
                            </td>
                            <td>
                              {ip.clientType ? (
                                <span className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-pill border border-inner-border bg-surface-2 px-3 py-px font-mono text-micro text-text-secondary">{ip.clientType}</span>
                              ) : (
                                <span className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-pill border border-inner-border bg-surface-2 px-3 py-px font-mono text-micro italic text-text-tertiary">unknown</span>
                              )}
                            </td>
                            <td className="text-right">{formatCount(ip.requests)}</td>
                            <td>
                              <BarCell value={ip.requests} max={maxIpRequests} label={format(ip.tokens)} />
                            </td>
                            <td>{relativeTime(ip.lastSeenAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

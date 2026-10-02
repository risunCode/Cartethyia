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
} from "../../shared/format";

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
      className="share-unit-switch"
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
    <div className="share-quota">
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
          <div className="share-quota-row" key={row.label}>
            <span className="share-quota-label">{row.label}</span>
            <div
              className={`share-quota-track${limited ? " is-limited" : " is-unlimited"}`}
              title={
                limited
                  ? `${format(row.used)} of ${format(row.limit as number)} used`
                  : `${format(row.used)} used (no limit set)`
              }
            >
              {limited ? (
                <div
                  className="share-quota-used"
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              ) : null}
            </div>
            <span className="share-quota-value">
              <strong>{format(row.used)}</strong>
              {limited ? ` / ${format(row.limit as number)}` : " used"}
            </span>
          </div>
        );
      })}
      <div className="share-quota-meta">
        <span className="share-meta-pill">RPM {policy.requestsPerMinute ?? "unlimited"}</span>
        <span className="share-meta-pill">Concurrent {policy.maxConcurrentRequests ?? "unlimited"}</span>
        {recipients ? (
          <span className="share-meta-pill">
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
  const max = Math.max(1, ...hourly.map((bucket) => bucket.requests));
  const slot = 10;
  const width = hourly.length * slot;
  const height = 44;
  return (
    <div>
      <svg
        className="share-sparkline"
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
              className={`share-sparkline-bar${bucket.requests === 0 ? " is-empty" : ""}`}
              x={index * slot + 1}
              y={height - Math.max(2, barHeight)}
              width={slot - 3}
              height={Math.max(2, barHeight)}
              rx={1.5}
            />
          );
        })}
      </svg>
      <div className="share-hourly-axis">
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
    <div className="share-stats-bar">
      <div className="share-stats-bar-track">
        <div className="share-stats-bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span>{label}</span>
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
    <Card className="share-hud-card share-stats">
      <button
        type="button"
        className="share-stats-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          size={14}
          className={`share-stats-chevron${open ? " is-open" : ""}`}
          aria-hidden="true"
        />
        <span className="share-stats-title">STATS &amp; ACTIVITY</span>
        <span className="share-stats-summary">
          <span>{ips.length} IPs</span>
          <span>·</span>
          <span>{models.length} models</span>
          <span>·</span>
          <span>{formatCount(totals?.requests ?? 0)} req</span>
        </span>
      </button>

      {open ? (
        <div className="share-stats-body">
          {loading && !stats ? (
            <p className="share-stats-empty">Loading activity…</p>
          ) : !stats ? (
            <p className="share-stats-empty">Activity is unavailable right now.</p>
          ) : (
            <>
              <div className="share-stats-kpis">
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Requests</span>
                  <span className="share-stat-tile-value">{formatCount(totals?.requests ?? 0)}</span>
                  <span className="share-stat-tile-detail">
                    {formatCount(totals?.errors ?? 0)} errors
                  </span>
                </div>
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Tokens</span>
                  <span className="share-stat-tile-value">{format(totals?.totalTokens ?? 0)}</span>
                  <span className="share-stat-tile-detail">all time</span>
                </div>
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Last hour</span>
                  <span className="share-stat-tile-value">{formatCount(totals?.lastHourRequests ?? 0)}</span>
                  <span className="share-stat-tile-detail">requests in 60 min</span>
                </div>
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Models</span>
                  <span className="share-stat-tile-value">{models.length}</span>
                  <span className="share-stat-tile-detail">in use</span>
                </div>
              </div>

              <HourlySparkline hourly={stats.hourly} />

              <section aria-label="Top models">
                <div className="share-section-heading">
                  <h3 className="share-stats-title">TOP MODELS</h3>
                </div>
                {models.length === 0 ? (
                  <p className="share-stats-empty">No model traffic yet.</p>
                ) : (
                  <div className="share-stats-scroll is-windowed">
                    <table className="share-stats-table">
                      <thead>
                        <tr>
                          <th scope="col" aria-label="Rank" />
                          <th scope="col">Model</th>
                          <th scope="col" className="is-numeric">
                            Req
                          </th>
                          <th scope="col" className="is-numeric" title="Average output tokens per second">
                            Avg t/s
                          </th>
                          <th scope="col" className="is-numeric" title="Average time to first token">
                            TTFT
                          </th>
                          <th scope="col">Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {models.map((model, index) => (
                          <tr key={model.modelId}>
                            <td className="share-stats-rank">{index + 1}</td>
                            <td>
                              <span className="share-stats-model">
                                <code title={model.modelId}>{model.modelId}</code>
                              </span>
                            </td>
                            <td className="is-numeric">{formatCount(model.requests)}</td>
                            <td className="is-numeric share-stats-metric">{formatRate(model.avgTokensPerSec)}</td>
                            <td className="is-numeric share-stats-metric">{formatTtft(model.avgTtfbMs)}</td>
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
                <div className="share-section-heading">
                  <h3 className="share-stats-title">CLIENT IPS</h3>
                </div>
                {ips.length === 0 ? (
                  <p className="share-stats-empty">No client addresses recorded yet.</p>
                ) : (
                  <div className="share-stats-scroll is-windowed">
                    <table className="share-stats-table">
                      <thead>
                        <tr>
                          <th scope="col">Address</th>
                          <th scope="col">Client</th>
                          <th scope="col" className="is-numeric">
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
                                <span className="share-stats-client">{ip.clientType}</span>
                              ) : (
                                <span className="share-stats-client is-unknown">unknown</span>
                              )}
                            </td>
                            <td className="is-numeric">{formatCount(ip.requests)}</td>
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

import {
  Check,
  Clock,
  Copy,
  Gauge,
  Globe,
  MemoryStick,
  RefreshCw,
  Server,
  Timer,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { ApiKeysPanel } from "../../components/ApiKeysPanel";
import { CompressionPanel } from "../../components/CompressionPanel";
import { useTrackedTimeout } from "../../hooks/use-timeout";
import { useNetworkPools } from "../../hooks/network";
import { useSystemHealth } from "../../hooks/system";
import { formatBytes, formatDuration, formatUptime } from "../../lib/format";

// ── System Overview 4 Resource Cards ──────────────────────────────────────────

function SystemOverviewPanel({
  onRefresh,
  refreshing,
}: {
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
}) {
  const healthQuery = useSystemHealth();
  const poolsQuery = useNetworkPools();
  const health = healthQuery.data;
  const pools = poolsQuery.data ?? [];

  const totalProxies = pools.length;
  const activeProxies = pools.filter((p) => p.status === "active").length;
  const socks5Count = pools.filter((p) => p.kind === "socks5").length;
  const httpCount = pools.filter((p) => p.kind === "http" || p.kind === "https").length;
  const flightCapacity = pools
    .filter((p) => p.status === "active")
    .reduce((sum, p) => sum + (p.maxInflight || 10), 0);

  // RSS is the kernel's resident set — the only figure here that matches ps
  // and /proc. The JS heap and external counters are NOT reported: under a WASM
  // database Bun reports a heapUsed larger than heapTotal (and larger than RSS
  // itself), so both numbers are nonsense and were removed rather than shown.
  const rssBytes = health?.memory_bytes ?? 0;
  // Lite embeds PostgreSQL in this process, so most of the RSS is the database.
  const databaseInProcess = health?.database_in_process === true;

  const p95Latency = health?.latency_p95_ms ?? 0;
  const avgLatency = health?.latency_avg_ms ?? 0;
  const tailGap = Math.max(0, p95Latency - avgLatency);

  const uptimeStr = formatUptime(health?.uptime_seconds);
  const cpuPercent = health ? Math.min(100, Math.max(0, health.cpu_percent)) : 0;

  return (
    <Card>
      <CardHeader
        title="System Overview"
        subtitle="Real-time proxy engine, memory allocation, and upstream health"
        icon={<Gauge size={16} />}
        action={
          onRefresh ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              icon={<RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null
        }
      />
      <CardBody>
        <div className="health-resource-grid">
          {/* Card 1: RAM & Memory */}
          <section className="health-card-resource">
            <div className="overview-card-header">
              <Inline gap="8px">
                <span className="card-header-icon" data-tone="purple"><MemoryStick size={14} /></span>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: "12px", fontWeight: 700, whiteSpace: "nowrap" }}>
                    RAM & Memory
                  </h3>
                  <p
                    style={{
                      fontSize: "9.5px",
                      color: "var(--text-tertiary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Bun Runtime · Process
                  </p>
                </div>
              </Inline>
            </div>
            <div className="overview-card-primary">
              <span className="overview-card-primary-value">{formatBytes(rssBytes)}</span>
              <span className="overview-card-primary-label">RSS</span>
            </div>
            <p className="overview-card-summary">
              Resident memory, the same figure ps and /proc report.
              {databaseInProcess
                ? " Lite mode embeds PostgreSQL in this process, so most of it is the database — not the gateway."
                : " The database runs as its own process and is not included here."}
            </p>
            <div className="overview-card-footer">
              <div className="overview-mini-grid">
                <div className="overview-mini">
                  <div className="overview-mini-label">
                    <span>Database</span>
                    <span style={{ color: databaseInProcess ? "var(--amber, #d29922)" : "var(--green)" }}>
                      {databaseInProcess ? "embedded in this process" : "external process"}
                    </span>
                  </div>
                </div>
                <div className="overview-mini">
                  <div className="overview-mini-label">
                    <span>Share of RAM</span>
                    <span style={{ color: "var(--purple)" }}>
                      {(health?.memory_percent ?? 0).toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Card 2: Request Latency & Performance */}
          <section className="health-card-resource">
            <div className="overview-card-header">
              <Inline gap="8px">
                <span className="card-header-icon"><Timer size={14} /></span>
                <div>
                  <h3 style={{ fontSize: "12px", fontWeight: 700 }}>Request Latency</h3>
                  <p style={{ fontSize: "9.5px", color: "var(--text-tertiary)" }}>
                    p95 · average · tail gap
                  </p>
                </div>
              </Inline>
            </div>

            <div className="overview-card-primary">
              <span className="overview-card-primary-value">{formatDuration(p95Latency)}</span>
              <span className="overview-card-primary-label">p95 latency</span>
            </div>
            <p className="overview-card-summary">
              Avg {formatDuration(avgLatency)} · tail gap {formatDuration(tailGap)}
              {"\n"}24h rolling window · {health?.error_count ?? 0} errors
            </p>

            <div className="overview-card-footer">
              <div className="overview-mini-grid">
                <div className="overview-mini">
                  <div className="overview-mini-label">Avg</div>
                  <div className="overview-mini-value">{formatDuration(avgLatency)}</div>
                  <div className="overview-mini-caption">per request</div>
                </div>
                <div className="overview-mini">
                  <div className="overview-mini-label">Spread</div>
                  <div className="overview-mini-value">{formatDuration(tailGap)}</div>
                  <div className="overview-mini-caption">p95 minus avg</div>
                </div>
              </div>

              <div className="overview-bar-rail">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "9px",
                    color: "var(--text-tertiary)",
                  }}
                >
                  <span>Latency window</span>
                  <span>24h</span>
                </div>
                <div className="overview-bar">
                  <div
                    className="overview-bar-fill overview-bar-fill--accent"
                    style={{
                      width: `${Math.min(100, Math.max(0, (p95Latency / Math.max(1, p95Latency + avgLatency)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Card 3: Proxy Pool */}
          <section className="health-card-resource">
            <div className="overview-card-header">
              <Inline gap="8px">
                <span className="card-header-icon" data-tone="orange"><Server size={14} /></span>
                <div>
                  <h3 style={{ fontSize: "12px", fontWeight: 700 }}>Proxy Pool</h3>
                  <p style={{ fontSize: "9.5px", color: "var(--text-tertiary)" }}>
                    SOCKS5 · HTTP
                  </p>
                </div>
              </Inline>
            </div>

            <div className="overview-card-primary">
              <span className="overview-card-primary-value">{totalProxies}</span>
              <span className="overview-card-primary-label">proxies</span>
            </div>
            <p className="overview-card-summary">
              Socks5 {socks5Count}/{totalProxies} · HTTP/S {httpCount}
              {"\n"}Active {activeProxies}/{totalProxies} · flight cap {flightCapacity}
            </p>

            <div className="overview-card-footer">
              <div className="overview-mini-grid">
                <div className="overview-mini">
                  <div className="overview-mini-label">Socks5</div>
                  <div className="overview-mini-value">
                    {socks5Count}{" "}
                    <span style={{ fontSize: "10px", fontWeight: 400, color: "var(--text-3)" }}>
                      / {totalProxies}
                    </span>
                  </div>
                  <div className="overview-bar" style={{ marginTop: "4px" }}>
                    <div
                      className="overview-bar-fill overview-bar-fill--orange"
                      style={{ width: `${totalProxies ? (socks5Count / totalProxies) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <div className="overview-mini">
                  <div className="overview-mini-label">Flight Cap</div>
                  <div className="overview-mini-value">{flightCapacity}</div>
                  <div className="overview-bar" style={{ marginTop: "4px" }}>
                    <div
                      className="overview-bar-fill overview-bar-fill--blue"
                      style={{
                        width: `${flightCapacity ? Math.min(100, (flightCapacity / Math.max(flightCapacity, 50)) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="overview-bar-rail">
                <div className="overview-bar">
                  <div
                    style={{
                      width: `${totalProxies ? (socks5Count / totalProxies) * 100 : 0}%`,
                      background: "var(--orange)",
                    }}
                  />
                  <div
                    style={{
                      width: `${totalProxies ? (httpCount / totalProxies) * 100 : 0}%`,
                      background: "#0a84ff",
                    }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "9px",
                    color: "var(--text-tertiary)",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "999px",
                        background: "var(--orange)",
                      }}
                    />{" "}
                    Socks5
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <span
                      style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "999px",
                        background: "#0a84ff",
                      }}
                    />{" "}
                    HTTP/S
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Card 4: Engine & Uptime */}
          <section className="health-card-resource">
            <div className="overview-card-header">
              <Inline gap="8px">
                <span className="card-header-icon"><Clock size={14} /></span>
                <div>
                  <h3 style={{ fontSize: "12px", fontWeight: 700 }}>Uptime</h3>
                  <p style={{ fontSize: "9.5px", color: "var(--text-tertiary)" }}>
                    System info · Bun
                  </p>
                </div>
              </Inline>
            </div>

            <div className="overview-card-primary">
              <span className="overview-card-primary-value overview-card-primary-value-sm">
                {uptimeStr}
              </span>
              <span className="overview-card-primary-label">uptime</span>
            </div>
            <p className="overview-card-summary">
              PID {health?.pid ?? "—"} · {health?.cpu_cores ?? "—"} cores ·{" "}
              {health?.platform ?? "Bun"}
              {"\n"}Atomic local admission · Zero-overhead sync
            </p>

            <div className="overview-card-footer">
              <div className="overview-mini-grid">
                <div className="overview-mini">
                  <div className="overview-mini-label">CPU Cores</div>
                  <div className="overview-mini-value overview-mini-value-sm">
                    {health?.cpu_cores ?? "—"} cores
                  </div>
                  <div className="overview-mini-caption">host processor</div>
                </div>
                <div className="overview-mini">
                  <div className="overview-mini-label">Process ID</div>
                  <div className="overview-mini-value overview-mini-value-sm">
                    #{health?.pid ?? "—"}
                  </div>
                  <div className="overview-mini-caption">gateway PID</div>
                </div>
              </div>

              <div className="overview-bar-rail">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "9px",
                    color: "var(--text-tertiary)",
                  }}
                >
                  <span>CPU usage</span>
                  <span>{cpuPercent.toFixed(1)}%</span>
                </div>
                <div className="overview-bar">
                  <div
                    className="overview-bar-fill overview-bar-fill--orange"
                    style={{ width: `${Math.min(100, Math.max(0, cpuPercent))}%` }}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      </CardBody>
    </Card>
  );
}

// ── API Endpoint Card ─────────────────────────────────────────────────────────

function ApiEndpointCard() {
  const [copied, setCopied] = useState(false);
  const schedule = useTrackedTimeout();
  const endpoint = `${window.location.origin}/v1`;

  const copy = () => {
    void navigator.clipboard.writeText(endpoint);
    setCopied(true);
    schedule(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader
        title="Gateway Endpoint"
        subtitle="Universal OpenAI & Anthropic Wire API Endpoint"
        icon={<Globe size={16} />}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={copy}
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        }
      />
      <CardBody>
        <Stack gap="10px">
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "10px",
              border: "1px solid var(--inner-border)",
              background: "var(--code-surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: "var(--font-mono)",
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            <code>{endpoint}</code>
            <span style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 400 }}>
              PORT 12800
            </span>
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Point any SDK, CLI, or agent (e.g. Claude Code, Windsurf, OpenCode) to this same-origin
            base URL.
          </p>
        </Stack>
      </CardBody>
    </Card>
  );
}

// ── Main Page Export ──────────────────────────────────────────────────────────

export default function Overview(): ReactNode {
  const healthQuery = useSystemHealth();
  const poolsQuery = useNetworkPools();

  const refresh = () => {
    void Promise.all([healthQuery.refetch(), poolsQuery.refetch()]).catch(() => undefined);
  };

  const isFetching = healthQuery.isFetching || poolsQuery.isFetching;

  return (
    <Stack gap="16px">
      <ApiEndpointCard />
      <SystemOverviewPanel onRefresh={refresh} refreshing={isFetching} />
      <CompressionPanel />
      <ApiKeysPanel />
    </Stack>
  );
}

import {
  Activity,
  Clock,
  Cloud,
  Download,
  FlaskConical,
  Gauge,
  Loader2,
  Plus,
  Power,
  Pencil,
  PowerOff,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RelayDeployModal } from "../components/RelayDeployPanel";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { DataTable, StatCard } from "../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Select } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import {
  SPEED_TEST_DEFAULT_BYTES,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MIN_BYTES,
} from "../data/contracts";
import type { HealthCheckResult, NetworkPoolResponse, PoolSpeedTestResult } from "../data/contracts";
import {
  useCreateNetworkPool,
  useDeleteNetworkPool,
  useHealthCheckNetworkPool,
  useNetworkPoolHealthEvents,
  useNetworkPools,
  useProbeNetworkPoolBatch,
  useRecoverNetworkPool,
  useSpeedTestNetworkPool,
  useUpdateNetworkPool,
  useClearNetworkPoolCooldown,
} from "../hooks/network";
import { usePoolUsage, type PoolUsageRow } from "../hooks/live";
import {
  formatBytes,
  MAX_BATCH_PROBE_TARGETS,
  sortPools,
  summarizePools,
  type PoolSortKey,
  type ProxyPoolSummary,
} from "../shared/proxy-metrics";
import { downloadTextFile } from "../shared/download";
import { toast } from "../shared/toast";
import { getErrorMessage } from "../shared/helpers";
const transportKinds = ["http", "https", "socks5"] as const;
type TransportKind = (typeof transportKinds)[number];



/** Averages are only meaningful once something has been measured; say so
 * plainly instead of showing a confident `0ms`. */
function latencyDetail(summary: ProxyPoolSummary): string {
  if (summary.avgLatencyMs === null) return "no measurement yet";
  return `avg across ${summary.measuredPools} enabled ${summary.measuredPools === 1 ? "pool" : "pools"}`;
}

/** Human-readable cooldown summary: how many pools are cooling and for how
 * long the nearest one still has to wait. */
function cooldownDetail(summary: ProxyPoolSummary): string {
  if (summary.cooldown === 0) return "no pool is waiting";
  const remaining = summary.soonestCooldownMs;
  if (remaining === null) return "waiting on a provider or pool";
  const seconds = Math.ceil(remaining / 1000);
  const wait = seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
  return `${summary.cooldown} cooling · ${wait} left`;
}

/** Derives a friendly `host:port` name and a normalized full endpoint URL from a pool. */
function poolDisplay(pool: NetworkPoolResponse): { name: string; endpoint: string } {
  const raw = pool.endpoint || "";
  const candidate = raw.includes("://") ? raw : `${pool.kind}://${raw}`;
  const defaultPorts: Record<string, string> = {
    "https:": "443",
    "http:": "80",
    "socks5:": "1080",
    "socks:": "1080",
  };
  try {
    const u = new URL(candidate);
    const port = u.port || defaultPorts[u.protocol] || "";
    const authority = `${u.hostname}${port ? `:${port}` : ""}`;
    return {
      name: authority,
      endpoint: `${u.protocol}//${authority}${u.pathname !== "/" ? u.pathname : ""}${u.search}`,
    };
  } catch {
    return { name: pool.label || raw, endpoint: raw };
  }
}

/** Human-friendly pool name: explicit label first, then the derived `host:port`. */
function poolName(pool: NetworkPoolResponse): string {
  return pool.label || poolDisplay(pool).name || pool.id;
}

const GIB = 1024 ** 3;
// A measurement plus when it was taken. The timestamp is dashboard-only state —
// the API has no reason to record it — but without it a persisted result cannot
// say "last measured 20 minutes ago", which is the whole point of keeping it.
type StoredSpeedResult = PoolSpeedTestResult & { readonly measuredAt?: string };
// Payload choices for the speed-test split control. Labels are decimal MB
// (1 MB = 1_000_000 bytes) to match how proxy plans are sold.
const SPEED_TEST_SIZES = [
  { value: String(SPEED_TEST_MIN_BYTES), label: "1 MB" },
  { value: String(SPEED_TEST_DEFAULT_BYTES), label: "5 MB" },
  { value: String(50_000_000), label: "50 MB" },
  { value: String(SPEED_TEST_MAX_BYTES), label: "100 MB" },
];
/** Parses a GB field into bytes; blank or invalid means "no quota". */
function parseQuotaGb(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const gb = Number(trimmed);
  if (!Number.isFinite(gb) || gb <= 0) return null;
  return Math.max(1, Math.round(gb * GIB));
}

function PoolEditForm({
  pool,
  onClose,
}: {
  readonly pool: NetworkPoolResponse;
  readonly onClose: () => void;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const healthCheck = useHealthCheckNetworkPool();
  const [label, setLabel] = useState(pool.label ?? "");
  const [endpoint, setEndpoint] = useState(pool.endpoint ?? "");
  const [cap, setCap] = useState(String(pool.maxInflight ?? 10));
  const [weight, setWeight] = useState(String(pool.weight ?? 100));
  // Quota is entered in GB because that is how providers sell it; it is stored
  // in bytes so the usage bar can compare without a lossy round-trip.
  const [quotaGb, setQuotaGb] = useState(
    pool.quotaBytes ? String(Math.round((pool.quotaBytes / GIB) * 1000) / 1000) : "",
  );
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const runAdhocTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await healthCheck.mutateAsync(pool.id);
      if (result.status === "reachable") {
        setTestResult({ ok: true, message: result.errorMessage ?? "Proxy reachable" });
      } else {
        setTestResult(
          result.status === "healthy"
            ? { ok: true, message: `Connected in ${result.latencyMs ?? 0}ms` }
            : { ok: false, message: result.errorMessage ?? "Connection failed" },
        );
      }
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, "Connection failed") });
    } finally {
      setTesting(false);
    }
  };

  const quotaValue = parseQuotaGb(quotaGb);

  const save = async () => {
    await updatePool.mutateAsync({
      poolId: pool.id,
      request: {
        ...(label.trim() !== pool.label ? { label: label.trim() || undefined } : {}),
        ...(endpoint.trim() !== pool.endpoint && endpoint.trim() !== ""
          ? { endpoint: endpoint.trim() }
          : {}),
        ...(Number(cap) !== pool.maxInflight ? { maxInflight: Number(cap) } : {}),
        ...(Number(weight) !== pool.weight ? { weight: Number(weight) } : {}),
        ...(quotaValue !== (pool.quotaBytes ?? null) ? { quotaBytes: quotaValue } : {}),
      },
    });
    toast.success("Proxy updated");
    onClose();
  };

  const inputStyle = { width: "100%" };

  return (
    <Stack gap="12px">
      <div>
        <Input
          label="Name"
          value={label}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
          style={inputStyle}
        />
      </div>
      <div>
        <Input
          label="Endpoint"
          value={endpoint}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndpoint(e.target.value)}
          style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <div>
          <Input
            label="Max concurrent"
            type="number"
            min={1}
            value={cap}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCap(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <Input
            label="Weight"
            type="number"
            min={1}
            value={weight}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWeight(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>
      <div>
        <Input
          label="Bandwidth quota (GB, blank = unmetered)"
          type="number"
          min={0.001}
          step="0.1"
          value={quotaGb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuotaGb(e.target.value)}
          style={inputStyle}
        />
        <div style={{ fontSize: "10.5px", color: "var(--text-tertiary)", marginTop: "4px" }}>
          {quotaValue === null
            ? "No quota — the bar shows a running total only."
            : `Bar turns orange at 80% and red once ${formatBytes(quotaValue)} is exceeded.`}
        </div>
      </div>
      {testResult && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            fontSize: "11px",
            fontWeight: 600,
            background: testResult.ok ? "var(--green-soft)" : "var(--red-soft)",
            color: testResult.ok ? "var(--green)" : "var(--red)",
          }}
        >
          {testResult.message}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={testing}
          icon={
            testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />
          }
          onClick={() => void runAdhocTest()}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Inline gap="8px">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={updatePool.isPending || !endpoint.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </Inline>
      </div>
    </Stack>
  );
}

function detectProxyKind(line: string): TransportKind {
  const s = line.trim().toLowerCase();
  if (s.startsWith("https://")) return "https";
  if (s.startsWith("socks5://") || s.startsWith("socks://")) return "socks5";
  return "http";
}

function ProxyBulkForm({ onClose }: { readonly onClose: () => void }): ReactNode {
  const createPool = useCreateNetworkPool();
  const probeBatch = useProbeNetworkPoolBatch();
  const [text, setText] = useState("");
  const [quotaGb, setQuotaGb] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const overCap = lines.length > MAX_BATCH_PROBE_TARGETS;
  const quotaBytes = parseQuotaGb(quotaGb);
  const targets = useMemo(
    () => lines.map((line) => ({ kind: detectProxyKind(line), endpoint: line })),
    [lines],
  );

  const handlePaste = async () => {
    try {
      const v = await navigator.clipboard.readText();
      if (v) setText((p) => (p ? `${p}\n${v}` : v));
    } catch {
      toast.error("Paste failed", "Clipboard access denied");
    }
  };

  /** Probes every pasted endpoint in one batched request. */
  const runTest = async () => {
    if (targets.length === 0) return;
    setLog([`Testing ${targets.length} proxy target(s)…`]);
    try {
      const results = await probeBatch.mutateAsync(targets);
      const rows = results.map((entry) => {
        const ok = entry.result.status === "healthy" || entry.result.status === "reachable";
        const latency = entry.result.latencyMs === undefined ? "" : ` · ${entry.result.latencyMs}ms`;
        const detail = ok ? "" : ` · ${entry.result.errorMessage ?? entry.result.status}`;
        return `${ok ? "OK  " : "FAIL"} ${entry.endpoint}${latency}${detail}`;
      });
      const okCount = results.filter(
        (r) => r.result.status === "healthy" || r.result.status === "reachable",
      ).length;
      setLog([`${okCount}/${results.length} reachable`, ...rows]);
      if (okCount === results.length) toast.success(`All ${results.length} proxies reachable`);
      else toast.error(`${results.length - okCount} of ${results.length} proxies failed`);
    } catch (err) {
      setLog([`Test failed: ${getErrorMessage(err, "batch probe failed")}`]);
      toast.error("Test failed", getErrorMessage(err, "batch probe failed"));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) return;
    setError(null);
    let ok = 0;
    let fail = 0;
    const failures: string[] = [];
    for (const line of lines) {
      try {
        await createPool.mutateAsync({
          kind: detectProxyKind(line),
          endpoint: line,
          ...(quotaBytes === null ? {} : { quotaBytes }),
        });
        ok++;
      } catch (err) {
        fail++;
        if (failures.length < 3) failures.push(`${line.slice(0, 48)}…: ${getErrorMessage(err, "invalid endpoint")}`);
      }
    }
    if (ok > 0) toast.success(`Added ${ok} proxy pool(s)`, fail ? `${fail} failed` : undefined);
    if (fail > 0 && ok === 0) toast.error("Failed to create pool", "Check endpoint format");
    if (fail > 0) setError(failures.join("\n"));
    if (ok > 0) {
      setText("");
      onClose();
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
          Paste one per line · http / https / socks5
        </span>
        <Button variant="secondary" size="sm" type="button" onClick={handlePaste}>
          Paste
        </Button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"http://10.0.1.5:8080\nhttps://10.0.1.6:8443\nsocks5://10.0.1.7:1080"}
        rows={8}
        style={{
          width: "100%",
          minHeight: "160px",
          padding: "10px",
          borderRadius: "10px",
          border: "1px solid var(--inner-border)",
          background: "var(--surface-1)",
          color: "var(--text-primary)",
          fontSize: "12.5px",
          fontFamily: "ui-monospace, monospace",
          resize: "vertical",
        }}
      />
      <div>
        <Input
          label="Bandwidth quota per pool (GB, blank = unmetered)"
          type="number"
          min={0.001}
          step="0.1"
          value={quotaGb}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuotaGb(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ fontSize: "11px", color: overCap ? "var(--red)" : "var(--text-tertiary)" }}>
        {lines.length} line(s) detected
        {overCap ? ` · ${MAX_BATCH_PROBE_TARGETS} max per test` : ""}
      </div>
      {error && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            fontSize: "11px",
            whiteSpace: "pre-line",
            background: "var(--red-soft)",
            color: "var(--red)",
          }}
        >
          {error}
        </div>
      )}
      {log.length > 0 && (
        <div
          role="log"
          aria-label="Proxy test results"
          style={{
            // Fixed height with its own scrollbar: a 100-line paste must not
            // stretch the dialog, it should scroll inside this box.
            height: "132px",
            maxHeight: "132px",
            overflowY: "auto",
            padding: "8px 10px",
            borderRadius: "8px",
            border: "1px solid var(--inner-border)",
            background: "var(--surface-1)",
            color: "var(--text-secondary)",
            fontFamily: "ui-monospace, monospace",
            fontSize: "11px",
            lineHeight: 1.6,
            whiteSpace: "pre",
          }}
        >
          {log.join("\n")}
        </div>
      )}
      <div style={{ display: "flex", gap: "10px", justifyContent: "space-between", marginTop: "4px" }}>
        <Button
          variant="secondary"
          type="button"
          onClick={() => void runTest()}
          disabled={probeBatch.isPending || lines.length === 0 || overCap}
        >
          {probeBatch.isPending ? "Testing…" : "Test proxies"}
        </Button>
        <div style={{ display: "flex", gap: "10px" }}>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={createPool.isPending || lines.length === 0}
          >
            {createPool.isPending ? "Adding…" : `Add ${lines.length || ""} Proxy`}
          </Button>
        </div>
      </div>
    </form>
  );
}

function poolLatencyMs(
  pool: NetworkPoolResponse,
  checkResult?: HealthCheckResult,
): number | undefined {
  if (checkResult?.status === "healthy" || checkResult?.status === "reachable") {
    return checkResult.latencyMs;
  }
  if (pool.lastSuccessAt) return pool.lastLatencyMs ?? undefined;
  return undefined;
}
function proxyResponseLabel(category: string | undefined): string | undefined {
  if (category === "proxy_payment_required") return "HTTP 402 Payment Required";
  if (category === "proxy_auth_required") return "HTTP 407 Proxy Authentication Required";
  return undefined;
}


/**
 * Live per-pool usage, held above the page body.
 *
 * The stream ticks whenever a pool acquires or releases a slot. Subscribing in
 * the page component itself re-rendered the whole page — every row, every
 * handler — on each tick, which is what made a busy Proxy page feel heavy. The
 * subscription lives here instead and children pass through as a prop, so the
 * subtree stays referentially stable and a tick re-renders only the two
 * components that read this context. One stream per open page.
 */
const PoolUsageContext = createContext<{
  readonly byId: ReadonlyMap<string, PoolUsageRow>;
  readonly live: boolean;
}>({ byId: new Map(), live: false });

export function ProxyLiveProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const usage = usePoolUsage();
  const byId = useMemo(
    () => new Map((usage.pools ?? []).map((row) => [row.poolId, row] as const)),
    [usage.pools],
  );
  const value = useMemo(
    () => ({ byId, live: usage.live && usage.pools !== null }),
    [byId, usage.live, usage.pools],
  );
  return <PoolUsageContext.Provider value={value}>{children}</PoolUsageContext.Provider>;
}

/**
 * The four summary tiles. Split out because the live stream moves three of
 * them; keeping them in the page would re-render the table below on every tick.
 */
function ProxySummaryTiles({ pools }: { readonly pools: readonly NetworkPoolResponse[] }): ReactNode {
  const { byId, live } = useContext(PoolUsageContext);
  const summary = useMemo(
    () =>
      summarizePools(
        pools,
        live ? new Map([...byId].map(([id, row]) => [id, row.currentInflight] as const)) : undefined,
      ),
    [pools, byId, live],
  );
  return (
    <div className="metric-grid" style={{ marginBottom: "14px" }}>
      <StatCard
        label="Enabled pool"
        value={String(summary.active)}
        detail={`/ ${summary.totalPools} total`}
        tone="accent"
        icon={<ShieldCheck size={13} />}
      />
      <StatCard
        label="Route capacity"
        value={String(summary.totalMaxConcurrency)}
        detail={`${summary.usedInflight} inflight · ${summary.availableCapacity} available`}
        tone={summary.availableCapacity === 0 ? "orange" : "teal"}
        icon={<Gauge size={13} />}
      />
      <StatCard
        label="Latency"
        value={summary.avgLatencyMs === null ? "—" : `${summary.avgLatencyMs}ms`}
        detail={latencyDetail(summary)}
        tone={
          summary.avgLatencyMs === null
            ? "accent"
            : summary.avgLatencyMs > 2000
              ? "orange"
              : "teal"
        }
        icon={<Activity size={13} />}
      />
      <StatCard
        label="Cooldown"
        value={summary.cooldown > 0 ? String(summary.cooldown) : "None"}
        detail={cooldownDetail(summary)}
        tone={summary.cooldown > 0 ? "orange" : "green"}
        icon={<Clock size={13} />}
      />
    </div>
  );
}

/**
 * One proxy row.
 *
 * Memoized: the list re-renders on selection, testing, and sorting, and each
 * row carries three mutations of its own. Without this every row re-ran those
 * hooks for a change that touched one of them.
 */
const PoolRow = memo(function PoolRow({
  pool,
  isSelected,
  onToggleSelect,
  checkResult,
  isTesting,
  onDelete,
  onEdit,
  onHealthCheck,
  onActivity,
  speedResult,
  isSpeedTesting,
}: {
  readonly pool: NetworkPoolResponse;
  readonly isSelected: boolean;
  readonly onToggleSelect: (id: string) => void;
  readonly checkResult?: HealthCheckResult;
  readonly isTesting: boolean;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (pool: NetworkPoolResponse) => void;
  readonly onHealthCheck: (pool: NetworkPoolResponse) => void;
  readonly onActivity: (pool: NetworkPoolResponse) => void;
  readonly speedResult?: StoredSpeedResult;
  readonly isSpeedTesting: boolean;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const clearCooldown = useClearNetworkPoolCooldown();
  const recoverPool = useRecoverNetworkPool();
  // Read live usage here rather than as a prop: the parent would otherwise have
  // to hand every row a fresh value on each stream tick, which is exactly the
  // re-render this memo exists to avoid. Only rows whose own pool changed
  // actually re-render.
  const live = useContext(PoolUsageContext);
  const usage = live.live ? live.byId.get(pool.id) : undefined;
  const liveInflight = usage?.currentInflight;
  const liveBytes = usage ?? null;
  const display = poolDisplay(pool);
  const poolLabel = poolName(pool);
  const isEnabled = pool.status !== "disabled";
  const proxyFailureLabel = proxyResponseLabel(pool.lastErrorCategory);
  const proxyResponseDisabled = pool.status === "disabled" && proxyFailureLabel !== undefined;
  const lastSuccess = pool.lastSuccessAt ? new Date(pool.lastSuccessAt).getTime() : 0;
  const lastError = pool.lastErrorAt ? new Date(pool.lastErrorAt).getTime() : 0;
  const persistedOk =
    !checkResult && (lastSuccess > 0 || lastError > 0) ? lastSuccess >= lastError : null;
  const checkTone: BadgeTone = isTesting
    ? "default"
    : proxyResponseDisabled
      ? "warn"
      : checkResult
        ? checkResult.status === "healthy"
          ? "ok"
          : checkResult.status === "reachable"
            ? "warn"
            : "err"
        : persistedOk === true
          ? "ok"
          : persistedOk === false
            ? "err"
            : "default";
  const checkTooltip = proxyResponseDisabled
    ? pool.lastError ?? proxyFailureLabel
    : checkResult?.errorMessage ??
      (persistedOk !== null
        ? `last check ${(pool.lastHealthCheckAt ? new Date(pool.lastHealthCheckAt) : new Date()).toLocaleString()}`
        : undefined);
  const latency = poolLatencyMs(pool, checkResult);
  // Live SSE usage wins over the polled snapshot while the stream is up.
  const inflight = liveInflight ?? pool.inflight;
  const load = pool.maxInflight > 0 ? Math.min(1, inflight / pool.maxInflight) : 1;
  const cooldowns = pool.providerCooldowns ?? [];
  const cooldownText = cooldowns
    .slice(0, 2)
    .map(
      (cooldown) =>
        `${cooldown.providerId} until ${new Date(cooldown.until).toLocaleTimeString()}: ${cooldown.reason}`,
    )
    .join(" · ");
  const statusText = isTesting
    ? "Testing…"
    : proxyResponseDisabled
      ? "Proxy reachable"
      : checkResult
        ? checkResult.status === "healthy"
          ? "Connected"
          : checkResult.status === "reachable"
            ? "Proxy reachable"
            : checkResult.status === "timeout"
              ? "Timeout"
              : "Unhealthy"
        : persistedOk === true
          ? "Connected"
          : persistedOk === false
            ? pool.lastErrorCategory === "timeout"
              ? "Timeout"
              : "Unhealthy"
            : "Untested";

  return (
    <tr style={{ opacity: isEnabled ? 1 : 0.6 }}>
      <td style={{ width: "26px" }}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(pool.id)}
          aria-label={`Select ${poolLabel}`}
        />
      </td>
      <td style={{ minWidth: 0, maxWidth: "300px" }}>
        <span
          style={{
            display: "block",
            fontSize: "12.5px",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={poolLabel}
        >
          {poolLabel}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "3px", minWidth: 0 }}>
          {pool.status === "disabled" ? (
            <Badge tone="disabled" title={pool.lastError}>
              Disabled{proxyFailureLabel ? ` · ${proxyFailureLabel}` : ""}
            </Badge>
          ) : (
            <Badge tone={checkTone} title={checkTooltip}>
              {isTesting || latency === undefined ? statusText : `${statusText} · ${latency}ms`}
            </Badge>
          )}
          {cooldowns.length > 0 ? (
            <Badge tone="warn" title={cooldownText}>
              {cooldowns.length} cooldown{cooldowns.length > 1 ? "s" : ""}
            </Badge>
          ) : null}
        </div>
      </td>
      <td style={{ maxWidth: "220px" }}>
        {pool.egressIp ? (
          <span
            style={{
              display: "block",
              fontFamily: "var(--font-mono)",
              fontSize: "11.5px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={`egress ${pool.egressIp} · ${display.endpoint}`}
          >
            {pool.egressIp}
          </span>
        ) : (
          <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }} title="Test the pool to read its egress address">
            not probed
          </span>
        )}
        {(isSpeedTesting || speedResult) && (
          <div style={{ marginTop: "3px" }}>
            <Badge
              tone={isSpeedTesting ? "default" : speedResult?.status === "ok" ? "ok" : "err"}
              title={
                isSpeedTesting
                  ? "Measuring download throughput"
                  : speedResult?.status === "ok"
                    ? `${formatBytes(speedResult.bytes)} in ${speedResult.durationMs}ms${
                        speedResult.measuredAt
                          ? ` · last measured ${new Date(speedResult.measuredAt).toLocaleString()}`
                          : ""
                      }`
                    : `${speedResult?.errorMessage ?? "Speed test failed"}${
                        speedResult?.measuredAt
                          ? ` · last measured ${new Date(speedResult.measuredAt).toLocaleString()}`
                          : ""
                      }`
              }
            >
              {isSpeedTesting
                ? "Speed…"
                : speedResult?.status === "ok"
                  ? `${(speedResult.megabitsPerSecond ?? 0).toFixed(1)} Mbps`
                  : "Speed failed"}
            </Badge>
          </div>
        )}
      </td>
      <td style={{ minWidth: "110px" }}>
        <div
          title={`${inflight}/${pool.maxInflight} inflight`}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <div
            style={{
              flex: 1,
              height: "6px",
              borderRadius: "3px",
              background: "var(--surface-3)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.round(load * 100)}%`,
                height: "100%",
                borderRadius: "3px",
                background: load >= 0.8 ? "var(--orange)" : "var(--green)",
              }}
            />
          </div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10.5px",
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
            }}
          >
            {inflight}/{pool.maxInflight}
          </span>
        </div>
        {(() => {
          // Egress usage against the operator's allowance. Measured at the wire
          // (TLS records included), so it matches what the proxy actually bills.
          const used = (liveBytes?.bytesSent ?? 0) + (liveBytes?.bytesReceived ?? 0);
          const quota = pool.quotaBytes;
          const ratio = quota && quota > 0 ? Math.min(1, used / quota) : 0;
          const over = quota !== undefined && quota > 0 && used > quota;
          return (
            <div
              title={
                quota
                  ? `${formatBytes(used)} of ${formatBytes(quota)} used since this process started`
                  : `${formatBytes(used)} carried since this process started (no quota set)`
              }
              style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}
            >
              <div
                style={{
                  flex: 1,
                  height: "6px",
                  borderRadius: "3px",
                  background: "var(--surface-3)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.round(ratio * 100)}%`,
                    height: "100%",
                    borderRadius: "3px",
                    background: over ? "var(--red)" : ratio >= 0.8 ? "var(--orange)" : "var(--teal)",
                  }}
                />
              </div>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10.5px",
                  color: over ? "var(--red)" : "var(--text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                {formatBytes(used)}
                {quota ? ` / ${formatBytes(quota)}` : ""}
              </span>
            </div>
          );
        })()}
      </td>
      <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
        <Inline gap="4px" justify="end">
          {cooldowns.length > 0 && (
            <Button
              size="icon"
              variant="secondary"
              disabled={clearCooldown.isPending}
              icon={
                clearCooldown.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )
              }
              onClick={() => clearCooldown.mutate({ poolId: pool.id })}
              title={`Clear provider cooldowns — ${cooldownText}`}
              label="Clear"
            />
          )}
          <Button
            size="icon"
            variant="secondary"
            icon={<Activity size={12} />}
            onClick={() => onActivity(pool)}
            title="Health and error activity"
            label="Activity"
          />
          {(pool.status === "cooldown") && (
            <Button
              size="icon"
              variant="secondary"
              disabled={recoverPool.isPending}
              icon={<RotateCcw size={12} className={recoverPool.isPending ? "animate-spin" : ""} />}
              onClick={() => recoverPool.mutate(pool.id)}
              title="Recover pool"
            >
              Recover
            </Button>
          )}
          {!isEnabled && cooldowns.length > 0 ? null : (
            <Button
              size="icon"
              variant="secondary"
              disabled={isTesting}
              icon={
                isTesting ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />
              }
              onClick={() => onHealthCheck(pool)}
              title={checkTooltip ?? "Run health check"}
              label="Test"
            />
          )}
          <Button
            size="icon"
            variant="secondary"
            icon={<Pencil size={12} />}
            onClick={() => onEdit(pool)}
            title="Edit pool"
            label="Edit"
          />
          <Button
            size="icon"
            variant="secondary"
            icon={<Trash2 size={12} />}
            onClick={() => onDelete(pool.id)}
            title="Delete pool"
            label="Delete"
          />
          <Switch
            // Pushed to the far right so the on/off control sits apart from
            // the destructive Delete button beside it.
            style={{ marginLeft: "6px" }}
            checked={isEnabled}
            disabled={updatePool.isPending}
            onChange={(next) =>
              updatePool.mutate({
                poolId: pool.id,
                request: { status: next ? "active" : "disabled" },
              })
            }
          />
        </Inline>
      </td>
    </tr>
  );
});

function PoolHealthDialog({
  pool,
  onClose,
}: {
  readonly pool: NetworkPoolResponse;
  readonly onClose: () => void;
}): ReactNode {
  const query = useNetworkPoolHealthEvents(pool.id);
  const recover = useRecoverNetworkPool();
  const events = query.data ?? [];

  const proxyFailureLabel = proxyResponseLabel(pool.lastErrorCategory);
  const disabledForProxyResponse = pool.status === "disabled" && proxyFailureLabel !== undefined;
  const statusTone: BadgeTone =
    pool.status === "active" ? "ok" : pool.status === "disabled" ? "disabled" : "warn";
  return (
    <Dialog open onClose={onClose} title={`Health & Activity — ${poolName(pool)}`}>
      <Stack gap="14px">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            alignItems: "center",
            gap: "16px",
            padding: "16px",
            borderRadius: "12px",
            border: `1px solid ${disabledForProxyResponse ? "var(--orange)" : "var(--inner-border)"}`,
            background: "var(--surface-2)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                marginBottom: "5px",
                color: "var(--text-tertiary)",
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Proxy health
            </div>
            <div style={{ fontSize: "18px", fontWeight: 700, lineHeight: 1.3 }}>
              {disabledForProxyResponse ? "Proxy reachable" : `Proxy ${pool.status}`}
            </div>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--text-secondary)",
                fontSize: "12px",
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}
            >
              {disabledForProxyResponse
                ? `${proxyFailureLabel} · disabled from routing`
                : pool.lastError ?? "No recent proxy errors."}
            </p>
          </div>
          <Badge tone={statusTone} dot>
            {pool.status}
          </Badge>
        </div>
        {(pool.status === "cooldown") && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              size="sm"
              variant="secondary"
              disabled={recover.isPending}
              onClick={() => recover.mutate(pool.id)}
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
            >
              Recover Now
            </Button>
          </div>
        )}
        {query.isPending ? <LoadingState label="Loading pool activity…" /> : null}
        {query.isError ? <ErrorState message="Failed to load pool activity" onRetry={() => void query.refetch()} /> : null}
        {!query.isPending && !query.isError && events.length === 0 ? (
          <EmptyState title="No pool activity" message="Proxy checks, disable events, and recoveries will appear here." />
        ) : null}
        {events.length > 0 ? (
          <div
            style={{
              display: "grid",
              gap: "8px",
              maxHeight: "380px",
              overflowY: "auto",
              paddingRight: "2px",
            }}
          >
            {events.map((event) => (
              <div
                key={event.id}
                style={{
                  padding: "12px",
                  border: "1px solid var(--inner-border)",
                  borderRadius: "10px",
                  background: "var(--surface-1)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <Inline gap="6px">
                    <Badge
                      tone={
                        event.toStatus === "active"
                          ? "ok"
                          : event.toStatus === "disabled"
                            ? "disabled"
                            : "warn"
                      }
                    >
                      {event.fromStatus ?? "new"} → {event.toStatus}
                    </Badge>
                    {event.errorCategory ? (
                      <Badge tone={event.errorCategory.startsWith("proxy_") ? "warn" : "err"}>
                        {event.errorCategory}
                      </Badge>
                    ) : null}
                  </Inline>
                  <time
                    style={{
                      color: "var(--text-tertiary)",
                      fontSize: "11px",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                </div>
                <p
                  style={{
                    margin: "8px 0 0",
                    color: "var(--text-secondary)",
                    fontSize: "12px",
                    lineHeight: 1.5,
                    overflowWrap: "anywhere",
                  }}
                >
                  {event.reason ?? "No additional details"}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Stack>
    </Dialog>
  );
}

export default function Proxy(): ReactNode {
  const poolsQuery = useNetworkPools();
  const deletePool = useDeleteNetworkPool();
  const updatePool = useUpdateNetworkPool();
  const healthCheck = useHealthCheckNetworkPool();
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [showRelayDeploy, setShowRelayDeploy] = useState(false);
  const [editingPool, setEditingPool] = useState<NetworkPoolResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(new Set());
  const speedTest = useSpeedTestNetworkPool();
  const [speedBytes, setSpeedBytes] = useState(SPEED_TEST_DEFAULT_BYTES);
  // Persisted like `checkResults`: a measurement is expensive to take (it pulls
  // real bytes through the operator's proxy plan) and is still the last known
  // throughput after a reload, so throwing it away on navigation is wasteful.
  const [speedResults, setSpeedResults] = useState<Record<string, StoredSpeedResult>>(() => {
    try {
      const saved = localStorage.getItem("cartethyia_proxy_speed_results");
      return saved ? (JSON.parse(saved) as Record<string, StoredSpeedResult>) : {};
    } catch {
      return {};
    }
  });
  const [speedTestingIds, setSpeedTestingIds] = useState<ReadonlySet<string>>(new Set());
  const rememberSpeedResult = useCallback((poolId: string, result: StoredSpeedResult) => {
    const stamped = { ...result, measuredAt: new Date().toISOString() };
    setSpeedResults((prev) => {
      const next = { ...prev, [poolId]: stamped };
      try {
        localStorage.setItem("cartethyia_proxy_speed_results", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const [checkResults, setCheckResults] = useState<Record<string, HealthCheckResult>>(() => {
    try {
      const saved = localStorage.getItem("cartethyia_proxy_check_results");
      const cached: Record<string, HealthCheckResult> = saved ? JSON.parse(saved) : {};
      return Object.fromEntries(
        Object.entries(cached).map(([poolId, result]) => {
          const errorMessage = result.errorMessage;
          const savedStatus = String(result.status);
          const savedHttpStatus =
            savedStatus === "exhausted"
              ? 402
              : errorMessage?.startsWith("HTTP 402 ")
                ? 402
                : errorMessage?.startsWith("HTTP 407 ")
                  ? 407
                  : undefined;
          const normalized: HealthCheckResult =
            savedHttpStatus === undefined
              ? result
              : {
                  ...result,
                  status: "reachable",
                  httpStatus: savedHttpStatus,
                };
          return [poolId, normalized] as const;
        }),
      );
    } catch {
      return {};
    }
  });
  const [sort, setSort] = useState<{ key: PoolSortKey; direction: "asc" | "desc" }>({
    key: "name",
    direction: "asc",
  });
  const [deleteTargets, setDeleteTargets] = useState<NetworkPoolResponse[] | null>(null);
  const [activityPool, setActivityPool] = useState<NetworkPoolResponse | null>(null);
  const pools = poolsQuery.data ?? [];
  const sortedPools = useMemo(
    () => sortPools(pools, sort.key, sort.direction, (pool) => poolLatencyMs(pool, checkResults[pool.id])),
    [pools, sort, checkResults],
  );
  const toggleSort = useCallback((key: string) => {
    const next = key as PoolSortKey;
    setSort((prev) =>
      prev.key === next
        ? { key: next, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key: next, direction: "asc" },
    );
  }, []);
  const isPending = poolsQuery.isPending;
  const isError = poolsQuery.isError;

  const allSelected = pools.length > 0 && pools.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(pools.map((p) => p.id)));
  };
  // Stable identities: the memoized rows only skip a re-render when the props
  // they receive keep the same reference across the parent's renders.
  const toggleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const testedCount = Object.keys(checkResults).length;
  const successCount = Object.values(checkResults).filter((r) => r.status === "healthy").length;
  const errorCount = Object.values(checkResults).filter((r) => r.status !== "healthy").length;

  const runCheck = useCallback((pool: NetworkPoolResponse) => {
    setTestingIds((prev) => new Set(prev).add(pool.id));
    healthCheck.mutate(pool.id, {
      onSuccess: (result) => {
        setCheckResults((prev) => {
          const next = { ...prev, [pool.id]: result };
          try {
            localStorage.setItem("cartethyia_proxy_check_results", JSON.stringify(next));
          } catch {}
          return next;
        });
        const label = poolName(pool);
        if (result.status === "healthy") {
          toast.success(`${label}: connected`, `${result.latencyMs ?? 0}ms`);
        } else if (result.status === "reachable") {
          toast.error(`${label}: proxy reachable · disabled`, result.errorMessage);
        } else {
          toast.error(
            `${label}: ${result.status === "timeout" ? "timeout" : "unhealthy"}`,
            result.errorMessage,
          );
        }
      },
      onError: (err) => {
        const label = poolName(pool);
        toast.error(`${label}: check failed`, getErrorMessage(err, "Health check failed"));
      },
      onSettled: () => {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(pool.id);
          return next;
        });
      },
    });
  }, [healthCheck]);

  // Batch "Test all" with bounded concurrency (two workers) so the pool
  // endpoints are not flooded and the UI receives one summary update.
  const runAllChecks = async () => {
    const targets = pools;
    if (targets.length === 0) return;
    let healthy = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await healthCheck.mutateAsync(pool.id);
          setCheckResults((prev) => {
            const next = { ...prev, [pool.id]: result };
            try {
              localStorage.setItem("cartethyia_proxy_check_results", JSON.stringify(next));
            } catch {}
            return next;
          });
          if (result.status === "healthy") healthy += 1;
          else failed += 1;
        } catch (err) {
          failed += 1;
          const result: HealthCheckResult = {
            poolId: pool.id,
            status: "timeout",
            errorMessage: getErrorMessage(err, "Health check failed"),
          };
          setCheckResults((prev) => {
            const next = { ...prev, [pool.id]: result };
            try {
              localStorage.setItem("cartethyia_proxy_check_results", JSON.stringify(next));
            } catch {}
            return next;
          });
        } finally {
          setTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
    toast.success(`Tested ${targets.length} pools · ${healthy} healthy · ${failed} failed`);
  };

  // Speed tests run two at a time: each one pulls 5 MB, and a wide fan-out
  // would saturate the operator's own uplink and make every measurement wrong.
  const runSpeedTestSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pool = targets[cursor++];
        if (!pool) return;
        setSpeedTestingIds((prev) => new Set(prev).add(pool.id));
        try {
          const result = await speedTest.mutateAsync({ poolId: pool.id, bytes: speedBytes });
          rememberSpeedResult(pool.id, result);
        } catch (err) {
          rememberSpeedResult(pool.id, {
            poolId: pool.id,
            status: "failed",
            bytes: 0,
            durationMs: 0,
            errorMessage: getErrorMessage(err, "Speed test failed"),
          });
        } finally {
          setSpeedTestingIds((prev) => {
            const next = new Set(prev);
            next.delete(pool.id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
    toast.success(`Speed tested ${targets.length} pool(s)`);
  };

  const enableSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    await Promise.all(
      targets.map((p) => updatePool.mutateAsync({ poolId: p.id, request: { status: "active" } })),
    );
    setSelectedIds(new Set());
    toast.success(`Enabled ${targets.length} pool(s)`);
  };

  const disableSelected = async () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    await Promise.all(
      targets.map((p) => updatePool.mutateAsync({ poolId: p.id, request: { status: "disabled" } })),
    );
    setSelectedIds(new Set());
    toast.success(`Disabled ${targets.length} pool(s)`);
  };

  const exportSelected = () => {
    const targets = selectedIds.size > 0 ? pools.filter((p) => selectedIds.has(p.id)) : pools;
    if (targets.length === 0) return;
    const content = targets.map((p) => poolDisplay(p).endpoint || p.endpoint).join("\n");
    downloadTextFile("cartethyia-proxies.txt", content, "text/plain;charset=utf-8");
    toast.success(`Exported ${targets.length} pool(s)`);
  };

  const requestDeletePool = useCallback(
    (id: string) => {
      const pool = pools.find((p) => p.id === id);
      if (pool) setDeleteTargets([pool]);
    },
    [pools],
  );

  const requestDeleteSelected = () => {
    const targets = pools.filter((p) => selectedIds.has(p.id));
    if (targets.length === 0) return;
    setDeleteTargets(targets);
  };

  const confirmDelete = async () => {
    if (!deleteTargets) return;
    await Promise.all(deleteTargets.map((p) => deletePool.mutateAsync(p.id)));
    setSelectedIds(new Set());
    toast.success(`Deleted ${deleteTargets.length} pool(s)`);
    setDeleteTargets(null);
  };

  return (
    <ProxyLiveProvider>
      <Stack gap="16px">
      <Dialog
        open={showProxyForm}
        onClose={() => setShowProxyForm(false)}
        title="Add Proxy"
      >
        <ProxyBulkForm onClose={() => setShowProxyForm(false)} />
      </Dialog>


      <Dialog
        open={editingPool !== null}
        onClose={() => setEditingPool(null)}
        title="Edit pool"
      >
        {editingPool && (
          <PoolEditForm
            key={editingPool.id}
            pool={editingPool}
            onClose={() => setEditingPool(null)}
          />
        )}
      </Dialog>


      <Card>
        <CardHeader
          title="Proxy Pool"
          subtitle="Outbound proxy servers — HTTP, HTTPS, and SOCKS5"
          icon={<ShieldCheck size={16} />}
          action={
            <Inline gap="8px">
              <Button
                variant="secondary"
                size="sm"
                icon={<Cloud size={13} />}
                onClick={() => setShowRelayDeploy(true)}
              >
                Deploy relay
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setShowProxyForm(true)}
              >
                Add proxies
              </Button>
            </Inline>
          }
        />
        <CardBody>
          <ProxySummaryTiles pools={pools} />

          {/* Selection & Batch Toolbar (Image 2 style) */}
          {pools.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                padding: "8px 12px",
                borderRadius: "10px",
                border: "1px solid var(--inner-border)",
                background: "var(--surface-2)",
                marginBottom: "12px",
                fontSize: "11px",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all proxies"
                  />
                  Select all
                  {selectedIds.size > 0 && (
                    <span style={{ color: "var(--text-tertiary)" }}>({selectedIds.size})</span>
                  )}
                </label>
                {testedCount > 0 && (
                  <Inline gap="6px">
                    <span style={{ color: "var(--text-tertiary)" }}>
                      Tested {testedCount}/{pools.length}
                    </span>
                    {successCount > 0 && <Badge tone="ok">{successCount} success</Badge>}
                    {errorCount > 0 && <Badge tone="err">{errorCount} errors</Badge>}
                  </Inline>
                )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={testingIds.size > 0 || pools.length === 0}
                  icon={
                    testingIds.size > 0 ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <FlaskConical size={12} />
                    )
                  }
                  onClick={() => void runAllChecks()}
                >
                  Test all
                </Button>
                {/* Split control: the primary half runs the test at the
                    currently-selected payload, the chevron half picks the
                    payload. Kept as two elements in one bordered shell so it
                    reads as a single control without a bespoke component. */}
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "stretch",
                    height: "30px",
                  }}
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                    disabled={
                      selectedIds.size === 0 || speedTestingIds.size > 0 || speedTest.isPending
                    }
                    icon={
                      speedTestingIds.size > 0 ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Gauge size={12} />
                      )
                    }
                    onClick={() => void runSpeedTestSelected()}
                  >
                    Speedtest selected
                  </Button>
                  <Select
                    aria-label="Speed test payload size"
                    value={String(speedBytes)}
                    onValueChange={(value) => setSpeedBytes(Number(value))}
                    options={SPEED_TEST_SIZES}
                    disabled={speedTestingIds.size > 0 || speedTest.isPending}
                    style={{
                      width: "auto",
                      minWidth: "76px",
                      height: "30px",
                      borderTopLeftRadius: 0,
                      borderBottomLeftRadius: 0,
                      marginLeft: "-1px",
                    }}
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pools.length === 0}
                  icon={<Download size={12} />}
                  onClick={exportSelected}
                >
                  Export
                </Button>
                <Button
                  size="sm"
                  disabled={selectedIds.size === 0 || updatePool.isPending}
                  icon={<Power size={12} />}
                  onClick={() => void enableSelected()}
                  style={{
                    background: "var(--green-soft)",
                    color: "var(--green)",
                    border: "1px solid color-mix(in srgb, var(--green) 35%, transparent)",
                  }}
                >
                  Enable selected
                </Button>
                <Button
                  size="sm"
                  disabled={selectedIds.size === 0 || updatePool.isPending}
                  icon={<PowerOff size={12} />}
                  onClick={() => void disableSelected()}
                  style={{
                    color: "var(--orange)",
                    border: "1px solid color-mix(in srgb, var(--orange) 35%, transparent)",
                  }}
                >
                  Disable selected
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={selectedIds.size === 0 || deletePool.isPending}
                  icon={<Trash2 size={12} />}
                  onClick={requestDeleteSelected}
                >
                  Delete selected
                </Button>
              </div>
            </div>
          )}

          {isPending && <LoadingState />}
          {isError && <ErrorState title="Error" message="Failed to load network pools" />}
          {!isPending && !isError && pools.length === 0 && (
            <EmptyState
              title="No network pools"
              message="No network pools configured. Create one to route traffic through proxies."
            />
          )}
          {!isPending && !isError && pools.length > 0 && (
            <div className="proxy-table-scroll">
              <DataTable
                maxHeight={460}
                scrollRegion
                headers={[
                  "",
                  { key: "name", label: "Proxy", sortable: true },
                  { key: "address", label: "Address", sortable: true },
                  { key: "load", label: "Load", sortable: true },
                  "Actions",
                ]}
                sortKey={sort.key}
                sortDirection={sort.direction}
                onSort={toggleSort}
              >
                {sortedPools.map((pool) => (
                  <PoolRow
                    key={pool.id}
                    pool={pool}
                    isSelected={selectedIds.has(pool.id)}
                    onToggleSelect={toggleSelectOne}
                    checkResult={checkResults[pool.id]}
                    isTesting={testingIds.has(pool.id)}
                    onDelete={requestDeletePool}
                    onEdit={setEditingPool}
                    onHealthCheck={runCheck}
                    onActivity={setActivityPool}
                    speedResult={speedResults[pool.id]}
                    isSpeedTesting={speedTestingIds.has(pool.id)}
                  />
                ))}
              </DataTable>
            </div>
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={deleteTargets !== null}
        onClose={() => setDeleteTargets(null)}
        onConfirm={confirmDelete}
        title="Delete proxy pool?"
        message={
          deleteTargets && deleteTargets.length === 1
            ? `Delete "${poolName(deleteTargets[0]!)}"? This cannot be undone.`
            : deleteTargets
              ? `Delete ${deleteTargets.length} proxy pools? This cannot be undone.`
              : "Delete this proxy pool? This cannot be undone."
        }
        confirmLabel="Delete"
        danger
      />
      {activityPool ? (
        <PoolHealthDialog pool={activityPool} onClose={() => setActivityPool(null)} />
      ) : null}
      {showRelayDeploy ? <RelayDeployModal onClose={() => setShowRelayDeploy(false)} /> : null}
      </Stack>
    </ProxyLiveProvider>
  );
}

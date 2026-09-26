import {
  Activity,
  Download,
  FlaskConical,
  Gauge,
  Loader2,
  Network,
  Plus,
  Power,
  Pencil,
  PowerOff,
  Repeat,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { DataTable, StatCard } from "../components/ui/layout";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Switch } from "../components/ui/switch";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import type { HealthCheckResult, NetworkPoolResponse, PoolStrategySetting } from "../lib/contracts";
import {
  useCreateNetworkPool,
  useDeleteNetworkPool,
  useHealthCheckNetworkPool,
  useNetworkPoolHealthEvents,
  useNetworkPools,
  useProbeAdHocNetworkPool,
  useRecoverNetworkPool,
  useUpdateNetworkPool,
  useClearNetworkPoolCooldown,
  usePoolStrategy,
  useUpdatePoolStrategy,
} from "../lib/hooks/network";
import { usePoolUsage } from "../lib/hooks/live";
import { summarizePools } from "../lib/proxy-metrics";
import { downloadTextFile } from "../lib/download";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
const transportKinds = ["http", "https", "socks5"] as const;
type TransportKind = (typeof transportKinds)[number];

const POOL_CONFIG_PLACEHOLDERS: Record<TransportKind, string> = {
  http: "{}",
  https: "{}",
  socks5: "{}",
};

/** The same credential shape for every transport kind. */
const CREDENTIAL_LABEL = "Credential (user:pass)";



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
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const handlePaste = async () => {
    try {
      const v = await navigator.clipboard.readText();
      if (v) setText((p) => (p ? `${p}\n${v}` : v));
    } catch {
      toast.error("Paste failed", "Clipboard access denied");
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
        await createPool.mutateAsync({ kind: detectProxyKind(line), endpoint: line });
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
      <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
        {lines.length} line(s) detected
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
      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "4px" }}>
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
    </form>
  );
}

function MultiProtocolForm({ onClose }: { readonly onClose: () => void }): ReactNode {
  const createPool = useCreateNetworkPool();
  const probeAdHoc = useProbeAdHocNetworkPool();
  const [kind, setKind] = useState<TransportKind>("http");
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState("");
  const [configText, setConfigText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const fieldStyle = { width: "100%" };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let config: Record<string, unknown> | undefined;
    if (configText.trim()) {
      try {
        const parsed: unknown = JSON.parse(configText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Config must be a JSON object");
        }
        config = parsed as Record<string, unknown>;
      } catch (err) {
        setError(getErrorMessage(err, "Config must be valid JSON"));
        return;
      }
    }
    if (!endpoint.trim()) {
      setError("Endpoint is required");
      return;
    }
    try {
      await createPool.mutateAsync({
        kind,
        endpoint: endpoint.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
        ...(config ? { config } : {}),
      });
      toast.success("Proxy pool created", `${kind} · ${endpoint.trim()}`);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create pool"));
    }
  };

  const runAdhocTest = async () => {
    if (!endpoint.trim()) {
      setError("Endpoint is required to test");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await probeAdHoc.mutateAsync({
        kind,
        endpoint: endpoint.trim(),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      });
      if (result.status === "reachable") {
        setTestResult({ ok: true, message: result.errorMessage ?? "Proxy reachable" });
      } else {
        setTestResult(
          result.status === "healthy"
            ? { ok: true, message: `Reachable in ${result.latencyMs ?? 0}ms` }
            : { ok: false, message: result.errorMessage ?? "Test probe failed" },
        );
      }
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, "Test probe failed") });
    } finally {
      setTesting(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        <div>
          <Select
            label="Protocol"
            id="pool-kind"
            value={kind}
            onValueChange={(value) => setKind(value as TransportKind)}
            options={transportKinds.map((value) => ({ value, label: value }))}
          />
        </div>
        <div>
          <Input
            label="Name" value={label} onChange={(e) => setLabel(e.target.value)} style={fieldStyle} />
        </div>
      </div>
      <div>
        <Input
          label="Endpoint (host:port or URL)"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="host:port"
          style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
        />
      </div>
      <div>
        <Input
          label={CREDENTIAL_LABEL}
          type="password"
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          placeholder="optional"
          style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
        />
      </div>
      <div>
        <textarea
          aria-label="Config (JSON, optional)"
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          placeholder={POOL_CONFIG_PLACEHOLDERS[kind]}
          rows={7}
          style={{
            width: "100%",
            minHeight: "140px",
            padding: "10px",
            borderRadius: "10px",
            border: "1px solid var(--inner-border)",
            background: "var(--surface-1)",
            color: "var(--text-primary)",
            fontSize: "12px",
            fontFamily: "ui-monospace, monospace",
            resize: "vertical",
          }}
        />
      </div>
      {error && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            fontSize: "11px",
            fontWeight: 600,
            background: "var(--red-soft)",
            color: "var(--red)",
          }}
        >
          {error}
        </div>
      )}
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
      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", marginTop: "4px" }}>
        <Button
          type="button"
          variant="secondary"
          disabled={testing || !endpoint.trim()}
          onClick={runAdhocTest}
        >
          {testing ? "Testing..." : "Test Connection"}
        </Button>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={createPool.isPending}>
            {createPool.isPending ? "Adding..." : "Add proxy pool"}
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


function PoolRow({
  pool,
  liveInflight,
  isSelected,
  onToggleSelect,
  checkResult,
  isTesting,
  onDelete,
  onEdit,
  onHealthCheck,
  onActivity,
}: {
  readonly pool: NetworkPoolResponse;
  readonly liveInflight?: number;
  readonly isSelected: boolean;
  readonly onToggleSelect: (id: string) => void;
  readonly checkResult?: HealthCheckResult;
  readonly isTesting: boolean;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (pool: NetworkPoolResponse) => void;
  readonly onHealthCheck: (id: string) => void;
  readonly onActivity: (pool: NetworkPoolResponse) => void;
}): ReactNode {
  const updatePool = useUpdateNetworkPool();
  const clearCooldown = useClearNetworkPoolCooldown();
  const recoverPool = useRecoverNetworkPool();
  const display = poolDisplay(pool);
  const poolLabel = poolName(pool);
  const isEnabled = pool.status !== "disabled";
  const healthBadgeTone: BadgeTone | undefined =
    pool.status === "cooldown" ? "warn" : undefined;
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
          style={{ width: "13px", height: "13px", cursor: "pointer" }}
        />
      </td>
      <td style={{ minWidth: 0, maxWidth: "300px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
          <span
            style={{
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
          {pool.status === "disabled" ? (
            <Badge tone="disabled" title={pool.lastError}>
              Disabled{proxyFailureLabel ? ` · ${proxyFailureLabel}` : ""}
            </Badge>
          ) : healthBadgeTone ? (
            <Badge tone={healthBadgeTone}>{pool.status}</Badge>
          ) : null}
          {cooldowns.length > 0 ? (
            <Badge tone="warn" title={cooldownText}>
              {cooldowns.length} cooldown{cooldowns.length > 1 ? "s" : ""}
            </Badge>
          ) : null}
        </div>
        <code
          style={{
            display: "block",
            fontSize: "10.5px",
            fontFamily: "var(--font-mono)",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={display.endpoint}
        >
          {display.endpoint}
        </code>
      </td>
      <td>
        <Badge tone="default">{pool.kind}</Badge>
      </td>
      <td>
        <Badge tone={checkTone} title={checkTooltip}>
          {statusText}
        </Badge>
      </td>
      <td style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px", textAlign: "right" }}>
        {isTesting ? "…" : latency !== undefined ? `${latency}ms` : "—"}
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
      </td>
      <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
        <Inline gap="4px" justify="end">
          {cooldowns.length > 0 && (
            <Button
              size="sm"
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
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            icon={<Activity size={12} />}
            onClick={() => onActivity(pool)}
            title="Health and error activity"
          />
          {(pool.status === "cooldown") && (
            <Button
              size="sm"
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
              size="sm"
              variant="secondary"
              disabled={isTesting}
              icon={
                isTesting ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />
              }
              onClick={() => onHealthCheck(pool.id)}
              title={checkTooltip ?? "Run health check"}
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            icon={<Pencil size={12} />}
            onClick={() => onEdit(pool)}
            title="Edit pool"
          />
          <Switch
            checked={isEnabled}
            disabled={updatePool.isPending}
            onChange={(next) =>
              updatePool.mutate({
                poolId: pool.id,
                request: { status: next ? "active" : "disabled" },
              })
            }
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<Trash2 size={12} />}
            onClick={() => onDelete(pool.id)}
            title="Delete pool"
          />
        </Inline>
      </td>
    </tr>
  );
}

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

function PoolStrategyCard(): ReactNode {
  const strategy = usePoolStrategy();
  const updateStrategy = useUpdatePoolStrategy();
  const [rotateDraft, setRotateDraft] = useState<string | null>(null);

  if (strategy.isPending) return <LoadingState label="Loading pool strategy…" />;
  if (strategy.isError || !strategy.data) {
    return (
      <ErrorState
        message={getErrorMessage(strategy.error, "Failed to load pool strategy")}
        onRetry={() => void strategy.refetch()}
      />
    );
  }

  const saved: PoolStrategySetting = strategy.data;
  const isRoundRobin = saved.strategy === "round_robin";
  const shown = rotateDraft ?? String(saved.rotateCount);
  const save = (patch: Partial<PoolStrategySetting>) => {
    updateStrategy.mutate(patch, {
      onError: (err) => toast.error("Failed to update pool strategy", getErrorMessage(err)),
    });
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "8px 12px",
        marginBottom: "12px",
        borderRadius: "10px",
        border: "1px solid var(--inner-border)",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <Repeat size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "12px", fontWeight: 600 }}>Pool Selection</div>
          <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            {isRoundRobin
              ? `Active: round robin · ${saved.rotateCount} request(s) per pool`
              : "Active: least loaded proxy"}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
        {isRoundRobin ? (
          <input
            id="pool-strategy-rotate-count"
            className="form-input"
            type="number"
            min={1}
            max={1000}
            aria-label="Requests per pool before rotating"
            title="Requests per pool before rotating"
            value={shown}
            disabled={updateStrategy.isPending}
            style={{ width: "84px" }}
            onChange={(event) => setRotateDraft(event.target.value)}
            onBlur={() => {
              if (rotateDraft === null) return;
              const parsed = Number.parseInt(rotateDraft, 10);
              setRotateDraft(null);
              if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 && parsed !== saved.rotateCount) {
                save({ rotateCount: parsed });
              }
            }}
          />
        ) : null}
        <Switch
          id="pool-strategy-round-robin"
          label="Round robin"
          checked={isRoundRobin}
          disabled={updateStrategy.isPending}
          onChange={(next) => save({ strategy: next ? "round_robin" : "least_loaded" })}
        />
      </div>
    </div>
  );
}


export default function Proxy(): ReactNode {
  const poolsQuery = useNetworkPools();
  const deletePool = useDeleteNetworkPool();
  const updatePool = useUpdateNetworkPool();
  const healthCheck = useHealthCheckNetworkPool();
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [editingPool, setEditingPool] = useState<NetworkPoolResponse | null>(null);
  const [showMultiForm, setShowMultiForm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(new Set());
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
  const [deleteTargets, setDeleteTargets] = useState<NetworkPoolResponse[] | null>(null);
  const [activityPool, setActivityPool] = useState<NetworkPoolResponse | null>(null);
  const pools = poolsQuery.data ?? [];
  // Live per-pool usage over SSE (push-on-acquire/release). Falls back to the
  // polled `inflight` snapshot while the stream is connecting.
  const poolUsage = usePoolUsage();
  const liveInflightByPool = poolUsage.live && poolUsage.pools !== null
    ? new Map(poolUsage.pools.map((row) => [row.poolId, row.currentInflight] as const))
    : undefined;
  const summary = summarizePools(pools, liveInflightByPool);
  const isPending = poolsQuery.isPending;
  const isError = poolsQuery.isError;

  const allSelected = pools.length > 0 && pools.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(pools.map((p) => p.id)));
  };
  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const testedCount = Object.keys(checkResults).length;
  const successCount = Object.values(checkResults).filter((r) => r.status === "healthy").length;
  const errorCount = Object.values(checkResults).filter((r) => r.status !== "healthy").length;

  const runCheck = (pool: NetworkPoolResponse) => {
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
  };

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

  const requestDeletePool = (id: string) => {
    const pool = pools.find((p) => p.id === id);
    if (pool) setDeleteTargets([pool]);
  };

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
    <Stack gap="16px">
      <Dialog
        open={showProxyForm}
        onClose={() => setShowProxyForm(false)}
        title="Add Proxy"
      >
        <ProxyBulkForm onClose={() => setShowProxyForm(false)} />
      </Dialog>

      <Dialog
        open={showMultiForm}
        onClose={() => setShowMultiForm(false)}
        title="Add proxy pool"
      >
        <MultiProtocolForm onClose={() => setShowMultiForm(false)} />
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
            <Inline gap="8px" style={{ flexWrap: "wrap" }}>
              <Button
                variant="secondary"
                size="sm"
                icon={<Network size={13} />}
                onClick={() => setShowProxyForm(true)}
              >
                Bulk add
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setShowMultiForm(true)}
              >
                Add pool
              </Button>
            </Inline>
          }
        />
        <CardBody>
          <div
            className="metric-grid"
            style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: "14px" }}
          >
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
              label="Cooldown"
              value={String(summary.cooldown)}
              detail={summary.cooldown > 0 ? "provider or pool wait" : "none"}
              tone={summary.cooldown > 0 ? "orange" : "green"}
              icon={<Network size={13} />}
            />
          </div>

          <PoolStrategyCard />

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
                    style={{ width: "13px", height: "13px", cursor: "pointer" }}
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
            <div style={{ maxHeight: "460px", overflow: "auto" }}>
              <DataTable headers={["", "Proxy", "Type", "Status", "Latency", "Load", "Actions"]}>
                {pools.map((pool) => (
                  <PoolRow
                    key={pool.id}
                    pool={pool}
                    liveInflight={liveInflightByPool?.get(pool.id)}
                    isSelected={selectedIds.has(pool.id)}
                    onToggleSelect={toggleSelectOne}
                    checkResult={checkResults[pool.id]}
                    isTesting={testingIds.has(pool.id)}
                    onDelete={requestDeletePool}
                    onEdit={(p) => setEditingPool(p)}
                    onHealthCheck={() => runCheck(pool)}
                    onActivity={setActivityPool}
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
    </Stack>
  );
}

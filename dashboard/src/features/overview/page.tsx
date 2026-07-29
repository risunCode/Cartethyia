import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Cpu,
  Database,
  DollarSign,
  Gauge,
  Globe,
  KeyRound,
  MemoryStick,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, apiGet, apiPost } from "../../lib/api";
import { formatDuration, formatMemoryMb, formatNumber, formatTime, formatTokens, formatUsd } from "../../lib/format";
import { useInFlightStream } from "../../lib/hooks/use-inflight-stream";
import { staggerItem } from "../../lib/motion";
import { Badge, Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";

interface ProviderOverview {
  id: string;
  prefix: string;
  status: "ok" | "warn";
  requestsToday: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  lastError: string | null;
}

interface RtkSettings {
  enabled: boolean;
  minChars: number;
  maxReductionPercent: number;
}

interface OverviewData {
  totals: {
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    errors: number;
    avgDurationMs: number;
    estimatedCostUsd: number;
  };
  providers: ProviderOverview[];
  rtk: RtkSettings;
  registry: string[];
}

interface RuntimeSettings {
  proxyAuthMode: "open" | "api_key";
}

interface SettingsResponse {
  settings: RuntimeSettings;
}

interface HealthMetrics {
  /** This process only — what "Clear RAM usage" affects. */
  memoryUsedMb: number;
  /** Whole machine, every process. */
  memorySystemUsedMb: number;
  memoryTotalMb: number;
  cpuPercent: number;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  active: boolean;
  rateLimitRpm: number | null;
  dailyTokenLimit: number | null;
  providerAllowlist: string[] | null;
  modelAllowlist: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface CreatedKey extends ApiKeyRecord {
  key: string;
  note: string;
}

const STAT_CARDS = [
  { key: "requests", label: "Total Requests", icon: Activity, color: "#0a84ff", format: formatNumber },
  { key: "inputTokens", label: "Input Tokens", icon: ArrowDownToLine, color: "#64d2ff", format: formatTokens },
  { key: "cachedTokens", label: "Cached Tokens", icon: Database, color: "#bf5af2", format: formatTokens },
  { key: "outputTokens", label: "Output Tokens", icon: ArrowUpFromLine, color: "#30d158", format: formatTokens },
  { key: "errors", label: "Errors", icon: TriangleAlert, color: "#ff453a", format: formatNumber },
  { key: "estimatedCostUsd", label: "Est. Cost (24h)", icon: DollarSign, color: "#ffd60a", format: formatUsd },
] as const;

/** Clipboard is undefined on insecure origins — never let that throw. */
async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) {
            toast.error("Clipboard unavailable on this origin");
            return;
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function OverviewPage() {
  const queryClient = useQueryClient();
  const inFlight = useInFlightStream();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [rpm, setRpm] = useState("");
  const [daily, setDaily] = useState("");
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRecord | null>(null);

  const baseUrl = useMemo(() => `${window.location.origin}/v1`, []);

  const ipQuery = useQuery({ queryKey: ["ip"], queryFn: () => apiGet<{ ips: string[] }>("/ip"), staleTime: 60_000 });
  const localIps = ipQuery.data?.ips ?? [];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["overview"],
    queryFn: () => apiGet<OverviewData>("/overview"),
  });

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/settings"),
  });

  const keysQuery = useQuery({
    queryKey: ["keys"],
    queryFn: () => apiGet<{ items: ApiKeyRecord[] }>("/keys"),
  });

  const healthQuery = useQuery({
    queryKey: ["health-metrics"],
    queryFn: () => apiGet<HealthMetrics>("/health/metrics"),
    refetchInterval: 5_000,
  });

  const gcMutation = useMutation({
    mutationFn: () => apiPost<{ before: HealthMetrics; after: HealthMetrics }>("/health/gc", {}),
    onSuccess: ({ before, after }) => {
      const freed = Math.max(0, before.memoryUsedMb - after.memoryUsedMb);
      toast.success(freed > 0 ? `Freed ${freed.toFixed(1)} MB` : "Ran GC — nothing to reclaim right now");
      void queryClient.invalidateQueries({ queryKey: ["health-metrics"] });
    },
    onError: () => toast.error("Failed to run garbage collection"),
  });

  const rtkMutation = useMutation({
    mutationFn: (rtk: RtkSettings) => apiPost<{ ok: boolean }>("/overview/rtk", rtk),
    onSuccess: () => {
      toast.success("RTK settings saved");
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: () => toast.error("Failed to save RTK settings"),
  });

  const authModeMutation = useMutation({
    mutationFn: (proxyAuthMode: RuntimeSettings["proxyAuthMode"]) =>
      apiPost<{ ok: boolean }>("/settings", { proxyAuthMode }),
    onSuccess: (_res, proxyAuthMode) => {
      toast.success(proxyAuthMode === "api_key" ? "API key now required" : "Proxy access is open");
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to update proxy access"),
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string; rateLimitRpm?: number; dailyTokenLimit?: number }) =>
      apiPost<CreatedKey>("/keys", input),
    onSuccess: (created) => {
      setRevealed(created);
      setCreateOpen(false);
      setName("");
      setRpm("");
      setDaily("");
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to create key"),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ ok: boolean }>(`/keys/${id}/revoke`, {}),
    onSuccess: () => {
      toast.success("Key revoked");
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to revoke key"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/keys/${id}`, { method: "DELETE", body: "{}" }),
    onSuccess: () => {
      toast.success("Key deleted permanently");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to delete key"),
  });

  const submitCreate = () => {
    const input: { name: string; rateLimitRpm?: number; dailyTokenLimit?: number } = { name: name.trim() };
    if (rpm.trim()) {
      const parsed = Number(rpm);
      if (Number.isFinite(parsed) && parsed > 0) input.rateLimitRpm = Math.floor(parsed);
    }
    if (daily.trim()) {
      const parsed = Number(daily);
      if (Number.isFinite(parsed) && parsed > 0) input.dailyTokenLimit = Math.floor(parsed);
    }
    createMutation.mutate(input);
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-5">
        {STAT_CARDS.map((card) => (
          <Skeleton key={card.key} className="h-28 rounded-[var(--radius-card)]" />
        ))}
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Card className="text-center">
        <p className="py-8 text-sm text-[var(--text-2)]">Failed to load overview.</p>
        <Button variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const { totals, rtk } = data;
  const errorRate = totals.requests > 0 ? ((totals.errors / totals.requests) * 100).toFixed(1) : "0.0";
  const cacheRate = totals.inputTokens > 0 ? Math.round((totals.cachedTokens / totals.inputTokens) * 100) : 0;

  const runtime = settingsQuery.data?.settings;
  const requireKey = runtime?.proxyAuthMode === "api_key";
  const keys = keysQuery.data?.items ?? [];

  return (
    <>
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_CARDS.map((card) => (
          <Card key={card.key} className="flex items-center gap-3 p-3.5">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: `color-mix(in srgb, ${card.color} 15%, transparent)`, color: card.color }}
            >
              <card.icon size={17} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate text-[11px] text-[var(--text-3)]">
                {card.label}
                {card.key === "requests" && inFlight > 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]">
                    <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" />+{inFlight} in flight
                  </span>
                )}
              </div>
              <div className="text-base font-bold tabular-nums">{card.format(totals[card.key])}</div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="API Endpoint" icon={Globe} sub="Base URL for OpenAI- and Anthropic-compatible clients" />
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge tone="default">Local</Badge>
          <code className="rounded-md bg-[var(--kbd-bg)] px-2 py-1 font-mono text-[12px] text-[var(--text-1)]">
            {baseUrl}
          </code>
          {localIps.length > 0 && (
            <span className="text-[11px] text-[var(--text-3)]">({localIps.join(", ")})</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              void copyText(baseUrl).then((ok) => {
                if (ok) toast.success("Copied");
                else toast.error("Clipboard unavailable on this origin");
              });
            }}
          >
            <Copy size={13} /> Copy
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Health" icon={Gauge} iconColor="#30d158" sub="Last 24 hours · process resource usage">
          <Button variant="secondary" size="sm" disabled={gcMutation.isPending} onClick={() => gcMutation.mutate()}>
            <Sparkles size={13} /> {gcMutation.isPending ? "Clearing…" : "Clear RAM usage"}
          </Button>
        </CardHeader>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-2)]">Avg duration</span>
            <span className="font-semibold tabular-nums">{formatDuration(totals.avgDurationMs)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-2)]">Cache rate</span>
            <span className="font-semibold tabular-nums">{cacheRate}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-2)]">Error rate</span>
            <span className="font-semibold tabular-nums">{errorRate}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[var(--text-2)]">Providers</span>
            <span className="font-semibold tabular-nums">{data.registry.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[var(--text-2)]"><MemoryStick size={13} /> RAM — global</span>
<span className="font-semibold tabular-nums">
              {healthQuery.data ? `${formatMemoryMb(healthQuery.data.memorySystemUsedMb)} used / ${formatMemoryMb(healthQuery.data.memoryTotalMb)} total` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[var(--text-2)]"><MemoryStick size={13} /> RAM — this program</span>
<span className="font-semibold tabular-nums">
              {healthQuery.data ? formatMemoryMb(healthQuery.data.memoryUsedMb) : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
<span className="flex items-center gap-1.5 text-[var(--text-2)]"><Cpu size={13} /> CPU — this program</span>
            <span className="font-semibold tabular-nums">{healthQuery.data ? `${healthQuery.data.cpuPercent.toFixed(1)}%` : "—"}</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="RTK — Response Token Killer" icon={Scissors} iconColor="#bf5af2" sub="Compress long tool results before they hit upstream context" />
        <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={rtk.enabled}
              label="Enable RTK"
              onChange={(enabled) => rtkMutation.mutate({ ...rtk, enabled })}
            />
            <span className="text-sm font-medium">{rtk.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div>
            <Label htmlFor="rtk-min">Min chars</Label>
            <Input
              id="rtk-min"
              type="number"
              min={0}
              value={rtk.minChars}
              onChange={(e) => rtkMutation.mutate({ ...rtk, minChars: Number(e.target.value) || 0 })}
            />
          </div>
          <div>
            <Label htmlFor="rtk-max">Max reduction %</Label>
            <Input
              id="rtk-max"
              type="number"
              min={1}
              max={90}
              value={rtk.maxReductionPercent}
              onChange={(e) => rtkMutation.mutate({ ...rtk, maxReductionPercent: Number(e.target.value) || 35 })}
            />
          </div>
          <p className="text-xs text-[var(--text-3)]">Applied live to outbound transforms — no restart needed.</p>
        </div>
      </Card>

      <Card>
        <CardHeader title="API Keys" icon={KeyRound} iconColor="#ff9f0a" sub="Client keys for proxy access — stored hashed, revealed once on create">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New key
          </Button>
        </CardHeader>

        <div className="mb-4 flex items-center justify-between gap-3 rounded-[15px] border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3">
          <div>
            <div className="text-[13px] font-semibold">Require API key</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-3)]">Requests without a valid key will be rejected</div>
          </div>
          <Switch
            checked={requireKey}
            label="Require API key"
            disabled={!runtime || authModeMutation.isPending}
            onChange={(on) => authModeMutation.mutate(on ? "api_key" : "open")}
          />
        </div>

        <div className="overflow-x-auto rounded-[15px] border border-[var(--inner-border)]">
          <table className="w-full min-w-[480px] text-left text-xs">
            <thead className="border-b border-[var(--inner-border)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-3 py-2.5">Prefix</th>
                <th className="px-3 py-2.5">Limits</th>
                <th className="px-3 py-2.5">Last used</th>
                <th className="px-3 py-2.5">Created</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--inner-border)]">
              {keysQuery.isLoading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--text-3)]">Loading…</td></tr>
              ) : keys.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--text-3)]">No keys yet — create one to enforce proxy authentication.</td></tr>
              ) : (
                keys.map((key, index) => (
                  <motion.tr key={key.id} {...staggerItem(index)} className="transition-colors hover:bg-[var(--hover)]">
                    <td className="px-4 py-2.5 font-semibold">{key.name}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--text-2)]">{key.keyPrefix}…</td>
                    <td className="px-3 py-2.5 text-[var(--text-2)]">
                      {key.rateLimitRpm ? `${key.rateLimitRpm} rpm` : "—"}{key.dailyTokenLimit ? ` · ${(key.dailyTokenLimit / 1000).toFixed(0)}K/day` : ""}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--text-2)]">{formatTime(key.lastUsedAt)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-2)]">{formatTime(key.createdAt)}</td>
                    <td className="px-3 py-2.5"><Badge tone={key.active ? "ok" : "default"}>{key.active ? "active" : "revoked"}</Badge></td>
                    <td className="px-3 py-2.5 text-right">
                      {key.active ? (
                        <Button variant="ghost" size="sm" className="text-[#ff453a]" onClick={() => setRevokeTarget(key)}><Trash2 size={13} /> Revoke</Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="text-[#ff453a]" onClick={() => setDeleteTarget(key)}><Trash2 size={13} /> Delete</Button>
                      )}
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API Key"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={name.trim().length < 2 || createMutation.isPending} onClick={submitCreate}>
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-key" disabled={createMutation.isPending} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Max RPM (optional)</Label>
              <Input type="number" min={1} value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="60" disabled={createMutation.isPending} />
            </div>
            <div>
              <Label>Daily Token Limit (optional)</Label>
              <Input type="number" min={1} value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="1000000" disabled={createMutation.isPending} />
            </div>
          </div>
        </div>
      </Dialog>

      {revealed && (
        <Dialog open={true} onClose={() => setRevealed(null)} title="New API Key Created" wide>
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-2)]">{revealed.note || "Store this key safely. It will not be shown again."}</p>
            <div className="rounded-xl border border-[var(--inner-border)] bg-white/[.03] p-4">
              <div className="font-mono text-sm break-all text-[#0ea5e9]">{revealed.key}</div>
            </div>
            <CopyButton value={revealed.key} />
          </div>
        </Dialog>
      )}

      <ConfirmDialog open={!!revokeTarget} onClose={() => setRevokeTarget(null)} onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)} title="Revoke API Key" message={`Revoke "${revokeTarget?.name}"? This cannot be undone.`} danger confirmLabel="Revoke" />
      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} title="Delete API Key" message={`Permanently delete "${deleteTarget?.name}"? This removes the key from the database entirely.`} danger confirmLabel="Delete" />
    </>
  );
}

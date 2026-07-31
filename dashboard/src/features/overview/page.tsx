import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Activity,
  Check,
  Copy,
  Cpu,
  Database,
  Gauge,
  Globe,
  KeyRound,
  MemoryStick,
  Pencil,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiGet, apiPatch, apiPost, apiDelete } from "../../lib/api";
import { formatDuration, formatMemoryMb, formatTime } from "../../lib/format";
import { staggerClass } from "../../lib/motion";
import { Badge, Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";
import { ModelPickerField } from "../../components/model-picker";

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
  memoryUsedMb: number;
  memorySystemUsedMb: number;
  memoryTotalMb: number;
  cpuPercent: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  coreCount: number;
  cpuModel: string;
  pid: number;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  active: boolean;
  rateLimitRpm: number | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  maxConcurrentRequests: number | null;
  providerAllowlist: string[] | null;
  modelAllowlist: string[] | null;
  modelDenylist: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

type KeyUpdatePatch = {
  rateLimitRpm?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  maxConcurrentRequests?: number | null;
  providerAllowlist?: string[] | null;
  modelAllowlist?: string[] | null;
  modelDenylist?: string[] | null;
};

type KeyLimitsInput = {
  rateLimitRpm?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  maxConcurrentRequests?: number;
  providerAllowlist?: string[];
  modelAllowlist?: string[];
  modelDenylist?: string[];
};

function parseOptionalLimit(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeList(values: string[]): string[] | undefined {
  const items = [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

function buildKeyLimitsInput(rpm: string, daily: string, monthly: string, concurrent: string, allowed: string[]): KeyLimitsInput {
  const input: KeyLimitsInput = {};
  const rateLimitRpm = parseOptionalLimit(rpm);
  const dailyTokenLimit = parseOptionalLimit(daily);
  const monthlyTokenLimit = parseOptionalLimit(monthly);
  const maxConcurrentRequests = parseOptionalLimit(concurrent);
  // Auto-detect: entries without "/" are providers, with "/" are models.
  const allAllowed = normalizeList(allowed);
  const providerAllowlist = allAllowed ? allAllowed.filter((e) => !e.includes("/")) : undefined;
  const modelAllowlist = allAllowed ? allAllowed.filter((e) => e.includes("/")) : undefined;
  if (rateLimitRpm) input.rateLimitRpm = rateLimitRpm;
  if (dailyTokenLimit) input.dailyTokenLimit = dailyTokenLimit;
  if (monthlyTokenLimit) input.monthlyTokenLimit = monthlyTokenLimit;
  if (maxConcurrentRequests) input.maxConcurrentRequests = maxConcurrentRequests;
  if (providerAllowlist?.length) input.providerAllowlist = providerAllowlist;
  if (modelAllowlist?.length) input.modelAllowlist = modelAllowlist;
  return input;
}

function formatKeyLimits(key: ApiKeyRecord): string {
  const parts: string[] = [];
  if (key.rateLimitRpm) parts.push(`${key.rateLimitRpm} rpm`);
  if (key.dailyTokenLimit) parts.push(`${(key.dailyTokenLimit / 1000).toFixed(0)}K/day`);
  if (key.monthlyTokenLimit) parts.push(`${(key.monthlyTokenLimit / 1000).toFixed(0)}K/mo`);
  if (key.maxConcurrentRequests) parts.push(`${key.maxConcurrentRequests} concurrent`);
  if (key.modelAllowlist?.length) parts.push(`${key.modelAllowlist.length} allowed`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

interface CreatedKey extends ApiKeyRecord {
  key: string;
  note: string;
}

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

function KeyLimitsFields({
  rpm,
  daily,
  monthly,
  concurrent,
  allowed,
  setRpm,
  setDaily,
  setMonthly,
  setConcurrent,
  setAllowed,
  disabled,
}: {
  rpm: string;
  daily: string;
  monthly: string;
  concurrent: string;
  allowed: string[];
  setRpm: (value: string) => void;
  setDaily: (value: string) => void;
  setMonthly: (value: string) => void;
  setConcurrent: (value: string) => void;
  setAllowed: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Max RPM (optional)</Label>
          <Input type="number" min={1} value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="60" disabled={disabled} />
        </div>
        <div>
          <Label>Max concurrent (optional)</Label>
          <Input type="number" min={1} value={concurrent} onChange={(e) => setConcurrent(e.target.value)} placeholder="10" disabled={disabled} />
        </div>
        <div>
          <Label>Daily token limit (optional)</Label>
          <Input type="number" min={1} value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="1000000" disabled={disabled} />
        </div>
        <div>
          <Label>Monthly token limit (optional)</Label>
          <Input type="number" min={1} value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="30000000" disabled={disabled} />
        </div>
      </div>
      <ModelPickerField label="Allowed (optional)" values={allowed} onChange={setAllowed} mode="models" manualPlaceholder="e.g. kimchi or kimchi/kimi-k2.7" disabled={disabled} />
      <p className="text-xs text-[var(--text-3)]">Empty = all models allowed. Add providers (no slash) or models (with slash) to restrict.</p>
    </>
  );
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
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyRecord | null>(null);
  const [name, setName] = useState("");
  const [rpm, setRpm] = useState("");
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  const [concurrent, setConcurrent] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRecord | null>(null);

  const resetKeyForm = () => {
    setName("");
    setRpm("");
    setDaily("");
    setMonthly("");
    setConcurrent("");
    setAllowed([]);
  };

  const openEdit = (key: ApiKeyRecord) => {
    setEditTarget(key);
    setRpm(key.rateLimitRpm ? String(key.rateLimitRpm) : "");
    setDaily(key.dailyTokenLimit ? String(key.dailyTokenLimit) : "");
    setMonthly(key.monthlyTokenLimit ? String(key.monthlyTokenLimit) : "");
    setConcurrent(key.maxConcurrentRequests ? String(key.maxConcurrentRequests) : "");
    setAllowed([...(key.providerAllowlist ?? []), ...(key.modelAllowlist ?? [])]);
  };

  const closeEdit = () => {
    setEditTarget(null);
    resetKeyForm();
  };

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
    mutationFn: (input: { name: string } & KeyLimitsInput) => apiPost<CreatedKey>("/keys", input),
    onSuccess: (created) => {
      setRevealed(created);
      setCreateOpen(false);
      resetKeyForm();
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to create key"),
  });

  const editMutation = useMutation({
    mutationFn: (input: { id: string; patch: KeyUpdatePatch }) => apiPatch<ApiKeyRecord>(`/keys/${input.id}`, input.patch),
    onSuccess: () => {
      toast.success("Key updated");
      closeEdit();
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to update key"),
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
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/keys/${id}`),
    onSuccess: () => {
      toast.success("Key deleted permanently");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to delete key"),
  });

  const credentialCopy = useMutation({
    mutationFn: async (keyId: string) => {
      const { key } = await apiGet<{ key: string }>(`/keys/${keyId}/credential`);
      const ok = await copyText(key);
      if (!ok) throw new Error("Clipboard unavailable on this origin");
    },
    onSuccess: () => toast.success("Copied API key to clipboard"),
    onError: (err) => toast.error(err instanceof Error ? err.message : "failed to copy key"),
  });

  const submitCreate = () => {
    createMutation.mutate({ name: name.trim(), ...buildKeyLimitsInput(rpm, daily, monthly, concurrent, allowed) });
  };

  const submitEdit = () => {
    if (!editTarget) return;
    const limits = buildKeyLimitsInput(rpm, daily, monthly, concurrent, allowed);
    editMutation.mutate({
      id: editTarget.id,
      patch: {
        rateLimitRpm: limits.rateLimitRpm ?? null,
        dailyTokenLimit: limits.dailyTokenLimit ?? null,
        monthlyTokenLimit: limits.monthlyTokenLimit ?? null,
        maxConcurrentRequests: limits.maxConcurrentRequests ?? null,
        providerAllowlist: limits.providerAllowlist ?? null,
        modelAllowlist: limits.modelAllowlist ?? null,
      },
    });
  };

  if (isLoading) {
    return (
      <Card>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-4 h-24 w-full" />
      </Card>
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
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]"><Activity size={14} /></span>
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Latency</span>
            </div>
            <div className="text-lg font-bold tabular-nums">{formatDuration(totals.avgDurationMs)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-2)]">Avg duration</div>
          </div>
          <div className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-[rgba(191,90,242,0.13)] text-[#bf5af2]"><Database size={14} /></span>
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Cache</span>
            </div>
            <div className="text-lg font-bold tabular-nums">{cacheRate}%</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-2)]">Cache rate</div>
          </div>
          <div className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-[rgba(255,69,58,0.13)] text-[var(--red)]"><TriangleAlert size={14} /></span>
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Errors</span>
            </div>
            <div className="text-lg font-bold tabular-nums">{errorRate}%</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-2)]">Error rate</div>
          </div>
          <div className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-[rgba(48,209,88,0.13)] text-[#30d158]"><Globe size={14} /></span>
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Registry</span>
            </div>
            <div className="text-lg font-bold tabular-nums">{data.registry.length}</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-2)]">Providers</div>
          </div>
          <div className="col-span-2 grid grid-cols-1 overflow-hidden rounded-[14px] border border-[var(--inner-border)] sm:col-span-4 sm:grid-cols-2">
            {/* RAM — left */}
            <div className="border-b border-[var(--inner-border)] bg-[var(--hover)] p-3 sm:border-b-0 sm:border-r">
              <div className="mb-2 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-[rgba(191,90,242,0.13)] text-[#bf5af2]"><MemoryStick size={14} /></span>
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">RAM</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold tabular-nums">{healthQuery.data ? formatMemoryMb(healthQuery.data.memoryUsedMb) : "—"}</span>
                <span className="text-[10.5px] text-[var(--text-3)]">RSS</span>
              </div>
              <div className="mb-2 text-[10.5px] text-[var(--text-2)]">
                {healthQuery.data ? `${formatMemoryMb(healthQuery.data.memorySystemUsedMb)} / ${formatMemoryMb(healthQuery.data.memoryTotalMb)} system` : ""}
              </div>
              {healthQuery.data && (() => {
                const d = healthQuery.data;
                const nativeMb = Math.max(0, d.memoryUsedMb - d.heapTotalMb - d.externalMb - d.arrayBuffersMb);
                const rss = d.memoryUsedMb;
                return (
                  <div className="space-y-1">
                    {([
                      { label: "JS heap", used: d.heapUsedMb, bar: d.heapTotalMb, color: "#bf5af2" },
                      { label: "Native/JIT", used: nativeMb, bar: nativeMb, color: "#30d158" },
                      { label: "External", used: d.externalMb, bar: d.externalMb, color: "#ff9f0a" },
                      { label: "ArrayBuf", used: d.arrayBuffersMb, bar: d.arrayBuffersMb, color: "#0a84ff" },
                    ] as const).map(({ label, used, bar, color }) => (
                      <div key={label}>
                        <div className="mb-0.5 flex justify-between text-[9.5px] text-[var(--text-3)]">
                          <span>{label}</span>
                          <span className="tabular-nums">{formatMemoryMb(used)}</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-[var(--track)]">
                          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, (bar / rss) * 100)}%`, background: color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            {/* CPU — right */}
            <div className="bg-[var(--hover)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-[rgba(255,159,10,0.14)] text-[#ff9f0a]"><Cpu size={14} /></span>
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">CPU</span>
              </div>
              <div className="text-lg font-bold tabular-nums">{healthQuery.data ? `${healthQuery.data.cpuPercent.toFixed(1)}%` : "—"}</div>
              <div className="mt-0.5 text-[10.5px] text-[var(--text-2)]">this process</div>
              {healthQuery.data && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-[9.5px]">
                    <span className="text-[var(--text-3)]">Cores</span>
                    <span className="font-semibold tabular-nums text-[var(--text-1)]">{healthQuery.data.coreCount} logical</span>
                  </div>
                  <div className="flex items-center justify-between text-[9.5px]">
                    <span className="text-[var(--text-3)]">PID</span>
                    <span className="font-mono font-semibold text-[var(--text-1)]">{healthQuery.data.pid}</span>
                  </div>
                  <div className="mt-1 truncate text-[9px] text-[var(--text-3)]" title={healthQuery.data.cpuModel}>{healthQuery.data.cpuModel}</div>
                </div>
              )}
            </div>
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
        <CardHeader title="API Keys" icon={KeyRound} iconColor="#ff9f0a" sub="Client keys for proxy access — stored as plaintext; revealed on demand via dedicated endpoint">
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
                  <tr key={key.id} {...staggerClass(index)} className="transition-colors hover:bg-[var(--hover)]">
                    <td className="max-w-[200px] truncate px-4 py-2.5 font-semibold">{key.name}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--text-2)]">{key.keyPrefix}…</td>
                    <td className="max-w-[200px] truncate px-3 py-2.5 text-[var(--text-2)]">{formatKeyLimits(key)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-2)]">{formatTime(key.lastUsedAt)}</td>
                    <td className="px-3 py-2.5 text-[var(--text-2)]">{formatTime(key.createdAt)}</td>
                    <td className="px-3 py-2.5"><Badge tone={key.active ? "ok" : "default"}>{key.active ? "active" : "revoked"}</Badge></td>
                    <td className="px-3 py-2.5 text-right">
                      {key.active ? (
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={credentialCopy.isPending}
                            onClick={() => credentialCopy.mutate(key.id)}
                            title="Copy API key"
                            aria-label={`Copy API key ${key.name}`}
                          >
                            <Copy size={13} />
                            Copy
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(key)} title="Edit limits and ACL">
                            <Pencil size={13} />
                            Edit
                          </Button>
                          <Button variant="ghost" size="sm" className="text-[#ff453a]" onClick={() => setRevokeTarget(key)}><Trash2 size={13} /> Revoke</Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" className="text-[#ff453a]" onClick={() => setDeleteTarget(key)}><Trash2 size={13} /> Delete</Button>
                      )}
                    </td>
                  </tr>
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
          <KeyLimitsFields
            rpm={rpm}
            daily={daily}
            monthly={monthly}
            concurrent={concurrent}
            allowed={allowed}
            setRpm={setRpm}
            setDaily={setDaily}
            setMonthly={setMonthly}
            setConcurrent={setConcurrent}
            setAllowed={setAllowed}
            disabled={createMutation.isPending}
          />
        </div>
      </Dialog>

      <Dialog
        open={!!editTarget}
        onClose={closeEdit}
        title={editTarget ? `Edit API Key — ${editTarget.name}` : "Edit API Key"}
        wide
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={closeEdit}>
              Cancel
            </Button>
            <Button size="sm" disabled={!editTarget || editMutation.isPending} onClick={submitEdit}>
              {editMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <KeyLimitsFields
            rpm={rpm}
            daily={daily}
            monthly={monthly}
            concurrent={concurrent}
            allowed={allowed}
            setRpm={setRpm}
            setDaily={setDaily}
            setMonthly={setMonthly}
            setConcurrent={setConcurrent}
            setAllowed={setAllowed}
            disabled={editMutation.isPending}
          />
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

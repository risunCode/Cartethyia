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
  MapPin,
  Network,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../lib/toast";
import { ApiError, apiGet, apiPatch, apiPost, apiDelete } from "../../lib/api";
import { formatBandwidthKb, formatDuration, formatMemoryMb, formatTime, formatTokens } from "../../lib/format";
import { staggerClass } from "../../lib/motion";
import { qk } from "../../lib/query-keys";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { StatCard, StatePanel } from "../../components/ui/state";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";
import { ModelPickerField, useProviders } from "../../components/model-picker";

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
  registered: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates and normalizes the current console overview response shape. */
export function parseOverviewData(value: unknown): OverviewData | null {
  if (!isRecord(value) || !Array.isArray(value.registered) || !value.registered.every((item) => typeof item === "string") || !Array.isArray(value.providers) || !isRecord(value.totals)) return null;
  const totals = value.totals;
  const totalKeys: (keyof OverviewData["totals"])[] = ["requests", "inputTokens", "cachedTokens", "outputTokens", "errors"];
  if (!totalKeys.every((key) => isFiniteNumber(totals[key]))) return null;
  const requests = totals.requests;
  const inputTokens = totals.inputTokens;
  const cachedTokens = totals.cachedTokens;
  const outputTokens = totals.outputTokens;
  const errors = totals.errors;
  const avgDurationMs = isFiniteNumber(totals.avgDurationMs) ? totals.avgDurationMs : 0;
  const estimatedCostUsd = isFiniteNumber(totals.estimatedCostUsd) ? totals.estimatedCostUsd : 0;
  if (!isFiniteNumber(requests) || !isFiniteNumber(inputTokens) || !isFiniteNumber(cachedTokens) || !isFiniteNumber(outputTokens) || !isFiniteNumber(errors)) return null;
  const providers: ProviderOverview[] = [];
  for (const item of value.providers) {
    if (!isRecord(item) || typeof item.providerId !== "string" || !isFiniteNumber(item.requests) || !isFiniteNumber(item.inputTokens) || !isFiniteNumber(item.cachedTokens) || !isFiniteNumber(item.outputTokens) || !isFiniteNumber(item.errors)) return null;
    providers.push({ id: item.providerId, prefix: item.providerId, status: item.errors > 0 ? "warn" : "ok", requestsToday: item.requests, input: item.inputTokens, cached: item.cachedTokens, output: item.outputTokens, errors: item.errors, lastError: null });
  }
  return {
    totals: {
      requests,
      inputTokens,
      cachedTokens,
      outputTokens,
      errors,
      avgDurationMs,
      estimatedCostUsd,
    },
    providers,
    registered: value.registered,
  };
}

interface RuntimeSettings {
  proxyAuthMode: "open" | "api_key";
}

interface SettingsResponse {
  settings: {
    runtime: RuntimeSettings;
  };
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
  netReceivedKb: number | null;
  netSentKb: number | null;
  netTotalKb: number | null;
  netRateKbps: number | null;
}

interface WarpMetricsSummary {
  totalRssMb: number;
  totalRxMb: number;
  totalTxMb: number;
  totalBandwidthMb: number;
  runningCount: number;
  healthyCount: number;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  active: boolean;
  rateLimitRpm: number | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  oneTimeTokenLimit: number | null;
  oneTimeTokensUsed: number;
  maxConcurrentRequests: number | null;
  providerAllowlist: string[] | null;
  modelAllowlist: string[] | null;
  modelDenylist: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** Tokens (input+output) this key has used today / all-time, from in-memory usage history. */
  todayTokens: number;
  totalTokens: number;
  oneTimeTokensRemaining: number | null;
}

type KeyUpdatePatch = {
  key?: string;
  rateLimitRpm?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  oneTimeTokenLimit?: number | null;
  maxConcurrentRequests?: number | null;
  active?: boolean;
  providerAllowlist?: string[] | null;
  modelAllowlist?: string[] | null;
  modelDenylist?: string[] | null;
};

type KeyLimitsInput = {
  key?: string;
  rateLimitRpm?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  oneTimeTokenLimit?: number;
  maxConcurrentRequests?: number;
  providerAllowlist?: string[];
  modelAllowlist?: string[];
  modelDenylist?: string[];
};

const TOKEN_PRESETS = [
  { label: "1M", value: 1_000_000 },
  { label: "10M", value: 10_000_000 },
  { label: "100M", value: 100_000_000 },
  { label: "1B", value: 1_000_000_000 },
  { label: "1T", value: 1_000_000_000_000 },
] as const;

type TokenBudgetMode = "recurring" | "one-time";

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

export function buildKeyLimitsInput(
  rpm: string,
  daily: string,
  monthly: string,
  concurrent: string,
  allowed: string[],
  providerIds: Set<string>,
  oneTime = "",
  budgetMode: TokenBudgetMode = "recurring",
): KeyLimitsInput {
  const input: KeyLimitsInput = {};
  const rateLimitRpm = parseOptionalLimit(rpm);
  const dailyTokenLimit = parseOptionalLimit(daily);
  const monthlyTokenLimit = parseOptionalLimit(monthly);
  const oneTimeTokenLimit = parseOptionalLimit(oneTime);
  const maxConcurrentRequests = parseOptionalLimit(concurrent);
  // Auto-detect: a bare (no "/") entry is a provider ACL entry only when it's
  // an actual registered provider id. A bare alias or combo name (also no
  // "/") is NOT a provider - it used to be misclassified into
  // providerAllowlist here, which silently broke its ACL (a qualified
  // request never matches a provider id that's really an alias name, and a
  // bare alias request skips the providerAllowlist check entirely since it
  // has no provider prefix to check against - modelAllowlist is the only
  // list that gates it correctly).
  const allAllowed = normalizeList(allowed);
  const providerAllowlist = allAllowed ? allAllowed.filter((e) => !e.includes("/") && providerIds.has(e)) : undefined;
  const modelAllowlist = allAllowed ? allAllowed.filter((e) => e.includes("/") || !providerIds.has(e)) : undefined;
  if (rateLimitRpm) input.rateLimitRpm = rateLimitRpm;
  if (budgetMode === "one-time") {
    if (oneTimeTokenLimit) input.oneTimeTokenLimit = oneTimeTokenLimit;
  } else {
    if (dailyTokenLimit) input.dailyTokenLimit = dailyTokenLimit;
    if (monthlyTokenLimit) input.monthlyTokenLimit = monthlyTokenLimit;
  }
  if (maxConcurrentRequests) input.maxConcurrentRequests = maxConcurrentRequests;
  if (providerAllowlist?.length) input.providerAllowlist = providerAllowlist;
  if (modelAllowlist?.length) input.modelAllowlist = modelAllowlist;
  return input;
}

function formatKeyLimits(key: ApiKeyRecord): string {
  const parts: string[] = [];
  if (key.rateLimitRpm) parts.push(`${key.rateLimitRpm} rpm`);
  if (key.dailyTokenLimit) parts.push(`${formatTokens(key.dailyTokenLimit)}/day`);
  if (key.monthlyTokenLimit) parts.push(`${formatTokens(key.monthlyTokenLimit)}/mo`);
  if (key.oneTimeTokenLimit) parts.push(`${formatTokens(key.oneTimeTokensRemaining ?? key.oneTimeTokenLimit)} remaining once`);
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
  oneTime,
  budgetMode,
  concurrent,
  allowed,
  setRpm,
  setDaily,
  setMonthly,
  setOneTime,
  setConcurrent,
  setAllowed,
  onBudgetModeChange,
  disabled,
}: {
  rpm: string;
  daily: string;
  monthly: string;
  oneTime: string;
  budgetMode: TokenBudgetMode;
  concurrent: string;
  allowed: string[];
  setRpm: (value: string) => void;
  setDaily: (value: string) => void;
  setMonthly: (value: string) => void;
  setOneTime: (value: string) => void;
  setConcurrent: (value: string) => void;
  setAllowed: (values: string[]) => void;
  onBudgetModeChange: (mode: TokenBudgetMode) => void;
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
        <div className="col-span-2 rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Label>Token budget</Label>
            <div className="flex rounded-lg border border-[var(--inner-border)] p-0.5">
              {(["recurring", "one-time"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={disabled}
                  onClick={() => onBudgetModeChange(mode)}
                  className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition-colors ${budgetMode === mode ? "bg-[var(--text-1)] text-[var(--page-bg)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
                >
                  {mode === "one-time" ? "One-time" : "Daily / monthly"}
                </button>
              ))}
            </div>
          </div>
          {budgetMode === "one-time" ? (
            <div>
              <Input type="number" min={1} value={oneTime} onChange={(e) => setOneTime(e.target.value)} placeholder="Choose a preset or enter a cap" disabled={disabled} />
              <p className="mt-2 text-[10.5px] text-[var(--text-3)]">This budget is consumed once and stops the key when it reaches zero.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Daily (optional)</Label>
                <Input type="number" min={1} value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="Unlimited" disabled={disabled} />
              </div>
              <div>
                <Label>Monthly (optional)</Label>
                <Input type="number" min={1} value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="Unlimited" disabled={disabled} />
              </div>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TOKEN_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={disabled}
                onClick={() => budgetMode === "one-time" ? setOneTime(String(preset.value)) : setDaily(String(preset.value))}
                className="rounded-md border border-[var(--inner-border)] px-2 py-1 text-[10px] font-semibold text-[var(--text-2)] hover:border-[var(--text-3)] hover:text-[var(--text-1)]"
              >
                {preset.label}
              </button>
            ))}
            <span className="self-center text-[10px] text-[var(--text-3)]">M = million · B = billion · T = trillion</span>
          </div>
        </div>
      </div>
      <ModelPickerField
        label="Allowed (optional)"
        values={allowed}
        onChange={setAllowed}
        mode="models"
        manualPlaceholder="e.g. kimchi or kimchi/kimi-k2.7"
        disabled={disabled}
        includeCombos
        includeAliases
      />
      <p className="text-xs text-[var(--text-3)]">Empty = all models allowed. Add providers (no slash), models (with slash), combos, or aliases to restrict.</p>
    </>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);
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
          if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = window.setTimeout(() => { copiedTimerRef.current = null; setCopied(false); }, 1500);
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
  const [prefix, setPrefix] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [rpm, setRpm] = useState("");
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  const [oneTime, setOneTime] = useState("");
  const [budgetMode, setBudgetMode] = useState<TokenBudgetMode>("recurring");
  const [concurrent, setConcurrent] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);
  const [regenerateTarget, setRegenerateTarget] = useState<ApiKeyRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRecord | null>(null);

  const resetKeyForm = () => {
    setName("");
    setPrefix("");
    setCustomKey("");
    setRpm("");
    setDaily("");
    setMonthly("");
    setOneTime("");
    setBudgetMode("recurring");
    setConcurrent("");
    setAllowed([]);
  };

  const openEdit = (key: ApiKeyRecord) => {
    setEditTarget(key);
    setRpm(key.rateLimitRpm ? String(key.rateLimitRpm) : "");
    const hasOneTimeBudget = key.oneTimeTokenLimit !== null;
    setBudgetMode(hasOneTimeBudget ? "one-time" : "recurring");
    setDaily(key.dailyTokenLimit ? String(key.dailyTokenLimit) : "");
    setMonthly(key.monthlyTokenLimit ? String(key.monthlyTokenLimit) : "");
    setOneTime(key.oneTimeTokenLimit ? String(key.oneTimeTokenLimit) : "");
    setConcurrent(key.maxConcurrentRequests ? String(key.maxConcurrentRequests) : "");
    setAllowed([...(key.providerAllowlist ?? []), ...(key.modelAllowlist ?? [])]);
  };

  const closeEdit = () => {
    setEditTarget(null);
    resetKeyForm();
  };

  const baseUrl = useMemo(() => `${window.location.origin}/v1`, []);
  const currentHost = window.location.hostname || "local";
  const isLocalHost = currentHost === "localhost" || currentHost === "127.0.0.1" || currentHost === "::1";

  const ipQuery = useQuery({ queryKey: qk.ip.all, queryFn: () => apiGet<{ ips: string[] }>("/ip"), staleTime: 60_000 });
  const localIps = ipQuery.data?.ips ?? [];

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.overview.all,
    queryFn: async () => {
      const response = await apiGet<unknown>("/overview");
      const parsed = parseOverviewData(response);
      if (parsed === null) throw new Error("Invalid overview response");
      return parsed;
    },
  });

  const settingsQuery = useQuery({
    queryKey: qk.settings.all,
    queryFn: () => apiGet<SettingsResponse>("/settings"),
  });

  const keysQuery = useQuery({
    queryKey: qk.apiKeys.all,
    queryFn: () => apiGet<{ items: ApiKeyRecord[] }>("/keys"),
  });

  const providersQuery = useProviders();
  const providerIds = useMemo(() => new Set((providersQuery.data?.items ?? []).map((p) => p.id)), [providersQuery.data]);

  const healthQuery = useQuery({
    queryKey: qk.health.metrics,
    queryFn: () => apiGet<HealthMetrics>("/health/metrics"),
    refetchInterval: 5_000,
  });

  const warpMetricsQuery = useQuery({
    queryKey: qk.warp.metricsSummary,
    queryFn: () => apiGet<WarpMetricsSummary>("/warp/metrics/summary"),
    refetchInterval: 5_000,
  });

  const authModeMutation = useMutation({
    mutationFn: (proxyAuthMode: RuntimeSettings["proxyAuthMode"]) =>
      apiPost<{ ok: boolean }>("/settings", { proxyAuthMode }),
    onSuccess: (_res, proxyAuthMode) => {
      toast.success(proxyAuthMode === "api_key" ? "API key now required" : "Proxy access is open");
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to update proxy access"),
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string; prefix?: string } & KeyLimitsInput) => apiPost<CreatedKey>("/keys", input),
    onSuccess: (created) => {
      setRevealed(created);
      setCreateOpen(false);
      resetKeyForm();
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to create key"),
  });

  const editMutation = useMutation({
    mutationFn: (input: { id: string; patch: KeyUpdatePatch }) => apiPatch<ApiKeyRecord>(`/keys/${input.id}`, input.patch),
    onSuccess: () => {
      toast.success("Key updated");
      closeEdit();
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to update key"),
  });

  const regenerateMutation = useMutation({
    mutationFn: (id: string) => apiPost<CreatedKey>(`/keys/${id}/regenerate`, {}),
    onSuccess: (created) => {
      setRegenerateTarget(null);
      setRevealed(created);
      closeEdit();
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to regenerate key"),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ ok: boolean }>(`/keys/${id}/revoke`, {}),
    onSuccess: () => {
      toast.success("Key revoked");
      setRevokeTarget(null);
      closeEdit();
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "failed to revoke key"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/keys/${id}`),
    onSuccess: () => {
      toast.success("Key deleted permanently");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
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
    createMutation.mutate({
      name: name.trim(),
      prefix: prefix.trim() || undefined,
      key: customKey.trim() || undefined,
      ...buildKeyLimitsInput(rpm, daily, monthly, concurrent, allowed, providerIds, oneTime, budgetMode),
    });
  };

  const submitEdit = () => {
    if (!editTarget) return;
    const limits = buildKeyLimitsInput(rpm, daily, monthly, concurrent, allowed, providerIds, oneTime, budgetMode);
    editMutation.mutate({
      id: editTarget.id,
      patch: {
        ...(customKey.trim() ? { key: customKey.trim() } : {}),
        rateLimitRpm: limits.rateLimitRpm ?? null,
        dailyTokenLimit: limits.dailyTokenLimit ?? null,
        monthlyTokenLimit: limits.monthlyTokenLimit ?? null,
        oneTimeTokenLimit: limits.oneTimeTokenLimit ?? null,
        maxConcurrentRequests: limits.maxConcurrentRequests ?? null,
        providerAllowlist: limits.providerAllowlist ?? null,
        modelAllowlist: limits.modelAllowlist ?? null,
      },
    });
  };

  if (isLoading) return <StatePanel kind="loading" title="Loading overview" description="Collecting runtime and provider health data…" />;
  if (isError || !data) return <StatePanel kind="error" title="Failed to load overview" description="The overview response was unavailable or invalid." action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />;

  const { totals } = data;
  const errorRate = totals.requests > 0 ? ((totals.errors / totals.requests) * 100).toFixed(1) : "0.0";
  const cacheRate = totals.inputTokens > 0 ? Math.round((totals.cachedTokens / totals.inputTokens) * 100) : 0;
  const health = healthQuery.data;
  const cpuPercent = health ? Math.min(100, Math.max(0, health.cpuPercent)) : 0;
  const cpuTone = cpuPercent >= 80 ? "err" : cpuPercent >= 50 ? "warn" : "ok";
  const ramSystemPercent = health && health.memoryTotalMb > 0 ? Math.min(100, Math.max(0, (health.memorySystemUsedMb / health.memoryTotalMb) * 100)) : 0;

  const runtime = settingsQuery.data?.settings.runtime;
  const requireKey = runtime?.proxyAuthMode === "api_key";
  const keys = keysQuery.data?.items ?? [];

  return (
    <div className="dashboard-page space-y-4">
      <Card>
        <CardHeader title="API Endpoint" icon={Globe} sub="Base URL for OpenAI- and Anthropic-compatible clients" />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <div className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]"><Globe size={14} /></span>
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Local</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-[10px]"
                onClick={() => {
                  void copyText(baseUrl).then((ok) => {
                    if (ok) toast.success("Copied");
                    else toast.error("Clipboard unavailable on this origin");
                  });
                }}
              >
                <Copy size={12} /> Copy
              </Button>
            </div>
            <code className="block truncate rounded-md bg-[var(--kbd-bg)] px-2 py-1.5 font-mono text-[11.5px] text-[var(--text-1)]" title={baseUrl}>{baseUrl}</code>
            <div className="mt-1.5 text-[10px] text-[var(--text-2)]">OpenAI and Anthropic compatible API</div>
          </div>
          <div className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-[rgba(48,209,88,0.13)] text-[#30d158]"><MapPin size={14} /></span>
                <span className="truncate text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Current Public IP</span>
              </div>
              <Badge tone={isLocalHost ? "default" : "info"}>{isLocalHost ? "local" : "public"}</Badge>
            </div>
            <code className="block truncate rounded-md bg-[var(--kbd-bg)] px-2 py-1.5 font-mono text-[11.5px] text-[var(--text-1)]">{currentHost}</code>
            {localIps.length > 0 && <div className="mt-1.5 truncate text-[10px] text-[var(--text-3)]" title={localIps.join(", ")}>LAN: {localIps.join(" · ")}</div>}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Health" icon={Gauge} iconColor="#30d158" sub="Last 24 hours · runtime resource usage" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatCard label="Latency" icon={Activity} tone="info" value={formatDuration(totals.avgDurationMs)} description="Avg duration" />
          <StatCard label="Cache" icon={Database} tone="accent" value={`${cacheRate}%`} description="Cache rate" />
          <StatCard label="Errors" icon={TriangleAlert} tone="danger" value={`${errorRate}%`} description="Error rate" />
          <StatCard label="Registry" icon={Globe} tone="success" value={data.registered.length} description="Providers" />
          <div className="col-span-2 grid grid-cols-1 overflow-hidden rounded-[14px] border border-[var(--inner-border)] sm:col-span-4 lg:grid-cols-4">
            {/* Merged RAM + Warp Proxy — wide card spanning 2 columns */}
            <section className="border-b border-[var(--inner-border)] bg-[var(--hover)] p-3.5 sm:border-b-0 sm:border-r lg:col-span-2">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* RAM */}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[10px] bg-[rgba(191,90,242,0.13)] text-[#bf5af2]"><MemoryStick size={14} /></span>
                    <div className="min-w-0">
                      <h3 id="health-ram-title" className="text-xs font-bold tracking-tight">RAM usage</h3>
                      <p className="text-[10px] text-[var(--text-3)]">Bun Runtime · Cartethyia process</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="text-xl font-bold tracking-tight tabular-nums">{health ? formatMemoryMb(health.memoryUsedMb) : "—"}</span>
                    <span className="text-[10px] text-[var(--text-3)]">RSS</span>
                    <Badge tone="accent" className="ml-auto">{health ? `${formatMemoryMb(health.memorySystemUsedMb)} system` : "—"}</Badge>
                  </div>
                  <p className="mt-2 text-[9.5px] leading-relaxed text-[var(--text-3)]">RSS is the whole Cartethyia process — Bun runtime, native/JIT overhead, JS heap, and buffers combined.</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={health ? ramSystemPercent : 0}>
                    <div className="h-full origin-left rounded-full bg-[#bf5af2] transition-transform duration-500" style={{ transform: `scaleX(${ramSystemPercent / 100})` }} />
                  </div>
                  {health && (() => {
                    const nativeMb = Math.max(0, health.memoryUsedMb - health.heapTotalMb - health.externalMb - health.arrayBuffersMb);
                    const rss = health.memoryUsedMb;
                    return (
                      <div className="mt-2.5 grid grid-cols-2 gap-x-2 gap-y-1.5">
                        {([
                          { label: "JS heap", used: health.heapUsedMb, bar: health.heapTotalMb, color: "#bf5af2" },
                          { label: "Bun runtime", used: nativeMb, bar: nativeMb, color: "#30d158" },
                          { label: "External", used: health.externalMb, bar: health.externalMb, color: "#ff9f0a" },
                          { label: "Array buffers", used: health.arrayBuffersMb, bar: health.arrayBuffersMb, color: "#0a84ff" },
                        ] as const).map(({ label, used, bar, color }) => (
                          <div key={label}>
                            <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                              <span>{label}</span>
                              <span className="tabular-nums">{formatMemoryMb(used)}</span>
                            </div>
                            <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                              <div className="h-full origin-left rounded-full transition-transform duration-500" style={{ transform: `scaleX(${Math.min(1, Math.max(0, rss === 0 ? 0 : bar / rss))})`, background: color }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                {/* Warp Proxy */}
                <div className="border-t border-[var(--inner-border)] pt-3 sm:border-t-0 sm:pt-0 sm:border-l sm:pl-4">
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[10px] bg-[rgba(48,209,88,0.14)] text-[#30d158]"><Globe size={14} /></span>
                    <div className="min-w-0">
                      <h3 id="health-warp-title" className="text-xs font-bold tracking-tight">Warp Proxy</h3>
                      <p className="text-[10px] text-[var(--text-3)]">MultiWarp pool · wireproxy instances</p>
                    </div>
                    <Badge tone={warpMetricsQuery.data?.runningCount ? "ok" : "default"} className="ml-auto">{warpMetricsQuery.data ? "Live" : "—"}</Badge>
                  </div>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="text-xl font-bold tracking-tight tabular-nums">{warpMetricsQuery.data ? formatMemoryMb(warpMetricsQuery.data.totalRssMb) : "—"}</span>
                    <span className="text-[10px] text-[var(--text-3)]">RSS</span>
                    <Badge tone="accent" className="ml-auto">{warpMetricsQuery.data ? `${warpMetricsQuery.data.runningCount} running` : "—"}</Badge>
                  </div>
                  <p className="mt-2 text-[9.5px] leading-relaxed text-[var(--text-3)]">Per-instance RSS summed across all running wireproxy processes. ~20–40 MB per instance.</p>
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <div>
                      <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                        <span>Healthy</span>
                        <span className="tabular-nums">{warpMetricsQuery.data?.healthyCount ?? "—"}</span>
                      </div>
                      <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                        <div className="h-full origin-left rounded-full bg-[#30d158] transition-transform duration-500" style={{ transform: `scaleX(${warpMetricsQuery.data && warpMetricsQuery.data.runningCount > 0 ? Math.min(1, warpMetricsQuery.data.healthyCount / warpMetricsQuery.data.runningCount) : 0})` }} />
                      </div>
                    </div>
                    <div>
                      <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                        <span>Bandwidth</span>
                        <span className="tabular-nums">{warpMetricsQuery.data ? `${warpMetricsQuery.data.totalBandwidthMb} MB` : "—"}</span>
                      </div>
                      <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                        <div className="h-full origin-left rounded-full bg-[#0a84ff] transition-transform duration-500" style={{ transform: `scaleX(${warpMetricsQuery.data && warpMetricsQuery.data.totalBandwidthMb > 0 ? Math.min(1, warpMetricsQuery.data.totalBandwidthMb / 100) : 0})` }} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            {/* Network */}
            <section aria-labelledby="health-net-title" className="border-t border-[var(--inner-border)] bg-[var(--hover)] p-3.5 lg:border-l lg:border-t-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]"><Network size={15} /></span>
                  <div className="min-w-0">
                    <h3 id="health-net-title" className="text-xs font-bold tracking-tight">Network</h3>
                    <p className="text-[10px] text-[var(--text-3)]">VPS bandwidth · all interfaces</p>
                  </div>
                </div>
                <Badge tone={health?.netTotalKb !== null ? "info" : "default"}>{health?.netTotalKb !== null ? "Live" : "N/A"}</Badge>
              </div>
              <div className="mt-4 flex items-end justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold tracking-tight tabular-nums">{health ? formatBandwidthKb(health.netTotalKb) : "—"}</span>
                  <span className="text-[10.5px] text-[var(--text-3)]">total</span>
                </div>
                <Badge tone="default">{health?.netRateKbps != null ? `${health.netRateKbps.toLocaleString("en-US")} KB/s` : "—"}</Badge>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-3)]">Cumulative network I/O across all interfaces since boot. Rate is sampled every 5s.</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-0.5 flex justify-between text-[9.5px] text-[var(--text-3)]">
                    <span>Received</span>
                    <span className="tabular-nums">{health ? formatBandwidthKb(health.netReceivedKb) : "—"}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--track)]">
                    <div className="h-full origin-left rounded-full bg-[#0a84ff] transition-transform duration-500" style={{ transform: `scaleX(${health && health.netTotalKb && health.netReceivedKb ? Math.min(1, health.netReceivedKb / health.netTotalKb) : 0})` }} />
                  </div>
                </div>
                <div>
                  <div className="mb-0.5 flex justify-between text-[9.5px] text-[var(--text-3)]">
                    <span>Sent</span>
                    <span className="tabular-nums">{health ? formatBandwidthKb(health.netSentKb) : "—"}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--track)]">
                    <div className="h-full origin-left rounded-full bg-[#30d158] transition-transform duration-500" style={{ transform: `scaleX(${health && health.netTotalKb && health.netSentKb ? Math.min(1, health.netSentKb / health.netTotalKb) : 0})` }} />
                  </div>
                </div>
              </div>
            </section>
            {/* CPU — last column */}
            <section aria-labelledby="health-cpu-title" className="border-t border-[var(--inner-border)] bg-[var(--hover)] p-3.5 lg:border-l lg:border-t-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(255,159,10,0.14)] text-[#ff9f0a]"><Cpu size={15} /></span>
                  <div className="min-w-0">
                    <h3 id="health-cpu-title" className="text-xs font-bold tracking-tight">CPU usage</h3>
                    <p className="text-[10px] text-[var(--text-3)]">Current process load</p>
                  </div>
                </div>
                <Badge tone={cpuTone}>{health ? "Live" : "Waiting"}</Badge>
              </div>
              <div className="mt-4 flex items-center gap-4">
                <div className="relative grid size-[88px] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#ff9f0a ${cpuPercent}%, var(--track) 0)` }} role="img" aria-label={health ? `CPU usage ${cpuPercent.toFixed(1)} percent` : "CPU usage unavailable"}>
                  <div className="grid size-[68px] place-items-center rounded-full bg-[var(--hover)]">
                    <span className="text-lg font-bold tabular-nums">{health ? `${cpuPercent.toFixed(1)}%` : "—"}</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-[10px]">
                    <span className="text-[var(--text-3)]">Cores</span>
                    <span className="font-semibold tabular-nums">{health ? `${health.coreCount} logical` : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-2 text-[10px]">
                    <span className="text-[var(--text-3)]">PID</span>
                    <span className="max-w-[9rem] truncate font-mono font-semibold">{health ? String(health.pid) : "—"}</span>
                  </div>
                </div>
              </div>
              {health && <div className="mt-3 truncate text-[9px] text-[var(--text-3)]" title={health.cpuModel}>{health.cpuModel}</div>}
            </section>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="API Keys" icon={KeyRound} iconColor="#ff9f0a" sub="Client keys for proxy access">
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

        <div className="space-y-2.5">
          {keysQuery.isLoading ? (
            <div className="rounded-[14px] border border-dashed border-[var(--inner-border)] px-4 py-10 text-center text-xs text-[var(--text-3)]">Loading API keys…</div>
          ) : keys.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-[var(--inner-border)] px-4 py-10 text-center text-xs text-[var(--text-3)]">No keys yet — create one to enforce proxy authentication.</div>
          ) : (
            keys.map((key, index) => (
              <article key={key.id} {...staggerClass(index)} className="rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-2.5 transition-colors hover:bg-[var(--surface-hover)] sm:p-3">
                <div className="flex min-w-0 flex-col gap-2 sm:grid sm:grid-cols-[minmax(150px,0.85fr)_minmax(0,2fr)_auto] sm:items-center sm:gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-bold">{key.name}</h3>
                      <Badge tone={key.active ? "ok" : "default"}>{key.revokedAt ? "revoked" : key.active ? "active" : "disabled"}</Badge>
                    </div>
                    <code className="mt-0.5 block truncate font-mono text-[10.5px] text-[var(--text-2)]">{key.keyPrefix}…</code>
                    <div className="mt-0.5 text-[9.5px] text-[var(--text-3)]">Created {formatTime(key.createdAt)}</div>
                  </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  <div className="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Limits</div>
                    <div className="mt-0.5 truncate text-[10.5px] text-[var(--text-2)]" title={formatKeyLimits(key)}>{formatKeyLimits(key)}</div>
                  </div>
                  <div className="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Today</div>
                    <div className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-[var(--text-1)]">{formatTokens(key.todayTokens)}</div>
                  </div>
                  <div className="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Total</div>
                    <div className="mt-0.5 text-[10.5px] font-semibold tabular-nums text-[var(--text-1)]">{formatTokens(key.totalTokens)}</div>
                  </div>
                  <div className="rounded-lg bg-[var(--surface-muted)] px-2 py-1.5">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Last used</div>
                    <div className="mt-0.5 truncate text-[10.5px] tabular-nums text-[var(--text-2)]">{formatTime(key.lastUsedAt)}</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap justify-end gap-1.5 border-t border-[var(--inner-border)] pt-2 sm:mt-0 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
                  {key.active && (
                    <Button variant="ghost" size="sm" disabled={credentialCopy.isPending} onClick={() => credentialCopy.mutate(key.id)} title="Copy API key" aria-label={`Copy API key ${key.name}`}><Copy size={13} /> Copy</Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={editMutation.isPending || Boolean(key.revokedAt)} onClick={() => editMutation.mutate({ id: key.id, patch: { active: !key.active } })} title={key.active ? "Disable API key" : "Enable API key"}>
                    {key.active ? "Disable" : "Enable"}
                  </Button>
                  {key.active && <Button variant="ghost" size="sm" disabled={regenerateMutation.isPending} onClick={() => setRegenerateTarget(key)} title="Rotate API key"><KeyRound size={13} /> Rotate</Button>}
                  <Button variant="ghost" size="sm" onClick={() => openEdit(key)} title="Edit key status, limits and ACL"><Pencil size={13} /> Edit</Button>
                  {key.revokedAt ? <Button variant="ghost" size="sm" className="text-[var(--red)]" onClick={() => setDeleteTarget(key)}><Trash2 size={13} /> Delete</Button> : null}
                </div>
                </div>
              </article>
            ))
          )}
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
          <div>
            <Label>Custom API key value (optional)</Label>
            <Input value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="ctk_inibansos" disabled={createMutation.isPending} spellCheck={false} autoComplete="off" />
            <p className="mt-1 text-[10.5px] text-[var(--text-3)]">Use an exact value such as <code>ctk_inibansos</code>. Leave blank to generate a secure random key. 8–256 letters, digits, underscores, or hyphens.</p>
          </div>
          <div>
            <Label>Generated key prefix (optional)</Label>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="ctk (default)" disabled={createMutation.isPending || customKey.trim().length > 0} />
            <p className="mt-1 text-[10.5px] text-[var(--text-3)]">Only applies when generating a random key.</p>
          </div>
          <KeyLimitsFields
            rpm={rpm}
            daily={daily}
            monthly={monthly}
            oneTime={oneTime}
            budgetMode={budgetMode}
            concurrent={concurrent}
            allowed={allowed}
            setRpm={setRpm}
            setDaily={setDaily}
            setMonthly={setMonthly}
            setOneTime={setOneTime}
            setConcurrent={setConcurrent}
            setAllowed={setAllowed}
            onBudgetModeChange={(mode) => {
              setBudgetMode(mode);
              if (mode === "one-time") {
                setDaily("");
                setMonthly("");
              } else {
                setOneTime("");
              }
            }}
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
          <div className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <Label>Replace API key value (optional)</Label>
            <Input value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="Leave blank to keep current key" disabled={editMutation.isPending} spellCheck={false} autoComplete="off" />
            <p className="mt-1 text-[10.5px] text-[var(--text-3)]">A replacement immediately invalidates the previous value. 8–256 letters, digits, underscores, or hyphens.</p>
          </div>
          <KeyLimitsFields
            rpm={rpm}
            daily={daily}
            monthly={monthly}
            oneTime={oneTime}
            budgetMode={budgetMode}
            concurrent={concurrent}
            allowed={allowed}
            setRpm={setRpm}
            setDaily={setDaily}
            setMonthly={setMonthly}
            setOneTime={setOneTime}
            setConcurrent={setConcurrent}
            setAllowed={setAllowed}
            onBudgetModeChange={(mode) => {
              setBudgetMode(mode);
              if (mode === "one-time") {
                setDaily("");
                setMonthly("");
              } else {
                setOneTime("");
              }
            }}
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
      <ConfirmDialog open={!!regenerateTarget} onClose={() => setRegenerateTarget(null)} onConfirm={() => regenerateTarget && regenerateMutation.mutate(regenerateTarget.id)} title="Revoke & regenerate API Key" message={`The current credential for "${regenerateTarget?.name}" will stop working immediately and a new key will be shown once. Continue?`} danger confirmLabel="Revoke & regenerate" />
      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} title="Delete API Key" message={`Permanently delete "${deleteTarget?.name}"? This removes the key from the database entirely.`} danger confirmLabel="Delete" />
    </div>
  );
}

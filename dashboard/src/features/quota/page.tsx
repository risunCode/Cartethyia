import { useQuery } from "@tanstack/react-query";
import { Check, Clock3, EyeOff, Gauge, Loader2, RefreshCw, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { ProviderIcon } from "../../components/provider-icon";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { toast } from "sonner";

interface ProviderSummary { id: string; name: string; authKind: string; icon?: string; }
interface QuotaWindow { label: string; remainingPercent: number | null; usedPercent?: number | null; resetsAt: string | null; used?: number | null; limit?: number | null; }
interface QuotaData { plan: string | null; windows: QuotaWindow[]; fetchedAt: string; error: string | null; }
interface AccountHealth { status: "healthy" | "refreshing" | "error" | "disabled" | "reauthentication-required"; statusCode: number | null; sanitizedMessage: string | null; retryAt: string | null; }
interface Account { id: string; provider: string; name: string; credentialHint: string; active: boolean; quota: QuotaData | null; health: AccountHealth | null; }
interface QuotaEntry extends Account { providerName: string; providerIcon: string; }

const QUOTA_ENDPOINT_PROVIDERS = new Set(["openai-codex", "anthropic-oauth", "google-antigravity", "kiro", "qoder"]);

function formatReset(value: string | null): string {
  if (!value) return "no reset time";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "resetting soon";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

function statusLabel(account: QuotaEntry): string {
  if (account.health?.status === "reauthentication-required") return "Re-authentication required";
  if (account.health?.status === "disabled") return account.health.retryAt ? `Disabled · ${formatReset(account.health.retryAt)}` : "Disabled";
  if (account.health?.status === "error") return account.health.statusCode ? `${account.health.statusCode} error` : "Provider error";
  return account.active ? "active" : "disabled";
}

function statusTone(account: QuotaEntry): "ok" | "warn" | "err" | "default" {
  if (account.health?.status === "error" || account.health?.status === "reauthentication-required") return "err";
  if (account.health?.status === "disabled") return "warn";
  return account.active ? "ok" : "default";
}

function quotaColor(remaining: number | null): string {
  if (remaining !== null && remaining <= 10) return "bg-[var(--red)]";
  if (remaining !== null && remaining <= 25) return "bg-[var(--yellow,theme(colors.amber.400))]";
  return "bg-[var(--green)]";
}

function isEmpty(account: QuotaEntry): boolean {
  return Boolean(account.quota?.windows.length && account.quota.windows.every((window) => window.remainingPercent !== null && window.remainingPercent <= 0));
}

function firstResetAt(account: QuotaEntry): number {
  const resetTimes = account.quota?.windows.map((window) => window.resetsAt ? new Date(window.resetsAt).getTime() : Number.POSITIVE_INFINITY) ?? [];
  return Math.min(...resetTimes, Number.POSITIVE_INFINITY);
}

export function QuotaPage() {
  const [providerFilter, setProviderFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const { data, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["console", "quota-management"],
    queryFn: async (): Promise<{ providers: ProviderSummary[]; accounts: QuotaEntry[] }> => {
      const { items: providers } = await apiGet<{ items: ProviderSummary[] }>("/providers");
      const quotaProviders = providers.filter((provider) => QUOTA_ENDPOINT_PROVIDERS.has(provider.id));
      const accountPages = await Promise.all(quotaProviders.map(async (provider) => {
        const { items } = await apiGet<{ items: Account[] }>(`/providers/${provider.id}/accounts?limit=100`);
        return items.map((account) => ({ ...account, providerName: provider.name, providerIcon: provider.icon ?? provider.id }));
      }));
      return { providers, accounts: accountPages.flat() };
    },
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const providers = (data?.providers ?? []).filter((provider) => QUOTA_ENDPOINT_PROVIDERS.has(provider.id));
  const accounts = (data?.accounts ?? []).filter((account) => QUOTA_ENDPOINT_PROVIDERS.has(account.provider));
  const filteredAccounts = useMemo(() => {
    const result = accounts.filter((account) => {
      if (providerFilter !== "all" && account.provider !== providerFilter) return false;
      if (accountFilter === "active" && !account.active) return false;
      if (accountFilter === "disabled" && account.active) return false;
      if (accountFilter === "tracked" && (!account.quota || account.quota.windows.length === 0)) return false;
      return true;
    });
    if (!expiringFirst) return result;
    return [...result].sort((left, right) => firstResetAt(left) - firstResetAt(right));
  }, [accountFilter, accounts, expiringFirst, providerFilter]);
  const updateAccount = async (account: QuotaEntry, active: boolean) => {
    try {
      await apiPost<{ ok: boolean }>(`/providers/${account.provider}/accounts/${account.id}`, { active });
      toast.success(`${account.name} ${active ? "enabled" : "disabled"}`);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update account");
    }
  };
  const turnOffEmpty = async () => {
    const targets = accounts.filter((account) => account.active && isEmpty(account));
    await Promise.all(targets.map((account) => apiPost(`/providers/${account.provider}/accounts/${account.id}`, { active: false })));
    toast.success(`Disabled ${targets.length} empty accounts`);
    await refetch();
  };
  const turnOnAvailable = async () => {
    const targets = accounts.filter((account) => !account.active && account.quota?.windows.some((window) => window.remainingPercent !== null && window.remainingPercent > 0));
    await Promise.all(targets.map((account) => apiPost(`/providers/${account.provider}/accounts/${account.id}`, { active: true })));
    toast.success(`Enabled ${targets.length} available accounts`);
    await refetch();
  };
  const deleteAccount = async (account: QuotaEntry) => {
    if (!window.confirm(`Delete ${account.name}?`)) return;
    try {
      await apiDelete(`/providers/${account.provider}/accounts/${account.id}`);
      toast.success(`${account.name} deleted`);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete account");
    }
  };
  const lastUpdated = dataUpdatedAt > 0 ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const emptyCount = accounts.filter(isEmpty).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--inner-border)] bg-[var(--panel)] p-2">
        <SlidersHorizontal size={14} className="mx-1 text-[var(--text-3)]" aria-hidden="true" />
        <select aria-label="Filter quota by provider" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} className="h-8 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-xs text-[var(--text-1)]"><option value="all">All Providers</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
        <select aria-label="Filter quota by account" value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} className="h-8 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-xs text-[var(--text-1)]"><option value="all">All accounts</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="tracked">With quota</option></select>
        <Button variant={expiringFirst ? "secondary" : "ghost"} size="sm" onClick={() => setExpiringFirst((current) => !current)}><Clock3 size={13} /> Expiring first</Button>
        <Button variant="ghost" size="sm" className="text-[var(--red)]" disabled={emptyCount === 0 || isFetching} onClick={() => void turnOffEmpty()}><EyeOff size={13} /> Turn off Empty</Button>
        <Button variant="ghost" size="sm" className="text-[var(--green)]" disabled={isFetching} onClick={() => void turnOnAvailable()}><Check size={13} /> Turn on Available</Button>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--text-3)]"><span className="inline-block size-1.5 animate-pulse rounded-full bg-[var(--green)]" /> Auto-refresh (5m)</span>
        <Button variant="ghost" size="icon" className="size-8" title="Refresh quota" aria-label="Refresh quota" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={14} className={isFetching ? "animate-spin" : undefined} /></Button>
      </div>

      {isLoading ? <div className="rounded-xl border border-[var(--inner-border)] p-12 text-center text-sm text-[var(--text-3)]"><Loader2 className="mx-auto mb-2 animate-spin" size={18} />Loading quota data…</div> : filteredAccounts.length === 0 ? <div className="rounded-xl border border-[var(--inner-border)] p-12 text-center text-sm text-[var(--text-3)]"><Gauge className="mx-auto mb-2" size={20} />No account quota data available yet.</div> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{filteredAccounts.map((account) => <div key={account.id} className="overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--panel)] shadow-[0_8px_30px_rgba(0,0,0,.08)]">
        <div className="flex items-center gap-2 border-b border-[var(--inner-border)] px-3 py-2.5"><ProviderIcon icon={account.providerIcon} name={account.providerName} size={30} /><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">{account.providerName}</div><div className="truncate text-[10px] text-[var(--text-2)]">{account.name}</div><div className="truncate font-mono text-[9px] text-[var(--text-3)]">{account.credentialHint}</div></div><div className="flex items-center gap-0.5"><Button variant="ghost" size="icon" className="size-7" title="Refresh account" aria-label={`Refresh ${account.name}`} onClick={() => void refetch()}><RotateCcw size={13} /></Button><Switch checked={account.active} onChange={(active) => void updateAccount(account, active)} label={`${account.active ? "Disable" : "Enable"} ${account.name}`} /><Button variant="ghost" size="icon" className="size-7 text-[var(--red)]" title="Delete account" aria-label={`Delete ${account.name}`} onClick={() => void deleteAccount(account)}><Trash2 size={13} /></Button></div></div>
        <div className="flex items-center justify-between px-3 py-2 text-[10px] text-[var(--text-3)]"><span>{account.quota?.windows.length ?? 0} quota{account.quota?.windows.length === 1 ? "" : "s"}{account.quota?.plan ? ` · ${account.quota.plan}` : ""}</span><Badge tone={statusTone(account)}>{statusLabel(account)}</Badge></div>
        <div className="divide-y divide-[var(--inner-border)]">{account.quota?.windows.length ? account.quota.windows.map((window) => <div key={`${window.label}:${window.resetsAt ?? "none"}`} className="flex items-center gap-2 px-3 py-2.5"><span className={`size-2 shrink-0 rounded-full ${window.remainingPercent !== null && window.remainingPercent <= 0 ? "bg-[var(--red)]" : "bg-[var(--green)]"}`} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-medium">{window.label}</span><span className="shrink-0 text-[10px] text-[var(--text-3)]">{formatReset(window.resetsAt)}</span></div><div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--inner-border)]"><div className={`h-full ${quotaColor(window.remainingPercent)}`} style={{ width: `${window.remainingPercent === null ? 0 : Math.max(0, Math.min(100, window.remainingPercent))}%` }} /></div><div className="mt-0.5 flex justify-between font-mono text-[9px] text-[var(--text-3)]"><span>{typeof window.used === "number" && typeof window.limit === "number" ? `${window.used} / ${window.limit}` : typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent)}% used` : "usage unavailable"}</span><span>{window.remainingPercent === null ? "—" : `${Math.round(window.remainingPercent)}%`}</span></div></div><EyeOff size={14} className="shrink-0 text-[var(--text-3)]" aria-hidden="true" /></div>) : <div className="px-3 py-6 text-center text-[10px] text-[var(--text-3)]">No quota reported</div>}</div>
        {account.health?.sanitizedMessage && <div className="border-t border-[var(--inner-border)] px-3 py-2 text-[10px] text-[var(--red)]">{account.health.sanitizedMessage}</div>}
      </div>)}</div>}
      <div className="flex items-center justify-between text-[10px] text-[var(--text-3)]"><span>Auto-refresh every 5 minutes · updated {lastUpdated}</span><span>{filteredAccounts.length} shown</span></div>
    </div>
  );
}

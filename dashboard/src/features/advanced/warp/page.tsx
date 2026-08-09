/** MultiWarp page — metrics cards + account table with inline label edit + backup/restore. */

import { useState, useCallback, useRef, Fragment } from "react";
import { Globe, Plus, Play, Square, Trash2, RefreshCw, Upload, Download, CheckCircle2, XCircle, Cpu, Wifi, Pencil, Save, X, Settings2 } from "lucide-react";
import { cn } from "../../../lib/cn";
import { downloadBlob } from "../../../lib/files";
import { Button } from "../../../components/ui/button";
import { Card, CardHeader } from "../../../components/ui/card";
import { Input, Label, Textarea } from "../../../components/ui/input";
import { StatePanel, StatCard } from "../../../components/ui/state";
import { toast } from "../../../lib/toast";
import { apiGet, apiPost, apiDelete, apiPatch, ApiError } from "../../../lib/api";
import { qk } from "../../../lib/query-keys";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface WarpAccount {
  id: string;
  label: string;
  socksPort: number;
  enabled: boolean;
  running: boolean;
  pid: number | null;
  preferIpv6: boolean;
  customEndpoint: string | null;
  persistentKeepalive: number;
  createdAt: string;
}

interface WarpInstanceStatus {
  accountId: string;
  label: string;
  running: boolean;
  pid: number | null;
  socksPort: number;
  socksUrl: string;
  healthy: boolean | null;
  egressIp: string | null;
  message?: string;
}

interface WarpMetricsSummary {
  totalRssMb: number;
  totalRxMb: number;
  totalTxMb: number;
  totalBandwidthMb: number;
  runningCount: number;
  healthyCount: number;
}

interface WarpProfileExport {
  accountId: string;
  label: string;
  profileContent: string;
  deviceId: string;
  accessToken: string;
  licenseKey: string;
}

interface WarpBackupPayload {
  version: 1;
  exportedAt: string;
  accounts: readonly WarpProfileExport[];
}

function useWarpAccounts() {
  return useQuery({
    queryKey: qk.warp.accounts,
    queryFn: () => apiGet<readonly WarpAccount[]>("/warp/accounts"),
  });
}

function useWarpStatuses() {
  return useQuery({
    queryKey: qk.warp.statuses,
    queryFn: () => apiGet<Readonly<Record<string, WarpInstanceStatus>>>("/warp/statuses"),
    refetchInterval: 10000,
  });
}

function useWarpMetricsSummary() {
  return useQuery({
    queryKey: qk.warp.metricsSummary,
    queryFn: () => apiGet<WarpMetricsSummary>("/warp/metrics/summary"),
    refetchInterval: 5000,
  });
}


export function MultiWarpPage() {
  const accountsQuery = useWarpAccounts();
  const statusesQuery = useWarpStatuses();
  const metricsQuery = useWarpMetricsSummary();
  const [showRegister, setShowRegister] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [registerLabel, setRegisterLabel] = useState("");
  const [importLabel, setImportLabel] = useState("");
  const [importContent, setImportContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const qc = useQueryClient();

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.warp.accounts });
    qc.invalidateQueries({ queryKey: qk.warp.statuses });
    qc.invalidateQueries({ queryKey: qk.warp.metricsSummary });
  }, [qc]);

  const registerMutation = useMutation({
    mutationFn: (label: string) => apiPost<{ success: boolean; message: string }>("/warp/register", { label }),
    onSuccess: (data) => { toast.success(data.message); setShowRegister(false); setRegisterLabel(""); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const importMutation = useMutation({
    mutationFn: (input: { label: string; profileContent: string }) => apiPost<{ success: boolean; message: string }>("/warp/import", input),
    onSuccess: (data) => { toast.success(data.message); setShowImport(false); setImportLabel(""); setImportContent(""); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ success: boolean; message: string }>(`/warp/accounts/${id}/start`),
    onSuccess: (data) => { toast.success(data.message); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ success: boolean; message: string }>(`/warp/accounts/${id}/stop`),
    onSuccess: (data) => { toast.success(data.message); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => apiDelete<{ success: boolean; message: string }>(`/warp/accounts/${id}`),
    onSuccess: (data) => { toast.success(data.message); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const startAllMutation = useMutation({
    mutationFn: () => apiPost<{ success: boolean; message: string }>("/warp/start-all"),
    onSuccess: (data) => { toast.success(data.message); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const batchStartMutation = useMutation({
    mutationFn: async (ids: string[]) => { await Promise.all(ids.map((id) => apiPost(`/warp/accounts/${id}/start`))); },
    onSuccess: () => { toast.success(`Started ${selectedIds.size} instances`); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const batchStopMutation = useMutation({
    mutationFn: async (ids: string[]) => { await Promise.all(ids.map((id) => apiPost(`/warp/accounts/${id}/stop`))); },
    onSuccess: () => { toast.success(`Stopped ${selectedIds.size} instances`); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => { await Promise.all(ids.map((id) => apiDelete(`/warp/accounts/${id}`))); },
    onSuccess: () => { toast.success(`Deleted ${selectedIds.size} accounts`); setSelectedIds(new Set()); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const updateLabelMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => apiPatch<{ success: boolean }>(`/warp/accounts/${id}`, { label }),
    onSuccess: () => { toast.success("Label updated"); setEditingId(null); qc.invalidateQueries({ queryKey: qk.warp.accounts }); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const updateSettingsMutation = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; preferIpv6?: boolean; customEndpoint?: string | null; persistentKeepalive?: number }) => apiPatch<{ success: boolean }>(`/warp/accounts/${id}`, patch),
    onSuccess: () => { toast.success("Settings updated"); qc.invalidateQueries({ queryKey: qk.warp.accounts }); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const backupAllMutation = useMutation({
    mutationFn: () => apiGet<WarpBackupPayload>("/warp/backup"),
    onSuccess: (data) => {
      downloadBlob(`warp-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
      toast.success(`Backup downloaded (${data.accounts.length} accounts)`);
    },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const restoreBackupMutation = useMutation({
    mutationFn: (payload: WarpBackupPayload) => apiPost<{ success: boolean; message: string }>("/warp/backup/restore", { payload }),
    onSuccess: (data) => { toast.success(data.message); invalidateAll(); },
    onError: (err: ApiError) => toast.error(err.message),
  });

  const handleRemove = useCallback((id: string, label: string) => {
    if (!confirm(`Remove ${label}? This will stop the instance and delete the account.`)) return;
    removeMutation.mutate(id);
  }, [removeMutation]);

  const handleStartEdit = useCallback((id: string, label: string) => {
    setEditingId(id);
    setEditLabel(label);
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const accounts = accountsQuery.data ?? [];
  const statuses = statusesQuery.data ?? {};
  const metrics = metricsQuery.data;
  const runningCount = Object.values(statuses).filter((s) => s.running).length;

  const allSelected = accounts.length > 0 && accounts.every((a) => selectedIds.has(a.id));
  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(accounts.map((a) => a.id)));
  }, [allSelected, accounts]);

  const handleSaveEdit = useCallback((id: string) => {
    if (!editLabel.trim()) { toast.error("Label cannot be empty"); return; }
    updateLabelMutation.mutate({ id, label: editLabel.trim() });
  }, [editLabel, updateLabelMutation]);

  const handleFileRestore = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result as string) as WarpBackupPayload;
        if (payload.version !== 1 || !Array.isArray(payload.accounts)) { toast.error("Invalid backup file format"); return; }
        restoreBackupMutation.mutate(payload);
      } catch {
        toast.error("Failed to parse backup file");
      }
    };
    reader.onerror = () => { toast.error("Failed to read backup file"); };
    reader.onabort = () => { toast.error("Backup file read aborted"); };
    reader.readAsText(file);
  }, [restoreBackupMutation]);

  const healthyCount = Object.values(statuses).filter((s) => s.healthy === true).length;
  const enabledCount = accounts.filter((a) => a.enabled).length;

  return (
    <div className="dashboard-page space-y-4">
      {/* Hidden file input for backup restore */}
      <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileRestore(f); e.target.value = ""; }} />

      {/* Header */}
      <Card>
        <CardHeader
          title="MultiWarp Pool"
          sub={`${accounts.length} accounts · ${runningCount} running · ${healthyCount} healthy`}
          icon={Globe}
          iconColor="var(--green)"
        />
        <p className="text-[10.5px] text-[var(--text-3)]">
          Tip: Each running Warp instance typically uses <span className="font-semibold text-[var(--text-2)]">20–40 MB RAM</span> per client. Plan capacity accordingly.
        </p>
      </Card>

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatCard
          label="Memory Usage"
          icon={Cpu}
          tone="neutral"
          value={metrics ? `${metrics.totalRssMb} MB` : "—"}
          description={`${runningCount} instances`}
        />
        <StatCard
          label="Bandwidth (Total)"
          icon={Wifi}
          tone="info"
          value={metrics ? `${metrics.totalBandwidthMb} MB` : "—"}
          description={`RX ${metrics?.totalRxMb ?? 0} / TX ${metrics?.totalTxMb ?? 0}`}
        />
        <StatCard
          label="Running"
          icon={Globe}
          tone={healthyCount > 0 ? "accent" : "neutral"}
          value={<span className={healthyCount > 0 ? "text-[var(--accent)]" : undefined}>{runningCount}</span>}
          description={`${healthyCount} healthy`}
          className={healthyCount > 0 ? "border-[var(--accent)]/40" : undefined}
        />
        <StatCard
          label="Total Accounts"
          icon={CheckCircle2}
          tone="neutral"
          value={accounts.length}
          description={`${enabledCount} enabled`}
        />
      </div>

      {/* Action Bar — grid for desktop, stack on mobile */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Button size="sm" onClick={() => setShowRegister(!showRegister)}>
          <Plus size={13} className="mr-1.5" /> Register New
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowImport(!showImport)}>
          <Upload size={13} className="mr-1.5" /> Import Profile
        </Button>
        {accounts.length > 0 && (
          <>
            <Button size="sm" variant="outline" onClick={() => backupAllMutation.mutate()} disabled={backupAllMutation.isPending}>
              <Download size={13} className="mr-1.5" /> Backup All
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={restoreBackupMutation.isPending}>
              <Upload size={13} className="mr-1.5" /> Restore Backup
            </Button>
            <Button size="sm" variant="outline" onClick={() => startAllMutation.mutate()} disabled={startAllMutation.isPending}>
              <Play size={13} className="mr-1.5" /> Start All
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { accountsQuery.refetch(); statusesQuery.refetch(); metricsQuery.refetch(); }}>
              <RefreshCw size={13} className="mr-1.5" /> Refresh
            </Button>
          </>
        )}
      </div>

      {/* Batch actions bar — shown when rows selected */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/40 px-3 py-2">
          <span className="text-[11px] font-semibold text-[var(--accent)]">{selectedIds.size} selected</span>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={batchStartMutation.isPending} onClick={() => void batchStartMutation.mutate([...selectedIds])}>
              <Play size={12} className="mr-1" /> Start
            </Button>
            <Button size="sm" variant="secondary" disabled={batchStopMutation.isPending} onClick={() => void batchStopMutation.mutate([...selectedIds])}>
              <Square size={12} className="mr-1" /> Stop
            </Button>
            <Button size="sm" variant="secondary" disabled={batchDeleteMutation.isPending} onClick={() => { if (confirm(`Delete ${selectedIds.size} accounts?`)) void batchDeleteMutation.mutate([...selectedIds]); }}>
              <Trash2 size={12} className="mr-1" /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
          </div>
        </div>
      )}

      {/* Register form */}
      {showRegister && (
        <Card density="compact">
          <Label htmlFor="register-label">Label</Label>
          <Input id="register-label" value={registerLabel} onChange={(e) => setRegisterLabel(e.target.value)} placeholder="Label (e.g. Warp-US-01)" />
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => registerMutation.mutate(registerLabel)} disabled={registerMutation.isPending}>
              {registerMutation.isPending ? "Registering..." : "Register"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowRegister(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {/* Import form */}
      {showImport && (
        <Card density="compact">
          <Label htmlFor="import-label">Label (optional)</Label>
          <Input id="import-label" value={importLabel} onChange={(e) => setImportLabel(e.target.value)} placeholder="Label" />
          <div className="mt-2">
            <Label htmlFor="import-content">WireGuard Profile</Label>
            <Textarea id="import-content" value={importContent} onChange={(e) => setImportContent(e.target.value)} placeholder={"[Interface]\nPrivateKey = ...\n..."} className="font-mono text-[10.5px]" />
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => importMutation.mutate({ label: importLabel, profileContent: importContent })} disabled={importMutation.isPending || !importContent.trim()}>
              {importMutation.isPending ? "Importing..." : "Import"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowImport(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {/* Account table */}
      {accountsQuery.isLoading ? (
        <StatePanel kind="loading" title="Loading Warp accounts" description="Reading the account registry…" />
      ) : accounts.length === 0 ? (
        <StatePanel kind="empty" title="No Warp accounts" description="Register a new account or import a WireGuard profile to get started." icon={Globe} />
      ) : (
        <Card density="compact" className="p-0">
          <div className="overflow-auto max-h-[420px]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--inner-border)] text-left text-[10px] uppercase tracking-wider text-[var(--text-3)]">
                  <th className="w-8 px-3 py-2 font-semibold sticky top-0 bg-[var(--glass-bg)] z-10">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" className="accent-[var(--accent)]" />
                  </th>
                  <th className="px-3 py-2 font-semibold sticky top-0 bg-[var(--glass-bg)] z-10">Status</th>
                  <th className="px-3 py-2 font-semibold sticky top-0 bg-[var(--glass-bg)] z-10">Label</th>
                  <th className="px-3 py-2 font-semibold sticky top-0 bg-[var(--glass-bg)] z-10">SOCKS5</th>
                  <th className="px-3 py-2 font-semibold hidden sm:table-cell sticky top-0 bg-[var(--glass-bg)] z-10">Egress IP</th>
                  <th className="px-3 py-2 font-semibold hidden md:table-cell sticky top-0 bg-[var(--glass-bg)] z-10">Health</th>
                  <th className="px-3 py-2 font-semibold text-right sticky top-0 bg-[var(--glass-bg)] z-10">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const status = statuses[account.id];
                  const running = status?.running ?? false;
                  const healthy = status?.healthy;
                  const isEditing = editingId === account.id;
                  const isSettingsOpen = settingsId === account.id;
                  return (
                    <Fragment key={account.id}>
                    <tr className="border-b border-[var(--inner-border)] last:border-0 hover:bg-[var(--hover)]/50">
                      <td className="px-3 py-2.5">
                        <input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => toggleSelected(account.id)} aria-label={`Select ${account.label}`} className="accent-[var(--accent)]" />
                      </td>
                      <td className="px-3 py-2.5">
                        {running ? (healthy === true ? <CheckCircle2 size={14} className="text-[var(--accent)]" /> : healthy === false ? <XCircle size={14} className="text-[var(--red)]" /> : <RefreshCw size={14} className="text-[var(--text-3)] animate-spin" />) : <Globe size={14} className="text-[var(--text-3)]" />}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-[var(--text-1)]">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input type="text" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSaveEdit(account.id); if (e.key === "Escape") setEditingId(null); }} className="w-32 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--hover)] px-2 py-1 text-xs text-[var(--text-1)] focus:outline-none" autoFocus />
                            <button type="button" onClick={() => handleSaveEdit(account.id)} className="rounded p-0.5 text-[var(--accent)] hover:bg-[var(--hover)]" title="Save"><Save size={12} /></button>
                            <button type="button" onClick={() => setEditingId(null)} className="rounded p-0.5 text-[var(--text-3)] hover:bg-[var(--hover)]" title="Cancel"><X size={12} /></button>
                          </div>
                        ) : (
                          <button type="button" onClick={() => handleStartEdit(account.id, account.label)} className="group flex items-center gap-1.5 hover:text-[var(--accent)]">
                            {account.label || `Warp-${account.socksPort}`}
                            <Pencil size={10} className="text-[var(--text-3)] opacity-0 group-hover:opacity-100" />
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[10.5px] text-[var(--text-3)]">:{account.socksPort}</td>
                      <td className="px-3 py-2.5 font-mono text-[10.5px] text-[var(--text-2)] hidden sm:table-cell">{status?.egressIp ?? "—"}</td>
                      <td className="px-3 py-2.5 text-[10.5px] text-[var(--text-3)] hidden md:table-cell">{status?.message ?? (account.enabled ? "Stopped" : "Disabled")}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1">
                          <button type="button" onClick={() => setSettingsId(isSettingsOpen ? null : account.id)} className={cn("rounded p-1", isSettingsOpen ? "text-[var(--accent)]" : "text-[var(--text-3)]", "hover:bg-[var(--hover)]")} title="Configure"><Settings2 size={13} /></button>
                          {running ? (
                            <button type="button" onClick={() => stopMutation.mutate(account.id)} disabled={stopMutation.isPending} className="rounded p-1 text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--red)]" title="Stop"><Square size={13} /></button>
                          ) : (
                            <button type="button" onClick={() => startMutation.mutate(account.id)} disabled={startMutation.isPending || !account.enabled} className="rounded p-1 text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--accent)]" title="Start"><Play size={13} /></button>
                          )}
                          <button type="button" onClick={() => handleRemove(account.id, account.label)} disabled={removeMutation.isPending} className="rounded p-1 text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--red)]" title="Delete"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                    {isSettingsOpen && (
                      <tr className="border-b border-[var(--inner-border)] last:border-0 bg-[var(--surface-muted)]">
                        <td colSpan={7} className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-4">
                            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
                              <input type="checkbox" checked={account.preferIpv6} onChange={(e) => updateSettingsMutation.mutate({ id: account.id, preferIpv6: e.target.checked })} className="accent-[var(--accent)]" />
                              Prefer IPv6
                            </label>
                            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
                              Keepalive
                              <input type="number" min={0} max={120} value={account.persistentKeepalive} onChange={(e) => updateSettingsMutation.mutate({ id: account.id, persistentKeepalive: Number(e.target.value) || 0 })} className="w-14 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1 text-[10.5px] text-[var(--text-1)]" />
                              <span className="text-[10px] text-[var(--text-3)]">s (0=off, 15=anti-QoS)</span>
                            </label>
                            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
                              Custom Endpoint
                              <input type="text" value={account.customEndpoint ?? ""} onChange={(e) => updateSettingsMutation.mutate({ id: account.id, customEndpoint: e.target.value || null })} placeholder="162.159.192.1:4500" className="w-52 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-1.5 py-1 font-mono text-[10.5px] text-[var(--text-1)]" />
                            </label>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * Proxy & Requests - global routing controls (REQ: consolidate per-provider
 * account rotation strategy in one place, and the outbound proxy pool that
 * routes provider traffic through SOCKS5/HTTP/HTTPS proxies with anti-
 * interrupted failover).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clipboard, Download, FlaskConical, Loader2, Network, Pencil, Plus, Route, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiDelete, apiGet, apiPost } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/tabs";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";
import { ProviderIcon } from "../../components/provider-icon";

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "request failed";
}

// ── Types ─────────────────────────────────────────────────────────────────

interface ProviderRoutingSummary {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "api-key";
  routing: { strategy: "priority" | "round-robin"; stickyLimit: number; useStickyLimit: boolean };
}

interface ProxySettings {
  enabled: boolean;
  excludedProviders: string[];
  smartDynamicRouting: boolean;
  smartDynamicProxyCount: number;
}

interface ProxyRecord {
  id: string;
  name: string;
  protocol: "http" | "https" | "socks5";
  isRelay: boolean;
  host: string;
  port: number;
  username: string | null;
  passwordHint: string | null;
  active: boolean;
}

interface ProxyFormState {
  name: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: string;
  username: string;
  password: string;
}

interface BatchCreateResponse {
  created: number;
  skipped: Array<{ line: number; reason: string }>;
}

const EMPTY_FORM: ProxyFormState = { name: "", protocol: "socks5", host: "", port: "", username: "", password: "" };

// ── Proxy pool section (top - the actual proxy servers and pool-wide policy) ─

function ProxyPoolSection() {
  const qc = useQueryClient();
  const { data: settings, isLoading: settingsLoading } = useQuery({ queryKey: ["console", "proxy-settings"], queryFn: () => apiGet<ProxySettings>("/proxy-settings") });
  const { data: pool, isLoading: poolLoading } = useQuery({ queryKey: ["console", "proxies"], queryFn: () => apiGet<{ items: ProxyRecord[] }>("/proxies?limit=100") });

  const settingsMutation = useMutation({
    mutationFn: (patch: Partial<ProxySettings>) => apiPost<ProxySettings>("/proxy-settings", patch),
    onSuccess: (next) => qc.setQueryData(["console", "proxy-settings"], next),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const [modal, setModal] = useState<{ open: boolean; existing: ProxyRecord | null }>({ open: false, existing: null });
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);

  const setProxyStatus = (id: string, status: string) => {
    setStatuses((current) => ({ ...current, [id]: status }));
  };

  const runSavedTest = async (proxy: ProxyRecord, notify = true): Promise<void> => {
    setTestingIds((current) => new Set(current).add(proxy.id));
    setProxyStatus(proxy.id, "Testing…");
    try {
      const result = await apiPost<{ ok: boolean; latencyMs?: number; error?: string }>(`/proxies/${proxy.id}/test`);
      if (result.ok) {
        setProxyStatus(proxy.id, `Connected · ${result.latencyMs ?? 0}ms`);
        if (notify) toast.success(`${proxy.name}: connected in ${result.latencyMs ?? 0}ms`);
      } else {
        const status = `Last error: ${result.error ?? "connection failed"}`;
        setProxyStatus(proxy.id, status);
        if (notify) toast.error(`${proxy.name}: ${result.error ?? "connection failed"}`);
      }
    } catch (err) {
      const message = errorMessage(err);
      setProxyStatus(proxy.id, `Last error: ${message}`);
      if (notify) toast.error(`${proxy.name}: ${message}`);
    } finally {
      setTestingIds((current) => {
        const next = new Set(current);
        next.delete(proxy.id);
        return next;
      });
    }
  };

  const settingsData = settings ?? { enabled: false, excludedProviders: [], smartDynamicRouting: false, smartDynamicProxyCount: 2 };
  const items = pool?.items ?? [];
  const allSelected = items.length > 0 && items.every((proxy) => selectedIds.has(proxy.id));

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((proxy) => proxy.id)));
  };

  const runAllTests = async () => {
    if (items.length === 0) return;
    await Promise.all(items.map((proxy) => runSavedTest(proxy, false)));
    toast.success(`Tested ${items.length} proxies`);
  };

  const deleteSelected = async () => {
    const targets = items.filter((proxy) => selectedIds.has(proxy.id));
    if (targets.length === 0) return;
    try {
      await Promise.all(targets.map((proxy) => apiDelete<{ ok: boolean }>(`/proxies/${proxy.id}`)));
      setSelectedIds(new Set());
      setDeleteSelectedOpen(false);
      toast.success(`Deleted ${targets.length} proxies`);
      await qc.invalidateQueries({ queryKey: ["console", "proxies"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const exportSelected = () => {
    const targets = selectedIds.size > 0 ? items.filter((proxy) => selectedIds.has(proxy.id)) : items;
    const content = targets.map((proxy) => `${proxy.protocol}://${proxy.host}:${proxy.port}`).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cartethyia-proxies.txt";
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${targets.length} proxies`);
  };

  return (
    <Card className="space-y-4">
      <CardHeader title="Proxy Pool" icon={ShieldCheck} sub="Outbound proxy servers - HTTP, HTTPS, and SOCKS5, with automatic failover">
        <Button size="sm" onClick={() => setModal({ open: true, existing: null })}>
          <Plus size={14} /> New proxy
        </Button>
      </CardHeader>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3">
        <div>
          <div className="text-xs font-semibold">Route provider traffic through the proxy pool</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-3)]">Off by default - every provider connects directly until this is enabled.</div>
        </div>
        <Switch checked={settingsData.enabled} disabled={settingsLoading} onChange={(next) => settingsMutation.mutate({ enabled: next })} label="Enable proxy pool" />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold">Smart Dynamic Routing</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-3)]">Keeps a small sticky proxy set per client and switches only after the provider rate-limits that client.</div>
          <div className="mt-1 text-[10px] text-[var(--text-3)]">The client keeps these proxies sticky to preserve upstream cache locality; rotation is automatic on 429.</div>
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]" title="Number of sticky proxies assigned per client before dynamic rotation">
            Sticky proxies
            <Input type="number" min={1} max={10} value={settingsData.smartDynamicProxyCount} disabled={settingsLoading} onChange={(event) => settingsMutation.mutate({ smartDynamicProxyCount: Math.max(1, Math.min(10, Number(event.target.value) || 2)) })} className="h-8 w-14 px-2 text-center text-xs" />
          </label>
          <Switch checked={settingsData.smartDynamicRouting} disabled={settingsLoading} onChange={(next) => settingsMutation.mutate({ smartDynamicRouting: next })} label="Enable smart dynamic routing" />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2">
        <label className="flex items-center gap-2 text-[11px] text-[var(--text-2)]">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all proxies" />
          Select all
          {selectedIds.size > 0 && <span className="text-[var(--text-3)]">({selectedIds.size})</span>}
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="secondary" size="sm" disabled={items.length === 0 || testingIds.size > 0} onClick={() => void runAllTests()}>
            {testingIds.size > 0 ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Test all
          </Button>
          <Button variant="secondary" size="sm" disabled={items.length === 0} onClick={exportSelected}>
            <Download size={12} /> Export
          </Button>
          <Button variant="secondary" size="sm" disabled={selectedIds.size === 0} onClick={() => setDeleteSelectedOpen(true)}>
            <Trash2 size={12} /> Delete selected
          </Button>
        </div>
      </div>

      <div className="max-h-[17rem] overflow-auto rounded-xl border border-[var(--inner-border)]">
        {poolLoading ? (
          <div className="py-8 text-center text-xs text-[var(--text-3)]">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--text-3)]">No proxies yet - add one to start routing requests through the pool.</div>
        ) : (
          <table className="w-full table-fixed text-left text-[11px]">
            <thead className="sticky top-0 z-10 bg-[var(--hover)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              <tr>
                <th className="w-10 px-3 py-2.5">#</th>
                <th className="px-3 py-2.5">Name</th>
                <th className="hidden px-3 py-2.5 sm:table-cell">Endpoint</th>
                <th className="w-20 px-2 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((proxy, index) => (
                <tr key={proxy.id} className="border-t border-[var(--inner-border)] transition-colors hover:bg-[var(--hover)]">
                  <td className="px-3 py-2.5 align-top font-mono text-[10px] text-[var(--text-3)]">
                    <input type="checkbox" checked={selectedIds.has(proxy.id)} onChange={() => toggleSelected(proxy.id)} aria-label={`Select ${proxy.name}`} />
                    <span className="ml-2">{index + 1}</span>
                  </td>
                  <td className="max-w-0 px-3 py-2.5 align-top">
                    <div className="truncate text-xs font-semibold">{proxy.name}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-3)]">{statuses[proxy.id] ?? (proxy.active ? "Active" : "Disabled")}</div>
                    <code className="mt-0.5 block font-mono text-[10px] text-[var(--text-3)] sm:hidden">{proxy.host}:{proxy.port}</code>
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-[10px] text-[var(--text-3)] sm:table-cell">{proxy.protocol}://{proxy.host}:{proxy.port}</td>
                  <td className="w-20 px-2 py-2.5 align-top">
                    <div className="flex justify-end gap-0.5 whitespace-nowrap">
                      <Button variant="ghost" size="icon" className="size-7" title="Test connection" aria-label={`Test ${proxy.name}`} disabled={testingIds.has(proxy.id)} onClick={() => void runSavedTest(proxy)}>
                        {testingIds.has(proxy.id) ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" title="Edit proxy" aria-label={`Edit ${proxy.name}`} onClick={() => setModal({ open: true, existing: proxy })}>
                        <Pencil size={12} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal.open && <ProxyModal existing={modal.existing} onClose={() => setModal({ open: false, existing: null })} />}
      {deleteSelectedOpen && (
        <ConfirmDialog
          open
          title="Delete selected proxies?"
          message={`This will permanently remove ${selectedIds.size} selected proxies from the pool.`}
          confirmLabel="Delete selected"
          danger
          onClose={() => setDeleteSelectedOpen(false)}
          onConfirm={() => void deleteSelected()}
        />
      )}
    </Card>
  );
}

// ── Routing strategy + proxy exceptions (bottom - merged per-provider table) ─

function RoutingAndExceptionsSection() {
  const qc = useQueryClient();
  const { data: providers, isLoading } = useQuery({
    queryKey: ["console", "providers-routing"],
    queryFn: () => apiGet<{ items: ProviderRoutingSummary[] }>("/providers"),
  });
  const { data: settings } = useQuery({ queryKey: ["console", "proxy-settings"], queryFn: () => apiGet<ProxySettings>("/proxy-settings") });

  const routingMutation = useMutation({
    mutationFn: ({ id, config }: { id: string; config: { strategy?: string; stickyLimit?: number; useStickyLimit?: boolean } }) => apiPost<{ ok: boolean }>(`/providers/${id}/routing`, config),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["console", "providers-routing"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const [batchApplying, setBatchApplying] = useState<"priority" | "round-robin" | null>(null);
  const [stickyApplying, setStickyApplying] = useState(false);
  const applyStrategyToAll = async (strategy: "priority" | "round-robin") => {
    setBatchApplying(strategy);
    try {
      const eligible = (providers?.items ?? []).filter((p) => p.authKind !== "none");
      await Promise.all(eligible.map((p) => apiPost<{ ok: boolean }>(`/providers/${p.id}/routing`, { strategy })));
      await qc.invalidateQueries({ queryKey: ["console", "providers-routing"] });
      toast.success(`Strategy set to ${strategy === "priority" ? "Priority (failover)" : "Round-robin"} for ${eligible.length} provider${eligible.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBatchApplying(null);
    }
  };

  const toggleStickyLimit = async (enabled: boolean) => {
    setStickyApplying(true);
    try {
      const eligible = (providers?.items ?? []).filter((provider) => provider.authKind !== "none");
      await Promise.all(eligible.map((provider) => apiPost<{ ok: boolean }>(`/providers/${provider.id}/routing`, { useStickyLimit: enabled })));
      await qc.invalidateQueries({ queryKey: ["console", "providers-routing"] });
      toast.success(`Sticky limit ${enabled ? "enabled" : "disabled"} for ${eligible.length} provider${eligible.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStickyApplying(false);
    }
  };

  const settingsMutation = useMutation({
    mutationFn: (patch: Partial<ProxySettings>) => apiPost<ProxySettings>("/proxy-settings", patch),
    onSuccess: (next) => qc.setQueryData(["console", "proxy-settings"], next),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const excludedProviders = settings?.excludedProviders ?? [];
  const toggleExcluded = (id: string, excluded: boolean) => {
    const next = excluded ? [...excludedProviders, id] : excludedProviders.filter((p) => p !== id);
    settingsMutation.mutate({ excludedProviders: next });
  };

  const items = providers?.items ?? [];
  const stickyEnabled = items.some((provider) => provider.routing.useStickyLimit);

  return (
    <Card className="space-y-3">
      <CardHeader title="Routing Strategy" icon={Route} sub="Account rotation strategy, sticky limits, and proxy-pool exceptions per provider">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[var(--text-3)]">Set all:</span>
          <Button variant="secondary" size="sm" disabled={batchApplying !== null} onClick={() => void applyStrategyToAll("priority")}>
            {batchApplying === "priority" ? <Loader2 size={12} className="animate-spin" /> : null} Priority
          </Button>
          <Button variant="secondary" size="sm" disabled={batchApplying !== null} onClick={() => void applyStrategyToAll("round-robin")}>
            {batchApplying === "round-robin" ? <Loader2 size={12} className="animate-spin" /> : null} Round-robin
          </Button>
        </div>
      </CardHeader>
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold">Use sticky limit</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-3)]">Off by default. Enable it to show and apply per-provider sticky limits during round-robin account rotation.</div>
        </div>
        <Switch checked={stickyEnabled} disabled={isLoading || stickyApplying} onChange={(next) => void toggleStickyLimit(next)} label="Use sticky limit" />
      </div>
      {isLoading ? (
        <div className="py-6 text-center text-xs text-[var(--text-3)]">Loading…</div>
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-xs text-[var(--text-3)]">No providers registered yet.</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--inner-border)]">
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 z-10 bg-[var(--hover)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                <tr>
                  <th className="px-3 py-2.5">Provider</th>
                  <th className="px-3 py-2.5">Routing Strategy</th>
                  {stickyEnabled && <th className="px-3 py-2.5">Sticky limit</th>}
                  <th className="hidden px-3 py-2.5 sm:table-cell">Always direct (skip proxy)</th>
                </tr>
              </thead>
              <tbody>
                {items.map((provider) => {
                  const hasAccounts = provider.authKind !== "none";
                  const excluded = excludedProviders.includes(provider.id);
                  return (
                    <tr key={provider.id} className="border-t border-[var(--inner-border)]">
                      <td className="px-3 py-2 align-middle">
                        <div className="flex items-center gap-2">
                          <ProviderIcon icon={provider.icon} name={provider.name} size={20} />
                          <div className="min-w-0">
                            <span className="block truncate text-xs font-semibold">{provider.name}</span>
                            <span className="mt-1 flex items-center gap-1.5 sm:hidden"><Switch checked={excluded} onChange={(next) => toggleExcluded(provider.id, next)} label="Skip proxy" /></span>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        {hasAccounts ? (
                          <Select
                            ariaLabel={`${provider.name} strategy`}
                            className="w-40"
                            value={provider.routing.strategy}
                            onChange={(v) => routingMutation.mutate({ id: provider.id, config: { strategy: v } })}
                            options={[{ value: "priority", label: "Priority (failover)" }, { value: "round-robin", label: "Round-robin" }]}
                          />
                        ) : (
                          <span className="text-[11px] text-[var(--text-3)]">No accounts</span>
                        )}
                      </td>
                      {stickyEnabled && <td className="px-3 py-2 align-middle">
                        {hasAccounts ? (
                          <Input
                            aria-label={`${provider.name} sticky limit`}
                            type="number"
                            min={1}
                            max={100}
                            value={provider.routing.stickyLimit}
                            onChange={(event) => routingMutation.mutate({ id: provider.id, config: { stickyLimit: Math.max(1, Math.min(100, Number(event.target.value) || 1)) } })}
                            className="h-8 w-20 px-2 text-center text-xs"
                          />
                        ) : (
                          <span className="text-[11px] text-[var(--text-3)]">—</span>
                        )}
                      </td>}
                      <td className="hidden px-3 py-2 align-middle sm:table-cell">
                        <Switch checked={excluded} onChange={(next) => toggleExcluded(provider.id, next)} label={`${provider.name} always direct`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function ProxyModal({ existing, onClose }: { existing: ProxyRecord | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ProxyFormState>(
    existing
      ? { name: existing.name, protocol: existing.protocol, host: existing.host, port: String(existing.port), username: existing.username ?? "", password: "" }
      : EMPTY_FORM,
  );
  const [batchEntries, setBatchEntries] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const batchCount = batchEntries.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).length;
  const isNew = existing === null;

  const pasteFromClipboard = async () => {
    if (!navigator.clipboard) {
      toast.error("Clipboard unavailable on this origin");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error("Clipboard is empty");
        return;
      }
      setBatchEntries(text);
    } catch {
      toast.error("Clipboard access denied");
    }
  };

  const saveMutation = useMutation({
    mutationFn: async (): Promise<{ kind: "batch"; response: BatchCreateResponse } | { kind: "single"; response: { ok: boolean } }> => {
      if (isNew) {
        const entries = batchEntries.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
        if (entries.length === 0) throw new Error("Paste at least one proxy URL");
        const response = await apiPost<BatchCreateResponse>("/proxies/batch", { entries });
        return { kind: "batch", response };
      }
      const body = {
        name: form.name.trim(),
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim() || null,
        ...(form.password ? { password: form.password } : {}),
      };
      const response = await apiPost<{ ok: boolean }>(`/proxies/${existing.id}`, body);
      return { kind: "single", response };
    },
    onSuccess: ({ kind, response }) => {
      if (kind === "batch") {
        const skipped = response.skipped.length;
        toast.success(`${response.created} proxies added${skipped > 0 ? `, ${skipped} skipped` : ""}`);
      } else {
        toast.success("Proxy updated");
      }
      void qc.invalidateQueries({ queryKey: ["console", "proxies"] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const runAdhocTest = async () => {
    if (!form.host || !form.port) {
      toast.error("Host and port are required to test");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; latencyMs?: number; error?: string }>("/proxies/test", {
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim() || null,
        password: form.password || existing?.passwordHint ? form.password : null,
      });
      setTestResult(result.ok ? { ok: true, message: `Connected in ${result.latencyMs}ms` } : { ok: false, message: result.error ?? "Connection failed" });
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const valid = isNew
    ? batchCount > 0
    : form.name.trim().length > 0 && form.host.trim().length > 0 && Number(form.port) > 0 && Number(form.port) <= 65535;
  const protocolOptions = [{ value: "socks5", label: "SOCKS5" }, { value: "http", label: "HTTP" }, { value: "https", label: "HTTPS" }];

  return (
    <Dialog open onClose={onClose} title={isNew ? "New proxy" : "Edit proxy"}>
      <div className="space-y-3">
        {isNew ? (
          <>
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="proxy-batch-entries">Proxy URLs, one per line</Label>
                <Button type="button" variant="secondary" size="sm" onClick={() => void pasteFromClipboard()}><Clipboard size={13} /> Paste</Button>
              </div>
              <Textarea id="proxy-batch-entries" className="mt-1 w-full font-mono text-[11px]" rows={8} value={batchEntries} onChange={(e) => setBatchEntries(e.target.value)} placeholder={"http://host:8080\nhttps://user:password@host:443\nsocks5://host:1080"} autoFocus />
              <p className="mt-1 text-[10.5px] text-[var(--text-3)]">HTTP, HTTPS, and SOCKS5 are detected from each URL. Credentials are optional.</p>
            </div>
            <p className="text-[10.5px] text-[var(--text-3)]">Vercel and Cloudflare relays are detected automatically from their domain.</p>
          </>
        ) : (
          <>
            <div>
              <Label>Name</Label>
              <Input className="mt-1 w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <Label>Protocol</Label>
                <Select ariaLabel="Protocol" className="mt-1 w-full" value={form.protocol} onChange={(v) => setForm({ ...form, protocol: v as ProxyFormState["protocol"] })} options={protocolOptions} />
              </div>
              <div>
                <Label>Port</Label>
                <Input className="mt-1 w-full" type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Host</Label>
              <Input className="mt-1 w-full" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <Label>Username (optional)</Label>
                <Input className="mt-1 w-full" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div>
                <Label>Password{existing.passwordHint ? ` (${existing.passwordHint})` : " (optional)"}</Label>
                <Input className="mt-1 w-full" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={existing ? "Leave blank to keep" : ""} />
              </div>
            </div>
            <p className="text-[10.5px] text-[var(--text-3)]">Vercel and Cloudflare relay status is detected automatically from the hostname.</p>
          </>
        )}

        {testResult && (
          <div className={`rounded-lg px-3 py-2 text-[11px] font-semibold ${testResult.ok ? "bg-[var(--green-soft,rgba(48,209,88,0.12))] text-[var(--green)]" : "bg-[var(--red-soft,rgba(255,69,58,0.12))] text-[var(--red)]"}`}>
            {testResult.message}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {!isNew ? (
            <Button variant="secondary" size="sm" disabled={testing || !form.host || !form.port} onClick={() => void runAdhocTest()}>
              {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test connection
            </Button>
          ) : <span className="text-[10.5px] text-[var(--text-3)]">{batchCount} URL{batchCount === 1 ? "" : "s"} ready</span>}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!valid || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />} {isNew ? `Add ${batchCount} pro${batchCount === 1 ? "xy" : "xies"}` : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ── Main page ────────────────────────────────────────────────────────────

export function ProxyRequestsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Proxy & Requests</h1>
        <p className="text-xs text-[var(--text-2)]">Central controls for proxy behavior and request routing.</p>
      </div>
      <ProxyPoolSection />
      <RoutingAndExceptionsSection />
    </div>
  );
}

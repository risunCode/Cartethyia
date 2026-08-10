/**
 * Proxy & Requests - global routing controls (REQ: consolidate per-provider
 * account rotation strategy in one place, and the outbound proxy pool that
 * routes provider traffic through SOCKS5/HTTP/HTTPS proxies with anti-
 * interrupted failover).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Clipboard, Download, FlaskConical, Gauge, Loader2, Network, Pencil, Plus, PowerOff, Route, Search, Square, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "../../lib/toast";
import { getErrorMessage as errorMessage } from "../../lib/errors";
import { api, apiDelete, apiGet, apiPatch, apiPost } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { formatProxyTestTime } from "./formatters";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label, Textarea } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { StatePanel, StatCard } from "../../components/ui/state";
import { Select } from "../../components/ui/tabs";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";
import { ProviderIcon } from "../../components/provider-icon";


// ── Types ─────────────────────────────────────────────────────────────────

interface ProviderRoutingSummary {
  id: string;
  name: string;
  /** Brand icon key — not returned by the API; derived from `id`. */
  icon?: string;
  /** Credential kind from the API response. */
  credentialKind?: string;
  /** Derived from `credentialKind` for display logic. */
  authKind?: "none" | "session" | "api-key";
  routing?: { strategy: "priority" | "round-robin"; stickyLimit: number; useStickyLimit?: boolean };
}

interface ProxySettings {
  enabled: boolean;
  excludedProviders: string[];
  smartDynamicRouting: boolean;
  smartDynamicProxyCount: number;
  targetConcurrent: number;
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
  maxConcurrency: number;
  weight: number;
  active: boolean;
  lastTestAt: string | null;
  lastTestSuccessAt: string | null;
  lastTestSuccessLatencyMs: number | null;
  lastTestErrorAt: string | null;
  lastTestError: string | null;
  lastTestStatusCode: number | null;
  health?: {
    status: "healthy" | "cooling_down" | "error" | "disabled";
    statusCode: number | null;
    sanitizedMessage: string | null;
    occurredAt: string | null;
  } | null;
}

interface ProxyFormState {
  name: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: string;
  username: string;
  password: string;
  maxConcurrency: string;
  weight: string;
}

interface BatchCreateResponse {
  created: number;
  skipped: Array<{ line: number; reason: string }>;
}

interface BatchCheckResult {
  line: number;
  entry: string;
  ok: boolean;
  body?: Record<string, unknown>;
  latencyMs?: number;
  error?: string;
}

interface ScrapeCountry {
  code: string;
  name: string;
}

interface ProxySearchItem {
  url: string;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  country: string | null;
  status: "healthy" | "error" | "unverified";
  latencyMs: number | null;
  error: string | null;
  saved: boolean;
}

interface ProxySearchResult {
  items: ProxySearchItem[];
  scraped: number;
  verified: number;
}

const SCRAPE_SOURCES = [
  { value: "all", label: "All sources" },
  { value: "proxyscrape", label: "ProxyScrape" },
  { value: "geonode", label: "Geonode" },
  { value: "proxifly", label: "Proxifly" },
] as const;

const SCRAPE_PROTOCOLS = [
  { value: "all", label: "HTTP + SOCKS5" },
  { value: "http", label: "HTTP" },
  { value: "socks5", label: "SOCKS5" },
] as const;

function ProxySearchResults({ result }: { result: ProxySearchResult | null }) {
  const queryClient = useQueryClient();
  const [addingUrl, setAddingUrl] = useState<string | null>(null);
  if (result === null || result.items.length === 0) return null;

  const addProxy = async (item: ProxySearchItem): Promise<void> => {
    if (item.saved || item.status === "error") return;
    setAddingUrl(item.url);
    try {
      await apiPost<{ id: string }>("/proxies", {
        name: `${item.host}:${item.port}`,
        protocol: item.protocol,
        isRelay: false,
        host: item.host,
        port: item.port,
        maxConcurrency: 8,
        weight: 100,
      });
      queryClient.setQueryData<ProxySearchResult>(qk.proxies.search, (current) => current === undefined ? current : {
        ...current,
        items: current.items.map((candidate) => candidate.url === item.url ? { ...candidate, saved: true } : candidate),
      });
      await queryClient.invalidateQueries({ queryKey: qk.proxies.all });
      toast.success(`Added ${item.host}:${item.port}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setAddingUrl(null);
    }
  };

  return (
    <section aria-label="Proxy search results" className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold">Search results</p>
          <p className="text-[10.5px] text-[var(--text-3)]">Candidates stay here until you add them to the proxy pool.</p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <Badge tone="default">{result.scraped} found</Badge>
          <Badge tone="ok">{result.verified} healthy</Badge>
        </div>
      </div>
      <div className="grid max-h-[30rem] grid-cols-1 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-2 xl:grid-cols-3">
        {result.items.map((item, index) => {
          const statusLabel = item.status === "healthy" ? "Healthy" : item.status === "error" ? "Error" : "Unverified";
          const statusTone = item.status === "healthy" ? "ok" : item.status === "error" ? "err" : "default";
          return (
            <article key={item.url} className="rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)] p-3">
              <div className="flex items-start gap-2">
                <span className="font-mono text-[10px] text-[var(--text-3)]">{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <code className="truncate font-mono text-[11px] font-semibold">{item.host}:{item.port}</code>
                    <Badge tone={statusTone} className="ml-auto shrink-0">{statusLabel}</Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-[var(--text-2)]">{item.protocol}://{item.host}:{item.port}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="default">Region: {item.country ?? "Unknown"}</Badge>
                {item.latencyMs !== null && <Badge tone="default">{item.latencyMs}ms</Badge>}
                {item.error && <Badge tone="err" className="max-w-full truncate" title={item.error}>{item.error}</Badge>}
              </div>
              <Button className="mt-2 w-full" size="sm" variant={item.saved ? "ghost" : "secondary"} disabled={item.saved || item.status === "error" || addingUrl !== null} onClick={() => void addProxy(item)}>
                <Network size={12} /> {item.saved ? "Already in pool" : addingUrl === item.url ? "Adding…" : "Add to pool"}
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProxyScraperSection() {
  const queryClient = useQueryClient();
  const { data: countryData } = useQuery({ queryKey: ["console", "proxy-scrape-countries"], queryFn: () => apiGet<{ countries: ScrapeCountry[] }>("/proxies/scrape/countries") });
  const { data: searchResult = null, isFetching } = useQuery<ProxySearchResult | null>({
    queryKey: qk.proxies.search,
    queryFn: async () => null,
    enabled: false,
    initialData: null,
  });
  const [source, setSource] = useState<(typeof SCRAPE_SOURCES)[number]["value"]>("all");
  const [country, setCountry] = useState("all");
  const [protocol, setProtocol] = useState<(typeof SCRAPE_PROTOCOLS)[number]["value"]>("all");
  const [limit, setLimit] = useState("50");
  const [verify, setVerify] = useState(true);
  const countries = countryData?.countries ?? [{ code: "all", name: "Any region" }];

  const search = async (): Promise<void> => {
    try {
      const result = await queryClient.fetchQuery({
        queryKey: qk.proxies.search,
        queryFn: ({ signal }: { signal: AbortSignal }) => api<ProxySearchResult>("/proxies/search", {
          method: "POST",
          body: JSON.stringify({ source, country, protocol, limit: Math.max(1, Math.min(500, Number(limit) || 50)), verify }),
          signal,
        }),
        staleTime: 0,
      });
      if (result.scraped === 0) toast.error("No proxies found from the selected source");
      else toast.success(`Found ${result.scraped} proxies · ${result.verified} healthy`);
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "CancelledError")) toast.success("Proxy search stopped");
      else toast.error(errorMessage(error));
    }
  };

  const toggleSearch = async (): Promise<void> => {
    if (isFetching) {
      await queryClient.cancelQueries({ queryKey: qk.proxies.search });
      return;
    }
    void search();
  };

  return (
    <Card surface="frame" className="space-y-3">
      <CardHeader title="Proxy Scraper" icon={Search} sub="Search candidates first, review their status, then add only the proxies you want">
        <Button size="sm" className="w-full sm:w-auto" onClick={() => void toggleSearch()}>
          {isFetching ? <Square size={12} /> : <Search size={13} />} {isFetching ? "Stop search" : "Search proxies"}
        </Button>
      </CardHeader>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <label className="text-[10.5px] text-[var(--text-3)]">
          Source
          <Select ariaLabel="Scrape source" className="mt-1 w-full" value={source} onChange={(value) => setSource(value as typeof source)} options={SCRAPE_SOURCES} />
        </label>
        <label className="text-[10.5px] text-[var(--text-3)]">
          Region
          <Select ariaLabel="Scrape region" className="mt-1 w-full" value={country} onChange={setCountry} options={countries.map((item) => ({ value: item.code, label: item.name }))} />
        </label>
        <label className="text-[10.5px] text-[var(--text-3)]">
          Protocol
          <Select ariaLabel="Scrape protocol" className="mt-1 w-full" value={protocol} onChange={(value) => setProtocol(value as typeof protocol)} options={SCRAPE_PROTOCOLS} />
        </label>
        <label className="text-[10.5px] text-[var(--text-3)]">
          Candidate limit
          <Input className="mt-1 h-9 w-full" type="number" min={1} max={500} value={limit} onChange={(event) => setLimit(event.target.value)} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-[11px] text-[var(--text-2)]">
        <input className="mt-0.5 size-3.5" type="checkbox" checked={verify} onChange={(event) => setVerify(event.target.checked)} />
        <span><span className="block font-semibold">Verify before listing</span><span className="mt-0.5 block text-[10px] text-[var(--text-3)]">Healthy, failed, and unverified candidates are shown here; nothing is saved automatically.</span></span>
      </label>
      <ProxySearchResults result={searchResult} />
    </Card>
  );
}

const EMPTY_FORM: ProxyFormState = { name: "", protocol: "socks5", host: "", port: "", username: "", password: "", maxConcurrency: "8", weight: "100" };


function parseProxyEntry(entry: string): { readonly body: Record<string, unknown> } | { readonly error: string } {
  try {
    const parsed = new URL(entry);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks5:") return { error: "unsupported protocol" };
    if (!parsed.hostname) return { error: "host is required" };
    const protocol = parsed.protocol.slice(0, -1) as "http" | "https" | "socks5";
    const port = Number(parsed.port || (protocol === "https" ? 443 : protocol === "http" ? 80 : 1080));
    const normalizedHost = parsed.hostname.toLowerCase();
    const isRelay = normalizedHost.endsWith(".vercel.app") || normalizedHost.endsWith(".workers.dev") || normalizedHost.endsWith(".netlify.app");
    return {
      body: {
        name: `${parsed.hostname}:${port}`,
        protocol,
        isRelay,
        host: parsed.hostname,
        port,
        username: parsed.username ? decodeURIComponent(parsed.username) : null,
        password: parsed.password ? decodeURIComponent(parsed.password) : null,
        maxConcurrency: 8,
        weight: 100,
      },
    };
  } catch {
    return { error: "invalid proxy URL" };
  }
}

// ── Proxy pool section (top - the actual proxy servers and pool-wide policy) ─

function ProxyPoolSection() {
  const qc = useQueryClient();
  const { data: pool, isLoading: poolLoading } = useQuery({ queryKey: qk.proxies.all, queryFn: () => apiGet<{ items: ProxyRecord[] }>("/proxies?limit=100") });

  const activeMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => apiPatch<{ ok: boolean }>(`/proxies/${id}`, { active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.proxies.all }); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const [modal, setModal] = useState<{ open: boolean; mounted: boolean; existing: ProxyRecord | null }>({ open: false, mounted: false, existing: null });
  const openModal = (existing: ProxyRecord | null) => setModal({ open: true, mounted: true, existing });
  const closeModal = () => setModal((current) => ({ ...current, open: false }));
  const finishModalExit = () => setModal({ open: false, mounted: false, existing: null });
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [deleteErrorOpen, setDeleteErrorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProxyRecord | null>(null);

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
      await qc.invalidateQueries({ queryKey: qk.proxies.all });
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
  const items = pool?.items ?? [];
  const errorItems = items.filter((proxy) => proxy.health?.status === "error");
  const testedCount = items.filter((proxy) => proxy.lastTestAt != null).length;
  const successCount = items.filter((proxy) => proxy.lastTestSuccessAt != null && proxy.lastTestAt === proxy.lastTestSuccessAt).length;
  const errorCount = items.filter((proxy) => proxy.lastTestErrorAt != null && proxy.lastTestAt === proxy.lastTestErrorAt).length;
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
      await qc.invalidateQueries({ queryKey: qk.proxies.all });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const deleteErrorProxies = async (): Promise<void> => {
    const targets = errorItems;
    if (targets.length === 0) return;
    const errorIds = new Set(targets.map((proxy) => proxy.id));
    try {
      await Promise.all(targets.map((proxy) => apiDelete<{ ok: boolean }>(`/proxies/${proxy.id}`)));
      setSelectedIds((current) => new Set([...current].filter((id) => !errorIds.has(id))));
      setDeleteErrorOpen(false);
      toast.success(`Deleted ${targets.length} error proxies`);
      await qc.invalidateQueries({ queryKey: qk.proxies.all });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const disableSelected = async (): Promise<void> => {
    const targets = items.filter((proxy) => selectedIds.has(proxy.id));
    if (targets.length === 0) return;
    try {
      await Promise.all(targets.map((proxy) => apiPatch<{ ok: boolean }>(`/proxies/${proxy.id}`, { active: false })));
      setSelectedIds(new Set());
      toast.success(`Disabled ${targets.length} proxies`);
      await qc.invalidateQueries({ queryKey: qk.proxies.all });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const deleteProxy = async (): Promise<void> => {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    try {
      await apiDelete<{ ok: boolean }>(`/proxies/${target.id}`);
      setDeleteTarget(null);
      toast.success(`Deleted ${target.name}`);
      await qc.invalidateQueries({ queryKey: qk.proxies.all });
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
    <Card surface="frame" className="space-y-4">
      <CardHeader title="Proxy Pool" icon={ShieldCheck} sub="Outbound proxy servers - HTTP, HTTPS, and SOCKS5, with automatic failover">
        <Button size="sm" className="w-full sm:w-auto" onClick={() => openModal(null)}>
          <Plus size={14} /> New proxy
        </Button>
      </CardHeader>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <StatCard label="Enabled pool" icon={ShieldCheck} tone="accent" value={<>{items.filter((proxy) => proxy.active).length}<span className="ml-1 text-[11px] font-normal text-[var(--text-3)]">/ {items.length}</span></>} loading={poolLoading} />
        <StatCard label="Route capacity" icon={Gauge} tone="info" value={<>{items.reduce((total, proxy) => total + (proxy.active ? proxy.maxConcurrency : 0), 0)}<span className="ml-1 text-[11px] font-normal text-[var(--text-3)]">in-flight</span></>} loading={poolLoading} />
        <StatCard label="Weighted units" icon={Activity} tone="neutral" value={items.reduce((total, proxy) => total + (proxy.active ? proxy.weight : 0), 0)} loading={poolLoading} />
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-2)]">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all proxies" />
            Select all
            {selectedIds.size > 0 && <span className="text-[var(--text-3)]">({selectedIds.size})</span>}
          </label>
          {items.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-[10px]" aria-live="polite">
            <span className="text-[var(--text-3)]">Tested {testedCount}/{items.length}</span>
            <Badge tone="ok">{successCount} success</Badge>
            <Badge tone="err">{errorCount} errors</Badge>
          </div>}
        </div>
        <div className="grid w-full grid-cols-1 gap-1.5 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" disabled={items.length === 0 || testingIds.size > 0} onClick={() => void runAllTests()}>
            {testingIds.size > 0 ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Test all
          </Button>
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" disabled={items.length === 0} onClick={exportSelected}>
            <Download size={12} /> Export
          </Button>
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" disabled={selectedIds.size === 0} onClick={() => void disableSelected()}>
            <PowerOff size={12} /> Disable selected
          </Button>
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" disabled={selectedIds.size === 0} onClick={() => setDeleteSelectedOpen(true)}>
            <Trash2 size={12} /> Delete selected
          </Button>
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" disabled={errorItems.length === 0} onClick={() => setDeleteErrorOpen(true)}>
            <Trash2 size={12} /> Delete error proxies
          </Button>
        </div>
      </div>

      <div className="scrollbar-fade max-h-[28rem] overflow-y-auto pr-0.5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {poolLoading ? (
          <div className="sm:col-span-2 xl:col-span-3">
            <StatePanel kind="loading" title="Loading proxies" description="Reading the proxy pool…" icon={ShieldCheck} />
          </div>
        ) : items.length === 0 ? (
          <div className="sm:col-span-2 xl:col-span-3 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--accent)]/30 bg-[var(--accent-soft)]/40 px-6 py-12 text-center">
            <Network size={28} className="text-[var(--accent)]" />
            <div>
              <p className="text-sm font-bold">No proxies yet</p>
              <p className="mt-1 text-xs text-[var(--text-3)]">Add one to start routing requests through the pool.</p>
            </div>
            <Button size="sm" onClick={() => openModal(null)}><Plus size={14} /> New proxy</Button>
          </div>
        ) : items.map((proxy, index) => {
          const persistedStatus = proxy.health?.status === "error"
            ? `Error${proxy.health.sanitizedMessage ? `: ${proxy.health.sanitizedMessage}` : " · Connection failed"}${proxy.health.occurredAt ? ` · ${formatProxyTestTime(proxy.health.occurredAt)}` : ""}`
            : proxy.health?.status === "healthy"
              ? `Healthy${proxy.lastTestSuccessLatencyMs !== null ? ` · ${proxy.lastTestSuccessLatencyMs}ms` : ""}${proxy.health.occurredAt ? ` · ${formatProxyTestTime(proxy.health.occurredAt)}` : ""}`
              : proxy.active ? "Active" : "Disabled";
          const status = statuses[proxy.id] ?? persistedStatus;
          const isTesting = testingIds.has(proxy.id);
          const hasError = proxy.health?.status === "error";
          return (
            <article key={proxy.id} className="rounded-2xl border border-[var(--inner-border)] bg-[var(--surface-1)] p-3.5 transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--surface-muted)]">
              <div className="flex items-start gap-3">
                <input className="mt-1 size-3.5 shrink-0" type="checkbox" checked={selectedIds.has(proxy.id)} onChange={() => toggleSelected(proxy.id)} aria-label={`Select ${proxy.name}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-[10px] text-[var(--text-3)]">{String(index + 1).padStart(2, "0")}</span>
                    <span className="truncate text-xs font-semibold">{proxy.name}</span>
                    <Badge tone={proxy.active ? "ok" : "default"} className="ml-auto shrink-0">{proxy.active ? "Active" : "Disabled"}</Badge>
                  </div>
                  <code className="mt-1 block truncate font-mono text-[10px] text-[var(--text-2)]">{proxy.protocol}://{proxy.host}:{proxy.port}</code>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone="default">cap {proxy.maxConcurrency}</Badge>
                    <Badge tone="default">weight {proxy.weight}</Badge>
                    <Badge tone={hasError ? "err" : "ok"} className="max-w-full truncate" title={hasError ? (proxy.lastTestError ?? "Connection failed") : undefined}>{status}</Badge>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--inner-border)] pt-3">
                <Button variant="secondary" size="sm" disabled={isTesting} onClick={() => void runSavedTest(proxy)}>
                  {isTesting ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Test
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openModal(proxy)}>
                  <Pencil size={12} /> Edit
                </Button>
                <Button variant="ghost" size="icon" className="size-8 text-[var(--red)]" title="Delete proxy" aria-label={`Delete ${proxy.name}`} onClick={() => setDeleteTarget(proxy)}>
                  <Trash2 size={13} />
                </Button>
                <div className="ml-auto">
                  <Switch checked={proxy.active} disabled={activeMutation.isPending} onChange={(active) => activeMutation.mutate({ id: proxy.id, active })} label={`${proxy.active ? "Disable" : "Enable"} ${proxy.name}`} />
                </div>
              </div>
            </article>
          );
        })}
      </div>
      </div>

      {modal.mounted && <ProxyModal open={modal.open} existing={modal.existing} onClose={closeModal} onExited={finishModalExit} />}
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
      {deleteErrorOpen && (
        <ConfirmDialog
          open
          title="Delete error proxies?"
          message={`This will permanently remove ${errorItems.length} proxies currently marked as errors.`}
          confirmLabel="Delete error proxies"
          danger
          onClose={() => setDeleteErrorOpen(false)}
          onConfirm={() => void deleteErrorProxies()}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          open
          title={`Delete ${deleteTarget.name}?`}
          message="This proxy will be removed from the pool and cannot be used for routing."
          confirmLabel="Delete proxy"
          danger
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteProxy()}
        />
      )}
    </Card>
  );
}

// ── Routing strategy + proxy exceptions (bottom - merged per-provider table) ─

function RoutingAndExceptionsSection() {
  const qc = useQueryClient();
  const { data: providers, isLoading } = useQuery({
    queryKey: qk.routing.all,
    queryFn: () => apiGet<{ items: ProviderRoutingSummary[] }>("/providers"),
  });
  const { data: settings } = useQuery({ queryKey: qk.proxySettings.all, queryFn: () => apiGet<ProxySettings>("/proxy-settings") });

  const routingMutation = useMutation({
    mutationFn: ({ id, config }: { id: string; config: { strategy?: string; stickyLimit?: number; useStickyLimit?: boolean } }) => apiPost<{ ok: boolean }>(`/providers/${id}/routing`, config),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.routing.all }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const [batchApplying, setBatchApplying] = useState<"priority" | "round-robin" | null>(null);
  const [stickyApplying, setStickyApplying] = useState(false);
  const applyStrategyToAll = async (strategy: "priority" | "round-robin") => {
    setBatchApplying(strategy);
    try {
      const eligible = (providers?.items ?? []).filter((p) => p.authKind !== "none");
      await Promise.all(eligible.map((p) => apiPost<{ ok: boolean }>(`/providers/${p.id}/routing`, { strategy })));
      await qc.invalidateQueries({ queryKey: qk.routing.all });
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
      await qc.invalidateQueries({ queryKey: qk.routing.all });
      toast.success(`Sticky limit ${enabled ? "enabled" : "disabled"} for ${eligible.length} provider${eligible.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStickyApplying(false);
    }
  };

  const setStickyLimitForAll = async (value: number): Promise<void> => {
    const stickyLimit = Math.max(1, Math.min(100, Math.round(value) || 1));
    setStickyApplying(true);
    try {
      const eligible = (providers?.items ?? []).filter((provider) => provider.authKind !== "none");
      await Promise.all(eligible.map((provider) => apiPost<{ ok: boolean }>(`/providers/${provider.id}/routing`, { stickyLimit })));
      await qc.invalidateQueries({ queryKey: qk.routing.all });
      toast.success(`Sticky limit set to ${stickyLimit} for ${eligible.length} provider${eligible.length === 1 ? "" : "s"}`);
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
  const eligibleProviders = items.filter((provider) => provider.authKind !== "none");
  const stickyEnabled = eligibleProviders.length > 0 && eligibleProviders.every((provider) => provider.routing?.useStickyLimit === true);
  const stickyVisible = eligibleProviders.some((provider) => provider.routing?.useStickyLimit === true);
  const globalStickyLimit = eligibleProviders.at(0)?.routing?.stickyLimit ?? 1;

  return (
    <Card className="space-y-3">
      <CardHeader title="Routing Strategy" icon={Route} sub="Account rotation strategy, sticky limits, and proxy-pool exceptions per provider">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span className="text-[11px] text-[var(--text-3)]">Set all:</span>
          <Button variant="secondary" size="sm" disabled={batchApplying !== null || stickyApplying} onClick={() => void applyStrategyToAll("priority")}>
            {batchApplying === "priority" ? <Loader2 size={12} className="animate-spin" /> : null} Priority
          </Button>
          <Button variant="secondary" size="sm" disabled={batchApplying !== null || stickyApplying} onClick={() => void applyStrategyToAll("round-robin")}>
            {batchApplying === "round-robin" ? <Loader2 size={12} className="animate-spin" /> : null} Round-robin
          </Button>
        </div>
      </CardHeader>
      <div className="flex flex-col gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold">Use sticky limit</div>
          <div className="mt-0.5 text-[11px] text-[var(--text-3)]">Apply sticky account routing across every provider with configured accounts.</div>
          <div className="mt-1 text-[10px] text-[var(--text-3)]">Turn it on globally here, then fine-tune each provider&apos;s sticky limit below.</div>
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]" title="Set the sticky account limit for every provider">
            Sticky limit
            <Input
              aria-label="Global sticky limit"
              type="number"
              min={1}
              max={100}
              value={globalStickyLimit}
              disabled={isLoading || stickyApplying || batchApplying !== null}
              onChange={(event) => void setStickyLimitForAll(Number(event.target.value))}
              className="h-8 w-16 px-2 text-center text-xs"
            />
          </label>
          <Switch checked={stickyEnabled} disabled={isLoading || stickyApplying || batchApplying !== null} onChange={(next) => void toggleStickyLimit(next)} label="Use sticky limit for all providers" />
        </div>
      </div>
      {isLoading ? (
        <StatePanel kind="loading" title="Loading providers" description="Reading provider routing config…" icon={Route} />
      ) : items.length === 0 ? (
        <StatePanel kind="empty" title="No providers registered" description="Add provider accounts to configure routing strategy." icon={Route} />
      ) : (
        <div className="scrollbar-fade max-h-[28rem] overflow-y-auto pr-0.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((provider) => {
              const icon = provider.icon ?? provider.id;
              const authKind = provider.authKind ?? (provider.credentialKind === "oauth" ? "session" : provider.credentialKind === "api_key" ? "api-key" : "none");
              const hasAccounts = authKind !== "none";
              const excluded = excludedProviders.includes(provider.id);
              const routing = provider.routing ?? { strategy: "priority" as const, stickyLimit: 1 };
              return (
                <article key={provider.id} className="rounded-2xl border border-[var(--inner-border)] bg-[var(--surface-1)] p-3.5 transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--surface-muted)]">
                  <div className="flex flex-col gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ProviderIcon icon={icon} name={provider.name} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold">{provider.name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge tone={hasAccounts ? "info" : "default"}>{hasAccounts ? authKind : "No accounts"}</Badge>
                          <Badge tone={excluded ? "warn" : "ok"}>{excluded ? "Direct connection" : "Proxy pool eligible"}</Badge>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--inner-border)] pt-3">
                      <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
                        Strategy
                        {hasAccounts ? (
                          <Select
                            ariaLabel={`${provider.name} strategy`}
                            className="w-40"
                            value={routing.strategy}
                            onChange={(v) => routingMutation.mutate({ id: provider.id, config: { strategy: v } })}
                            options={[{ value: "priority", label: "Priority (failover)" }, { value: "round-robin", label: "Round-robin" }]}
                          />
                        ) : (
                          <span className="rounded-lg border border-[var(--inner-border)] px-2.5 py-2 text-[10px]">No accounts</span>
                        )}
                      </label>
                      {stickyVisible && <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
                        Sticky
                        {hasAccounts ? (
                          <Input
                            aria-label={`${provider.name} sticky limit`}
                            type="number"
                            min={1}
                            max={100}
                            value={routing.stickyLimit}
                            onChange={(event) => routingMutation.mutate({ id: provider.id, config: { stickyLimit: Math.max(1, Math.min(100, Number(event.target.value) || 1)) } })}
                            className="h-8 w-16 px-2 text-center text-xs"
                          />
                        ) : <span>—</span>}
                      </label>}
                      <div className="ml-auto flex items-center gap-1.5">
                        <span className="text-[10px] text-[var(--text-3)]">Always direct</span>
                        <Switch checked={excluded} onChange={(next) => toggleExcluded(provider.id, next)} label={`${provider.name} always direct`} />
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function ProxyModal({ open, existing, onClose, onExited }: { open: boolean; existing: ProxyRecord | null; onClose: () => void; onExited: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ProxyFormState>(
    existing
      ? { name: existing.name, protocol: existing.protocol, host: existing.host, port: String(existing.port), username: existing.username ?? "", password: "", maxConcurrency: String(existing.maxConcurrency ?? 8), weight: String(existing.weight ?? 100) }
      : EMPTY_FORM,
  );
  const [batchEntries, setBatchEntries] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [checkBeforeAdd, setCheckBeforeAdd] = useState(false);
  const [checkingBatch, setCheckingBatch] = useState(false);
  const [batchCheckResults, setBatchCheckResults] = useState<BatchCheckResult[] | null>(null);
  const [checkedBatchInput, setCheckedBatchInput] = useState("");
  const batchEntriesList = batchEntries.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const batchCount = batchEntriesList.length;
  const batchInputKey = batchEntriesList.join("\n");
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
      setBatchCheckResults(null);
      setCheckedBatchInput("");
    } catch {
      toast.error("Clipboard access denied");
    }
  };

  const checkBatch = async (): Promise<void> => {
    if (batchEntriesList.length === 0) {
      toast.error("Paste at least one proxy URL");
      return;
    }
    setCheckingBatch(true);
    setBatchCheckResults(null);
    try {
      const results = await Promise.all(batchEntriesList.map(async (entry, index): Promise<BatchCheckResult> => {
        const parsed = parseProxyEntry(entry);
        if ("error" in parsed) return { line: index + 1, entry, ok: false, error: parsed.error };
        try {
          const result = await apiPost<{ ok: boolean; latencyMs?: number; error?: string }>("/proxies/test", parsed.body);
          return { line: index + 1, entry, body: parsed.body, ok: result.ok, latencyMs: result.latencyMs, error: result.error };
        } catch (error) {
          return { line: index + 1, entry, body: parsed.body, ok: false, error: errorMessage(error) };
        }
      }));
      setBatchCheckResults(results);
      setCheckedBatchInput(batchInputKey);
    } finally {
      setCheckingBatch(false);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async (): Promise<{ kind: "batch"; response: BatchCreateResponse } | { kind: "single"; response: { ok: boolean } }> => {
      if (isNew) {
        const entries = batchEntriesList;
        if (entries.length === 0) throw new Error("Paste at least one proxy URL");
        if (checkBeforeAdd) {
          if (batchCheckResults === null || checkedBatchInput !== batchInputKey) throw new Error("Run Check proxies before adding");
          const skipped: Array<{ line: number; reason: string }> = batchCheckResults.filter((result) => !result.ok).map((result) => ({ line: result.line, reason: result.error ?? "proxy check failed" }));
          const healthy = batchCheckResults.filter((result): result is BatchCheckResult & { body: Record<string, unknown> } => result.ok && result.body !== undefined);
          const createdResults = await Promise.all(healthy.map(async (result) => {
            try {
              await apiPost<{ id: string }>("/proxies", result.body);
              return null;
            } catch (error) {
              return { line: result.line, reason: errorMessage(error) };
            }
          }));
          skipped.push(...createdResults.filter((result): result is { line: number; reason: string } => result !== null));
          return { kind: "batch", response: { created: healthy.length - createdResults.filter((result) => result !== null).length, skipped } };
        }
        const results = await Promise.all(entries.map(async (entry, index) => {
          const parsed = parseProxyEntry(entry);
          if ("error" in parsed) return { line: index + 1, reason: parsed.error };
          try {
            await apiPost<{ id: string }>("/proxies", parsed.body);
            return null;
          } catch (error) {
            return { line: index + 1, reason: errorMessage(error) };
          }
        }));
        const skipped = results.filter((result): result is { line: number; reason: string } => result !== null);
        return { kind: "batch", response: { created: entries.length - skipped.length, skipped } };
      }
      const body = {
        name: form.name.trim(),
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim() || null,
        maxConcurrency: Math.max(1, Math.min(10000, Number(form.maxConcurrency) || 8)),
        weight: Math.max(1, Math.min(1000, Number(form.weight) || 100)),
        ...(form.password ? { password: form.password } : {}),
      };
      const response = await apiPatch<{ ok: boolean }>(`/proxies/${existing.id}`, body);
      return { kind: "single", response };
    },
    onSuccess: ({ kind, response }) => {
      if (kind === "batch") {
        const skipped = response.skipped.length;
        if (skipped === 0) toast.success(`${response.created} proxies added`);
        else {
          const details = response.skipped.slice(0, 3).map((entry) => `line ${entry.line}: ${entry.reason}`).join(" · ");
          toast.error(`${response.created} added, ${skipped} skipped${details ? ` — ${details}` : ""}`);
        }
      } else {
        toast.success("Proxy updated");
      }
      void qc.invalidateQueries({ queryKey: qk.proxies.all });
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
  const checkedReadyCount = batchCheckResults?.filter((result) => result.ok).length ?? 0;
  const canSave = valid && (!isNew || !checkBeforeAdd || (batchCheckResults !== null && checkedBatchInput === batchInputKey && checkedReadyCount > 0));
  const protocolOptions = [{ value: "socks5", label: "SOCKS5" }, { value: "http", label: "HTTP" }, { value: "https", label: "HTTPS" }];

  return (
    <Dialog open={open} onClose={onClose} onExited={onExited} title={isNew ? "New proxy" : "Edit proxy"}>
      <div className="space-y-3">
        {isNew ? (
          <>
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="proxy-batch-entries">Proxy URLs, one per line</Label>
                <Button type="button" variant="secondary" size="sm" onClick={() => void pasteFromClipboard()}><Clipboard size={13} /> Paste</Button>
              </div>
              <Textarea id="proxy-batch-entries" className="mt-1 w-full font-mono text-[11px]" rows={8} value={batchEntries} onChange={(e) => { setBatchEntries(e.target.value); setBatchCheckResults(null); setCheckedBatchInput(""); }} placeholder={"http://host:8080\nhttps://user:password@host:443\nsocks5://host:1080"} autoFocus />
              <p className="mt-1 text-[10.5px] text-[var(--text-3)]">HTTP, HTTPS, and SOCKS5 are detected from each URL. Credentials are optional.</p>
            </div>
            <p className="text-[10.5px] text-[var(--text-3)]">Vercel, Netlify, and Cloudflare relays are detected automatically from their domain.</p>
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex items-start gap-2 text-[11px] text-[var(--text-2)]">
                <input className="mt-0.5 size-3.5" type="checkbox" checked={checkBeforeAdd} onChange={(event) => { setCheckBeforeAdd(event.target.checked); setBatchCheckResults(null); setCheckedBatchInput(""); }} />
                <span><span className="block font-semibold">Check proxies before adding</span><span className="mt-0.5 block text-[10px] text-[var(--text-3)]">Only healthy proxies will be added as active.</span></span>
              </label>
              <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" disabled={!checkBeforeAdd || batchCount === 0 || checkingBatch} onClick={() => void checkBatch()}>
                {checkingBatch ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />} {checkingBatch ? "Checking…" : "Check proxies"}
              </Button>
            </div>
            {checkBeforeAdd && batchCheckResults !== null && (() => {
              const ready = batchCheckResults.filter((result) => result.ok).length;
              const failed = batchCheckResults.length - ready;
              return <div className="space-y-2 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 py-2.5" aria-live="polite">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]"><span className="font-semibold text-[var(--text-1)]">Check summary</span><span className="text-[var(--text-3)]">{batchCheckResults.length} checked</span><span className="rounded-full bg-[var(--green-soft,rgba(48,209,88,0.10))] px-2 py-0.5 text-[var(--green)]">{ready} ready</span><span className="rounded-full bg-[var(--red-soft,rgba(255,69,58,0.10))] px-2 py-0.5 text-[var(--red)]">{failed} failed</span></div>
                <div className="max-h-28 space-y-1 overflow-auto text-[10px]">{batchCheckResults.map((result) => <div key={`${result.line}-${result.entry}`} className="flex min-w-0 items-center gap-2"><span className={result.ok ? "text-[var(--green)]" : "text-[var(--red)]"}>{result.ok ? "OK" : "FAIL"}</span><span className="min-w-0 flex-1 truncate font-mono text-[var(--text-3)]">{result.entry}</span><span className="shrink-0 text-[var(--text-3)]">{result.ok ? `${result.latencyMs ?? 0}ms` : result.error ?? "check failed"}</span></div>)}</div>
              </div>;
            })()}
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
                <Label>Max concurrent</Label>
                <Input className="mt-1 w-full" type="number" min={1} max={10000} value={form.maxConcurrency} onChange={(e) => setForm({ ...form, maxConcurrency: e.target.value })} />
              </div>
              <div>
                <Label>Weight</Label>
                <Input className="mt-1 w-full" type="number" min={1} max={1000} value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
              </div>
              <div>
                <Label>Username (optional)</Label>
                <Input className="mt-1 w-full" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div>
                <Label>Password{existing.passwordHint ? ` (${existing.passwordHint})` : " (optional)"}</Label>
                <Input className="mt-1 w-full" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={existing ? "Leave blank to keep" : ""} />
              </div>
            </div>
            <p className="text-[10.5px] text-[var(--text-3)]">Vercel, Netlify, and Cloudflare relay status is detected automatically from the hostname.</p>
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
          ) : <span className="text-[10.5px] text-[var(--text-3)]">{checkBeforeAdd && batchCheckResults !== null ? `${checkedReadyCount} healthy of ${batchCount} checked` : `${batchCount} URL${batchCount === 1 ? "" : "s"} ready`}</span>}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!canSave || saveMutation.isPending || checkingBatch} onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />} {isNew ? `Add ${checkBeforeAdd && batchCheckResults !== null ? checkedReadyCount : batchCount} pro${(checkBeforeAdd && batchCheckResults !== null ? checkedReadyCount : batchCount) === 1 ? "xy" : "xies"}` : "Save"}
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
    <div className="dashboard-page space-y-4">
      <ProxyScraperSection />
      <ProxyPoolSection />
      <RoutingAndExceptionsSection />
    </div>
  );
}

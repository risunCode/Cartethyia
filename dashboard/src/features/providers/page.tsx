/** Providers page — registry list grouped by credential kind (REQ-11). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, ChevronRight, Plus, Square, Trash2 } from "lucide-react";
import { HeaderPairsEditor, pairsToHeaders, type HeaderPair } from "../../components/header-pairs-editor";
import { memo, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "../../lib/toast";
import { apiGet, apiPost, apiDelete } from "../../lib/api";
import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { StatePanel } from "../../components/ui/state";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/shared";
import { useProviders } from "../../components/model-picker";

interface ProviderInfo {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "oauth" | "api-key";
  prefix: string;
  modelCount: number;
  status: "ok" | "warn";
  connections: number;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
}

/** Display order for built-in providers: free tier, OAuth, then API key/PAT. */
const SECTIONS: { authKinds: ProviderInfo["authKind"][]; title: string }[] = [
  { authKinds: ["none"], title: "Free Tier Providers" },
  { authKinds: ["session", "oauth"], title: "OAuth Providers" },
  { authKinds: ["api-key"], title: "API Key Providers" },
];

// ── Custom Providers (OpenAI/Anthropic Compatible) ──────────────────────

interface CustomProviderRecord {
  id: string;
  slug: string;
  name: string;
  kind: "openai" | "anthropic" | "openai-compatible";
  baseUrl: string;
  credentialHint: string;
  timeoutSeconds: number;
  autoFetchModels: boolean;
  customHeaders: Record<string, string>;
}

const COMPAT_DEFAULTS: Record<"openai-compatible" | "anthropic-compatible", { namePh: string; prefixPh: string }> = {
  "openai-compatible": { namePh: "OpenAI Compatible (Prod)", prefixPh: "oc-prod" },
  "anthropic-compatible": { namePh: "Anthropic Compatible (Prod)", prefixPh: "ac-prod" },
};

const DEFAULT_TIMEOUT_SECONDS = 30;

function AddCompatibleDialog({ variant, open, onClose, onCreated }: { variant: "openai-compatible" | "anthropic-compatible"; open: boolean; onClose: () => void; onCreated: () => void }) {
  const cfg = COMPAT_DEFAULTS[variant];
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [autoFetchModels, setAutoFetchModels] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(DEFAULT_TIMEOUT_SECONDS);
  const [headerPairs, setHeaderPairs] = useState<HeaderPair[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => { setName(""); setPrefix(""); setBaseUrl(""); setCredential(""); setAutoFetchModels(false); setTimeoutSeconds(DEFAULT_TIMEOUT_SECONDS); setHeaderPairs([]); };

  useEffect(() => { if (open) reset(); }, [open]);

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setBaseUrl(text.trim());
    } catch {
      toast.error("Clipboard access denied — paste manually instead.");
    }
  }

  async function handleCredentialPaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setCredential(text.trim());
    } catch {
      toast.error("Clipboard access denied — paste manually instead.");
    }
  }

  async function handleCreate() {
    setSubmitting(true);
    try {
      await apiPost("/custom-providers", { name: name.trim(), kind: variant === "anthropic-compatible" ? "anthropic" : "openai-compatible", baseUrl: baseUrl.trim(), credential: credential.trim(), slug: prefix.trim(), timeoutSeconds, autoFetchModels, customHeaders: pairsToHeaders(headerPairs) });
      onCreated();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={variant === "openai-compatible" ? "Add OpenAI Compatible" : "Add Anthropic Compatible"}
      footer={
        <>
          <Button onClick={handleCreate} disabled={!name.trim() || !prefix.trim() || !baseUrl.trim() || !credential.trim() || submitting}>{submitting ? "Creating…" : "Create"}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Required. A friendly label for this node.</Label>
          <Input placeholder={cfg.namePh} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Required. Used as the provider prefix for model IDs.</Label>
          <Input placeholder={cfg.prefixPh} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </div>
        <div>
          <Label>Base URL</Label>
          <div className="flex gap-2">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="flex-1" />
            <Button type="button" variant="secondary" onClick={handlePaste}>Paste</Button>
          </div>
        </div>
        <div>
          <Label>API Key — saved with this provider and used to authenticate every request.</Label>
          <div className="flex gap-2">
            <Input type="password" placeholder="sk-..." value={credential} onChange={(e) => setCredential(e.target.value)} className="flex-1" />
            <Button type="button" variant="secondary" onClick={handleCredentialPaste}>Paste</Button>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Label>Timeout (seconds)</Label>
            <Input
              type="number"
              min={1}
              max={300}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Math.min(300, Math.max(1, Number(e.target.value) || DEFAULT_TIMEOUT_SECONDS)))}
            />
          </div>
          <label className="flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-[var(--inner-border)] px-3 text-sm text-[var(--text-2)]">
            <input type="checkbox" checked={autoFetchModels} onChange={(e) => setAutoFetchModels(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Auto-fetch models
          </label>
        </div>
        <HeaderPairsEditor pairs={headerPairs} onChange={setHeaderPairs} />
      </div>
    </Dialog>
  );
}

function CustomProvidersSection() {
  const qc = useQueryClient();
  const { data, isPending, isError } = useQuery({ queryKey: ["console", "custom-providers"], queryFn: () => apiGet<{ items: CustomProviderRecord[] }>("/custom-providers") });
  const [showOpenAI, setShowOpenAI] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomProviderRecord | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const invalidate = () => qc.invalidateQueries({ queryKey: ["console", "custom-providers"] });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/custom-providers/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast.success("Custom provider deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));

  const bulkDeleteMut = useMutation({
    mutationFn: async (ids: string[]) => { await Promise.all(ids.map((id) => apiDelete<{ ok: boolean }>(`/custom-providers/${id}`))); },
    onSuccess: () => { setSelectedIds(new Set()); invalidate(); toast.success("Selected providers deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-semibold tracking-tight">Custom Providers</h2>
        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:min-w-[230px]">
          <Button size="sm" className="w-full justify-center" title="Add custom Anthropic-compatible provider" aria-label="Add custom Anthropic-compatible provider" onClick={() => setShowAnthropic(true)}>
            <Plus size={13} /> <span>Custom Anthropic</span>
          </Button>
          <Button size="sm" variant="secondary" className="w-full justify-center" title="Add custom OpenAI-compatible provider" aria-label="Add custom OpenAI-compatible provider" onClick={() => setShowOpenAI(true)}>
            <Plus size={13} /> <span>Custom OpenAI</span>
          </Button>
        </div>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-2">
          <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)] hover:text-[var(--text-1)]" onClick={toggleAll}>
            {allSelected ? <CheckSquare size={15} /> : <Square size={15} />}
            {allSelected ? "Clear selection" : "Select all"}
          </button>
          {selectedIds.size > 0 && (
            <Button variant="danger" size="sm" disabled={bulkDeleteMut.isPending} onClick={() => setDeleteTarget({ id: "__bulk__", name: `${selectedIds.size} selected providers`, slug: "", kind: "openai-compatible", baseUrl: "", credentialHint: "", timeoutSeconds: 0, autoFetchModels: false, customHeaders: {} })}>
              <Trash2 size={13} /> Delete selected ({selectedIds.size})
            </Button>
          )}
        </div>
      )}
      {isPending ? (
        <div className="rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/60 p-4 backdrop-blur-xl">
          <div className="h-10 animate-pulse rounded-lg bg-[var(--surface-muted)]" aria-label="Loading custom providers" />
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-[var(--red)]/25 bg-[var(--glass-bg-2)]/70 p-4 text-sm text-[var(--text-2)] backdrop-blur-xl">
          Could not load custom providers. Retry the page to check your saved endpoints again.
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--glass-bg-2)]/60 px-4 py-7 text-center backdrop-blur-xl">
          <p className="text-sm font-semibold text-[var(--text-1)]">No custom providers yet</p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-2)]">Add an OpenAI- or Anthropic-compatible endpoint with the buttons above.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((cp) => {
            const isAnthropic = cp.kind === "anthropic";
            return (
              <Card key={cp.id} className="p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <button type="button" title={`Select ${cp.name}`} aria-label={`Select ${cp.name}`} className="mt-1 shrink-0 text-[var(--text-3)] hover:text-[var(--accent)]" onClick={() => toggleSelected(cp.id)}>
                      {selectedIds.has(cp.id) ? <CheckSquare size={15} className="text-[var(--accent)]" /> : <Square size={15} />}
                    </button>
                  <Link to={`/providers/custom/${cp.id}`} className="flex min-w-0 flex-1 items-center gap-2.5">
                    <div
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
                      style={{ backgroundColor: isAnthropic ? "#D9775722" : "#10A37F22", color: isAnthropic ? "#D97757" : "#10A37F" }}
                    >
                      {isAnthropic ? "AC" : "OC"}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{cp.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge tone="default">Configured</Badge>
                        <Badge tone="default">{isAnthropic ? "Messages" : "Chat"}</Badge>
                      </div>
                    </div>
                  </Link>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" title={`Delete ${cp.name}`} aria-label={`Delete ${cp.name}`} onClick={() => setDeleteTarget(cp)}>
                      <Trash2 size={13} />
                    </Button>
                    <Link to={`/providers/custom/${cp.id}`} className="grid size-8 place-items-center text-[var(--text-3)]">
                      <ChevronRight size={16} />
                    </Link>
                  </div>
                </div>
                <Link to={`/providers/custom/${cp.id}`} className="mt-1.5 block space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <code className="max-w-full truncate rounded bg-[var(--kbd-bg)] px-1 py-0.5 font-mono text-[10px] text-[var(--text-3)]">{cp.slug}/</code>
                    <span className="text-[10px] text-[var(--text-3)]">Models available in detail</span>
                  </div>
                  <p className="truncate text-[10px] text-[var(--text-3)]">{cp.baseUrl}</p>
                </Link>
              </Card>
            );
          })}
        </div>
      )}
      <AddCompatibleDialog variant="openai-compatible" open={showOpenAI} onClose={() => setShowOpenAI(false)} onCreated={invalidate} />
      <AddCompatibleDialog variant="anthropic-compatible" open={showAnthropic} onClose={() => setShowAnthropic(false)} onCreated={invalidate} />
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget?.id === "__bulk__") bulkDeleteMut.mutate([...selectedIds]);
          else if (deleteTarget) deleteMut.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
        title={deleteTarget?.id === "__bulk__" ? "Delete selected providers?" : "Delete custom provider?"}
        message={deleteTarget?.id === "__bulk__" ? `Remove ${selectedIds.size} selected providers? Their routes will stop working.` : `Remove provider "${deleteTarget?.name}" (${deleteTarget?.slug})? Requests to ${deleteTarget?.slug}/... will no longer route.`}
        confirmLabel="Delete"
        danger
      />
    </section>
  );
}

/** Credential state shown under the provider name. */
function StatusLine({ provider }: { provider: ProviderInfo }) {
  if (provider.authKind === "none") return <Badge tone="ok">Ready</Badge>;
  if (provider.connections === 0) return <Badge>No connections</Badge>;
  return (
    <Badge tone="ok" className="gap-1.5">
      <StatusDot status="ok" />
      {provider.connections} Connected
    </Badge>
  );
}

const ProviderCard = memo(function ProviderCard({ provider }: { provider: ProviderInfo }) {
  return (
    <Card className="p-3 transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg">
      <Link to={`/providers/${provider.id}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <div className="flex items-center gap-2.5">
          <ProviderIcon icon={provider.icon} name={provider.name} size={32} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{provider.name}</span>
              {provider.status === "warn" && <StatusDot status="warn" />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusLine provider={provider} />

            </div>
          </div>
          <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
            <span className="rounded-md bg-[var(--kbd-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-3)]">
              {provider.prefix}/
            </span>
            <Badge tone="info">{provider.modelCount} models</Badge>
          </div>
        </div>
      </Link>

    </Card>
  );
});

export function ProvidersPage() {
  const { data, isLoading, isFetching, isError, refetch } = useProviders();
  const items: ProviderInfo[] = (data?.items ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    authKind: (provider.credentialKind === "api_key" ? "api-key" : provider.credentialKind === "manual" ? "none" : provider.credentialKind ?? "none") as ProviderInfo["authKind"],
    prefix: provider.prefix,
    modelCount: provider.modelCount,
    status: (provider.enabled !== false && (provider.credentialKind === "manual" || provider.credentialKind === "none" || provider.configured === true) ? "ok" : "warn") as ProviderInfo["status"],
    connections: provider.connections,
    supportsOAuth: provider.credentialKinds?.includes("oauth") ?? provider.credentialKind === "oauth",
    supportsApiKey: provider.credentialKinds?.includes("api_key") ?? provider.credentialKind === "api_key",
  }));
  const registryLoading = isLoading || (isFetching && items.length === 0);

  const sections = SECTIONS.map((section) => ({
    ...section,
    providers: items
      .filter((provider) => section.authKinds.includes(provider.authKind))
      .sort((left, right) => right.connections - left.connections || left.name.localeCompare(right.name)),
  })).filter((section) => section.providers.length > 0);

  const [visibleCount, setVisibleCount] = useState(12);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const totalProviders = sections.reduce((total, section) => total + section.providers.length, 0);
  const visibleProviders = sections.reduce((total, section) => total + Math.min(visibleCount, section.providers.length), 0);
  const hasMore = visibleProviders < totalProviders;

  useEffect(() => {
    if (!hasMore) return;
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisibleCount((current) => current + 12);
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore]);

  return (
    <div className="dashboard-page space-y-4">
      {registryLoading ? (
        <StatePanel kind="loading" title="Loading providers" description="Reading the provider registry…" />
      ) : isError && items.length === 0 ? (
        <StatePanel kind="error" title="Failed to load providers" action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />
      ) : (
        <div className="space-y-6">
          <CustomProvidersSection />
          {sections.map((section) => (
            <section key={section.title} className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold tracking-tight">{section.title} ({section.providers.length})</h2>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {section.providers.slice(0, visibleCount).map((provider) => (
                  <div key={provider.id} className="min-w-0 [contain-intrinsic-size:160px] [content-visibility:auto]">
                    <ProviderCard provider={provider} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          {totalProviders > 0 && (
            <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/55 px-4 py-2 text-center text-[11px] text-[var(--text-3)] backdrop-blur-xl">
              {hasMore ? `Showing ${visibleProviders} of ${totalProviders} providers · loading more as you scroll` : `Showing all ${totalProviders} providers`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

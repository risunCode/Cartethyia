/** Providers page — registry list grouped by credential kind (REQ-11). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { HeaderPairsEditor, pairsToHeaders, type HeaderPair } from "../../components/header-pairs-editor";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { apiGet, apiPost, apiDelete } from "../../lib/api";
import { staggerClass } from "../../lib/motion";
import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Badge, Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/shared";

interface ProviderInfo {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "api-key";
  prefix: string;
  modelCount: number;
  status: "ok" | "warn";
  connections: number;
}

/** Display order for built-in providers: free tier, OAuth, then API key/PAT. */
const SECTIONS: { authKind: ProviderInfo["authKind"]; title: string }[] = [
  { authKind: "none", title: "Free Tier Providers" },
  { authKind: "session", title: "OAuth Providers" },
  { authKind: "api-key", title: "API Key Providers" },
];

// ── Custom Providers (OpenAI/Anthropic Compatible) ──────────────────────

interface CustomProviderRecord {
  id: string;
  slug: string;
  name: string;
  type: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  credentialHint: string;
  timeoutSeconds: number;
  models: Array<{ id: string }>;
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
      await apiPost("/custom-providers", { name: name.trim(), type: variant, baseUrl: baseUrl.trim(), credential: credential.trim(), slug: prefix.trim(), timeoutSeconds, autoFetchModels, customHeaders: pairsToHeaders(headerPairs) });
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
  const { data } = useQuery({ queryKey: ["console", "custom-providers"], queryFn: () => apiGet<{ items: CustomProviderRecord[] }>("/custom-providers") });
  const [showOpenAI, setShowOpenAI] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const copyBaseUrl = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(id);
      toast.success("Base URL copied");
      setTimeout(() => setCopiedUrl(null), 1500);
    } catch {
      toast.error("Clipboard access denied");
    }
  };
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomProviderRecord | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["console", "custom-providers"] });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/custom-providers/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast.success("Custom provider deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold tracking-tight">Custom Providers (OpenAI/Anthropic Compatible)</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowAnthropic(true)}>
            <Plus size={14} /> Add Anthropic Compatible
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setShowOpenAI(true)}>
            <Plus size={14} /> Add OpenAI Compatible
          </Button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--inner-border)] py-6 text-sm text-[var(--text-3)]">
          No custom providers — use buttons above to add OpenAI/Anthropic compatible endpoints
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((cp) => {
            const isAnthropic = cp.type === "anthropic-compatible";
            return (
              <Card key={cp.id} className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/providers/custom/${cp.id}`} className="flex min-w-0 flex-1 items-center gap-2.5">
                    <div
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
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
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(cp)}>
                      <Trash2 size={14} />
                    </Button>
                    <Link to={`/providers/custom/${cp.id}`} className="grid size-8 place-items-center text-[var(--text-3)]">
                      <ChevronRight size={16} />
                    </Link>
                  </div>
                </div>
                <Link to={`/providers/custom/${cp.id}`} className="mt-2 block space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <code className="max-w-full truncate rounded bg-[var(--kbd-bg)] px-1 py-0.5 font-mono text-[10px] text-[var(--text-3)]">{cp.slug}/</code>
                    <span className="text-[10px] text-[var(--text-3)]">{cp.models.length} model{cp.models.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <p className="min-w-0 truncate text-[10px] text-[var(--text-3)]">{cp.baseUrl}</p>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyBaseUrl(cp.baseUrl, cp.id); }}
                      className="shrink-0 rounded p-0.5 text-[var(--text-3)] transition-colors hover:text-[var(--accent)]"
                      title="Copy base URL"
                    >
                      {copiedUrl === cp.id ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  </div>
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
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title="Delete custom provider?"
        message={`Remove provider "${deleteTarget?.name}" (${deleteTarget?.slug})? Requests to ${deleteTarget?.slug}/... will no longer route.`}
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

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  return (
    <Link to={`/providers/${provider.id}`} className="block">
      <Card className="p-3 transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg">
        <div className="flex items-center gap-2.5">
          <ProviderIcon icon={provider.icon} name={provider.name} size={32} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{provider.name}</span>
              {provider.status === "warn" && <StatusDot status="warn" />}
            </div>
            <div className="mt-1">
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
      </Card>
    </Link>
  );
}

export function ProvidersPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ items: ProviderInfo[] }>("/providers"),
  });
  const items = data?.items ?? [];

  const sections = SECTIONS.map((section) => ({
    ...section,
    providers: items.filter((provider) => provider.authKind === section.authKind),
  })).filter((section) => section.providers.length > 0);

  // The stagger cascade runs across sections so the page reveals top-to-bottom.
  let staggerIndex = 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Providers</h1>
        <p className="text-xs text-[var(--text-2)]">Upstream registries grouped by credential kind — open one for models, routing and accounts.</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Card key={i} className="p-3">
              <Skeleton className="h-14" />
            </Card>
          ))}
        </div>
      ) : isError ? (
        <Card className="text-center">
          <p className="py-8 text-sm text-[var(--text-2)]">Failed to load providers.</p>
          <Button variant="secondary" onClick={() => refetch()}>
            Retry
          </Button>
        </Card>
      ) : (
        <div className="space-y-6">
          <CustomProvidersSection />
          {sections.map((section) => (
            <section key={section.authKind} className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold tracking-tight">{section.title}</h2>
                <span className="text-xs text-[var(--text-3)]">
                  {section.providers.length} provider{section.providers.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {section.providers.map((provider) => (
                  <div key={provider.id} {...staggerClass(staggerIndex++)}>
                    <ProviderCard provider={provider} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

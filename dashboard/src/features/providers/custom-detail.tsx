/** Custom provider detail page (REQ-8) — console-registered OpenAI/Anthropic-compatible endpoint. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, Bot, Brain, Copy, Eye, FlaskConical, Link2, ListChecks, Pencil, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, apiGet, apiPost } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatTokens, formatDuration } from "../../lib/format";
import { staggerItem } from "../../lib/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/shared";
import { HeaderPairsEditor, headersToPairs, pairsToHeaders, type HeaderPair } from "../../components/header-pairs-editor";

interface CustomProviderModel {
  id: string;
  capabilities: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface CustomProviderDetail {
  id: string;
  slug: string;
  name: string;
  type: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  credentialHint: string;
  timeoutSeconds: number;
  models: CustomProviderModel[];
  customHeaders: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface ModelsFetchResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  models: CustomProviderModel[];
  error?: string;
}

interface ModelTestResult {
  resolveOk: boolean;
  ok: boolean;
  latencyMs: number;
  sample?: string;
  error?: string;
}

/** Capabilities worth surfacing — mirrors the built-in provider grid's icon set. */
const CAPABILITY_ICONS = [
  { key: "reasoning", label: "Thinking", Icon: Brain, className: "text-[var(--accent)]" },
  { key: "vision", label: "Vision", Icon: Eye, className: "text-[var(--teal)]" },
  { key: "tools", label: "Tools", Icon: Wrench, className: "text-[var(--text-2)]" },
];

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Clipboard access denied");
  }
}

export function CustomProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["custom-provider", id],
    queryFn: () => apiGet<CustomProviderDetail>(`/custom-providers/${id}`),
    enabled: Boolean(id),
  });

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [headerPairs, setHeaderPairs] = useState<HeaderPair[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [modelTestStatus, setModelTestStatus] = useState<Record<string, ModelTestResult>>({});

  // Form fields track the loaded record; re-sync whenever the query refetches
  // (e.g. after a save) so the fields never drift from what is persisted.
  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setBaseUrl(data.baseUrl);
    setTimeoutSeconds(data.timeoutSeconds);
    setHeaderPairs(headersToPairs(data.customHeaders));
    setCredential("");
  }, [data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["custom-provider", id] });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiPost<CustomProviderDetail>(`/custom-providers/${id}`, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        timeoutSeconds,
        customHeaders: pairsToHeaders(headerPairs),
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success("Saved");
      setCredential("");
      setEditing(false);
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["console", "custom-providers"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const fetchModelsMutation = useMutation({
    mutationFn: () => apiPost<ModelsFetchResult>(`/custom-providers/${id}/models/fetch`, {}),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(`Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}`);
        setModelTestStatus({});
        invalidate();
      } else {
        toast.error(result.error ?? "Model fetch failed");
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Model fetch failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/custom-providers/${id}`, { method: "DELETE", body: "{}" }),
    onSuccess: () => {
      toast.success("Custom provider deleted");
      void queryClient.invalidateQueries({ queryKey: ["console", "custom-providers"] });
      navigate("/providers");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  async function runTest(modelId: string) {
    setPendingModelId(modelId);
    setModelTestStatus((prev) => ({ ...prev, [modelId]: { resolveOk: true, ok: false, latencyMs: 0 } }));
    try {
      const result = await apiPost<ModelTestResult>(`/custom-providers/${id}/models/${encodeURIComponent(modelId)}/test`, {});
      setModelTestStatus((prev) => ({ ...prev, [modelId]: result }));
      // Same toast shape as the built-in providers' Test button.
      if (result.ok) {
        toast.success(`${modelId} · ${formatDuration(result.latencyMs)}`, {
          description: result.sample ? result.sample : "No sample text in the response.",
        });
      } else {
        toast.error(`${modelId} failed`, { description: result.error ?? "Unknown error." });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test failed";
      setModelTestStatus((prev) => ({ ...prev, [modelId]: { resolveOk: false, ok: false, latencyMs: 0, error: message } }));
      toast.error(`${modelId} failed`, { description: message });
    } finally {
      setPendingModelId(null);
    }
  }

  const cancelEdit = useMemo(
    () => () => {
      if (!data) return;
      setName(data.name);
      setBaseUrl(data.baseUrl);
      setTimeoutSeconds(data.timeoutSeconds);
      setHeaderPairs(headersToPairs(data.customHeaders));
      setCredential("");
      setEditing(false);
    },
    [data]
  );

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-[var(--text-3)]">Loading…</div>;
  }
  if (isError || !data) {
    return (
      <div className="space-y-3 py-12 text-center">
        <p className="text-sm text-[var(--text-3)]">This custom provider no longer exists.</p>
        <Link to="/providers" className="text-[12.5px] font-medium text-[var(--accent)] hover:underline">
          Back to Providers
        </Link>
      </div>
    );
  }

  const isAnthropic = data.type === "anthropic-compatible";
  const headerCount = Object.keys(data.customHeaders).length;

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/providers"
          className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
        >
          <ArrowLeft size={13} /> Back to Providers
        </Link>

        <div className="mt-3 flex items-center gap-3.5">
          <div
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold"
            style={{ backgroundColor: isAnthropic ? "#D9775722" : "#10A37F22", color: isAnthropic ? "#D97757" : "#10A37F" }}
          >
            {isAnthropic ? "AC" : "OC"}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{data.name}</h1>
              <code className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--accent)]">
                {data.slug}/
              </code>
              <Badge tone="default">{isAnthropic ? "Anthropic Compatible" : "OpenAI Compatible"}</Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--text-2)]">
              <span>{data.models.length} model{data.models.length === 1 ? "" : "s"} discovered</span>
            </div>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader title="Connection" icon={Link2} sub="Base URL, credential, custom headers, and per-request timeout for this endpoint.">
          <div className="flex items-center gap-1.5">
            {!editing ? (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil size={13} /> Edit
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={cancelEdit}>
                <X size={13} /> Cancel
              </Button>
            )}
            <Button variant="secondary" size="sm" className="text-[var(--red)]" onClick={() => setDeleteOpen(true)}>
              <Trash2 size={13} /> Delete
            </Button>
          </div>
        </CardHeader>

        {!editing ? (
          <div className="space-y-2 text-[12.5px]">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[var(--text-3)]">Base URL</span>
              <code className="truncate font-mono text-[var(--text-1)]">{data.baseUrl}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[var(--text-3)]">Credential</span>
              <span className="text-[var(--text-1)]">{data.credentialHint ? `ends in …${data.credentialHint}` : "unavailable"}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[var(--text-3)]">Timeout</span>
              <span className="text-[var(--text-1)]">{data.timeoutSeconds}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[var(--text-3)]">Headers</span>
              {headerCount === 0 ? (
                <span className="text-[var(--text-3)]">none</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {Object.keys(data.customHeaders).map((key) => (
                    <code key={key} className="rounded bg-[var(--kbd-bg)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-2)]">{key}</code>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>Base URL</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
            <div>
              <Label>Credential {data.credentialHint ? `— currently ends in …${data.credentialHint}` : ""} — leave empty to keep the current one</Label>
              <Input type="password" placeholder="Paste a new key to rotate it" value={credential} onChange={(e) => setCredential(e.target.value)} />
            </div>
            <div className="max-w-[160px]">
              <Label>Timeout (seconds)</Label>
              <Input
                type="number"
                min={1}
                max={300}
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Math.min(300, Math.max(1, Number(e.target.value) || 30)))}
              />
            </div>
            <HeaderPairsEditor pairs={headerPairs} onChange={setHeaderPairs} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
              <Button disabled={!name.trim() || !baseUrl.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Available Models" icon={ListChecks} iconColor="#30d158" sub="Discovered via a live GET /models call — routing accepts any model id regardless of this list.">
          <Button variant="secondary" size="sm" disabled={fetchModelsMutation.isPending} onClick={() => fetchModelsMutation.mutate()}>
            <RefreshCw size={13} /> {fetchModelsMutation.isPending ? "Fetching…" : "Fetch models"}
          </Button>
        </CardHeader>
        {data.models.length === 0 ? (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--inner-border)] py-6 text-sm text-[var(--text-3)]">
            No models discovered yet — click "Fetch models" to run discovery.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {data.models.map((model, index) => {
              const qualified = `${data.slug}/${model.id}`;
              const caps = CAPABILITY_ICONS.filter((capability) => model.capabilities.includes(capability.key));
              const testStatus = modelTestStatus[model.id];
              return (
                <motion.div key={model.id} {...staggerItem(index)}>
                  <Card className="flex h-full flex-col gap-1.5 p-2.5">
                    <div className="flex items-start gap-1.5">
                      <Bot size={13} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
                      <div className="min-w-0">
                        <div className="break-all font-mono text-[11px] font-semibold text-[var(--text-1)]">{qualified}</div>
                        <div className="mt-0.5 break-all text-[10px] text-[var(--text-3)]">{model.id}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {caps.map(({ key, label, Icon, className }) => (
                        <span key={key} title={label} aria-label={label} className={cn("grid h-5 w-5 place-items-center rounded-md bg-[var(--hover)]", className)}>
                          <Icon size={11} aria-hidden="true" />
                        </span>
                      ))}
                      {testStatus?.ok && <Badge tone="ok">passed · {formatDuration(testStatus.latencyMs)}</Badge>}
                      {testStatus && !testStatus.ok && testStatus.latencyMs > 0 && <Badge tone="err" title={testStatus.error}>failed</Badge>}
                    </div>
                    {Boolean(model.contextWindow || model.maxOutputTokens) && (
                      <div className="text-[9px] text-[var(--text-2)]">
                        {model.contextWindow ? `${formatTokens(model.contextWindow)} context` : null}
                        {model.contextWindow && model.maxOutputTokens ? " · " : null}
                        {model.maxOutputTokens ? `${formatTokens(model.maxOutputTokens)} max output` : null}
                      </div>
                    )}
                    <div className="mt-auto flex gap-1 pt-0.5">
                      <Button variant="secondary" size="sm" className="flex-1" disabled={pendingModelId === model.id} onClick={() => void runTest(model.id)}>
                        <FlaskConical size={12} /> {pendingModelId === model.id ? "Testing…" : "Test"}
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Copy ${qualified}`} onClick={() => void copyToClipboard(qualified)}>
                        <Copy size={12} />
                      </Button>
                    </div>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete custom provider?"
        message={`Remove provider "${data.name}" (${data.slug})? Requests to ${data.slug}/... will no longer route.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

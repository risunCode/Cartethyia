/** Custom provider detail page (REQ-8) — console-registered OpenAI/Anthropic-compatible endpoint. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Activity, Bot, Copy, Eye, FlaskConical, Link2, ListChecks, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "../../lib/toast";
import { apiGet, apiPatch, apiDelete, apiPost } from "../../lib/api";
import { formatTokens, formatDuration } from "../../lib/format";
import { staggerClass } from "../../lib/motion";
import { qk } from "../../lib/query-keys";
import { useWindowedList } from "../../hooks/use-windowed-list";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/shared";
import { HeaderPairsEditor, headersToPairs, pairsToHeaders, type HeaderPair } from "../../components/header-pairs-editor";

interface CustomProviderModel {
  id: string;
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { inputPerMillion?: number | null; outputPerMillion?: number | null };
}

interface CustomProviderDetail {
  id: string;
  slug: string;
  name: string;
  kind: "openai" | "anthropic" | "openai-compatible";
  baseUrl: string;
  credentialHint: string;
  timeoutSeconds: number;
  autoFetchModels: boolean;
  customHeaders: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  models: CustomProviderModel[];
}

interface ProviderDetailResponse {
  id: string;
  name: string;
  models: Array<{ modelId: string; enabled: boolean; metadata?: { context?: { inputTokens?: number | null; outputTokens?: number | null }; categories?: string[]; pricing?: { inputPerMillion?: number | null; outputPerMillion?: number | null } } }>;
  accounts?: Array<{ id: string; name: string; credentialHint: string; active: boolean; credentialKind: string }>;
  routing?: { strategy: "priority" | "round-robin"; stickyLimit: number; useStickyLimit: boolean };
  customProvider: (Omit<CustomProviderDetail, "models"> & { models?: Array<CustomProviderModel | string> }) | null;
}

interface CustomAccount {
  id: string;
  name: string;
  credentialHint: string;
  active: boolean;
  credentialKind: string;
}

interface ModelTestResult {
  resolveOk: boolean;
  ok: boolean;
  latencyMs: number;
  sample?: string;
  error?: string;
}

// Reasoning is assumed for every model here; vision is the one flag that
// actually varies, so it's the only badge worth surfacing (mirrors the
// built-in provider grid).

function formatCustomPricing(pricing: CustomProviderModel["pricing"]): string {
  const input = pricing?.inputPerMillion;
  const output = pricing?.outputPerMillion;
  if (input === 0 && output === 0) return "Free";
  if (typeof input === "number" && typeof output === "number") return `$${input} / $${output} per 1M`;
  return "Pricing unknown";
}

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
    queryKey: qk.customProviders.detail(id),
    queryFn: async () => {
      const response = await apiGet<ProviderDetailResponse>(`/providers/${id}`);
      if (!response.customProvider) throw new Error("custom provider not found");
      const catalogModels = response.models.length > 0
        ? response.models.map((model): CustomProviderModel => ({
            id: model.modelId,
            reasoning: model.metadata?.categories?.includes("reasoning"),
            vision: model.metadata?.categories?.includes("vision"),
            contextWindow: model.metadata?.context?.inputTokens ?? undefined,
            maxOutputTokens: model.metadata?.context?.outputTokens ?? undefined,
            pricing: model.metadata?.pricing,
          }))
        : (response.customProvider.models ?? []).flatMap((model): CustomProviderModel[] => {
            if (typeof model === "string") return [{ id: model }];
            return [{ id: model.id, reasoning: model.reasoning, vision: model.vision, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, pricing: model.pricing }];
          });
      return {
        ...response.customProvider,
        models: catalogModels,
        accounts: response.accounts ?? [],
        routing: response.routing ?? { strategy: "priority", stickyLimit: 1, useStickyLimit: false },
      };

    },
    enabled: Boolean(id),
  });

  const [editing, setEditing] = useState(false);

  // Virtualize the accounts list — renders only visible rows even with thousands of accounts.
  const accountWindow = useWindowedList(data?.accounts ?? [], 48);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [headerPairs, setHeaderPairs] = useState<HeaderPair[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [accountCredentials, setAccountCredentials] = useState("");
  const [manualModelId, setManualModelId] = useState("");
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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.customProviders.detail(id) });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiPatch<CustomProviderDetail>(`/custom-providers/${id}`, {
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
      void queryClient.invalidateQueries({ queryKey: qk.customProviders.all });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete<{ ok: boolean }>(`/custom-providers/${id}`),
    onSuccess: () => {
      toast.success("Custom provider deleted");
      void queryClient.invalidateQueries({ queryKey: qk.customProviders.all });
      navigate("/providers");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  const accountMutation = useMutation({
    mutationFn: async () => {
      const values = accountCredentials.split(/\\r?\\n/).map((value) => value.trim()).filter(Boolean);
      if (!accountName.trim() || values.length === 0) throw new Error("Enter an account name and at least one API key.");
      await Promise.all(values.map((credential, index) => apiPost(`/providers/${id}/accounts`, {
        name: values.length === 1 ? accountName.trim() : `${accountName.trim()}-${index + 1}`,
        credentialKind: "api_key",
        credential,
      })));
    },
    onSuccess: () => {
      toast.success("API key account(s) added");
      setAccountOpen(false);
      setAccountName("");
      setAccountCredentials("");
      void queryClient.invalidateQueries({ queryKey: qk.customProviders.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to add account"),
  });

  const fetchMutation = useMutation({
    mutationFn: () => apiPost(`/custom-providers/${id}/models/fetch`, {}),
    onSuccess: () => { toast.success("Model catalog fetched"); void queryClient.invalidateQueries({ queryKey: qk.customProviders.detail(id) }); void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Model discovery failed"),
  });

  const healthCheckMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; latencyMs: number; error?: string }>(`/custom-providers/${id}/health`, {}),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(`Health check OK · ${result.latencyMs}ms`);
      } else {
        toast.error(`Health check failed`, { description: result.error ?? `HTTP ${result.latencyMs}ms` });
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Health check failed"),
  });

  const addModelMutation = useMutation({
    mutationFn: (modelId: string) => apiPost(`/custom-providers/${id}/models`, { modelId }),
    onSuccess: () => {
      toast.success("Custom model added");
      setManualModelId("");
      void queryClient.invalidateQueries({ queryKey: qk.customProviders.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add model"),
  });

  const deleteModelMutation = useMutation({
    mutationFn: (modelId: string) => apiDelete(`/custom-providers/${id}/models/${encodeURIComponent(modelId)}`),
    onSuccess: () => { toast.success("Fetched model deleted"); void queryClient.invalidateQueries({ queryKey: qk.customProviders.detail(id) }); void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete model"),
  });

  const routingMutation = useMutation({
    mutationFn: (strategy: "priority" | "round-robin") => apiPost(`/providers/${id}/routing`, { strategy }),
    onSuccess: () => {
      toast.success("Routing updated");
      void queryClient.invalidateQueries({ queryKey: qk.customProviders.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to update routing"),
  });

  async function runTest(modelId: string) {
    setPendingModelId(modelId);
    setModelTestStatus((prev) => ({ ...prev, [modelId]: { resolveOk: true, ok: false, latencyMs: 0 } }));
    try {
      const probe = await apiPost<{ ok: boolean; latencyMs: number; sample?: string; error?: { message?: string }; returnedModel?: string }>("/model-studio/probe", {
        provider: data?.slug ?? id,
        model: modelId,
        credentialMode: "auto",
      });
      const result: ModelTestResult = {
        resolveOk: true,
        ok: probe.ok,
        latencyMs: probe.latencyMs,
        sample: probe.sample,
        error: probe.error?.message,
      };
      setModelTestStatus((prev) => ({ ...prev, [modelId]: result }));
      // Same toast shape as the built-in providers' Test button.
      if (result.ok) {
        const time = formatDuration(result.latencyMs);
        const returned = probe.returnedModel?.trim();
        let aliasInfo: string;
        if (!returned) {
          aliasInfo = "";
        } else if (returned.toLowerCase() === modelId.split("/").pop()?.toLowerCase()) {
          aliasInfo = `Real model · ${returned}`;
        } else {
          aliasInfo = `Likely aliased · ${returned}`;
        }
        const title = aliasInfo ? `${modelId}\n${aliasInfo}  ·  ${time}` : `${modelId}  ·  ${time}`;
        toast.success(title, {
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

  const isAnthropic = data.kind === "anthropic";
  const headerCount = Object.keys(data.customHeaders).length;

  return (
    <div className="dashboard-page space-y-4">
      <div>
        <Link
          to="/providers"
          className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-2)] transition-colors hover:text-[var(--text-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
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
        <CardHeader title="Accounts" icon={Link2} sub={`${data.accounts.length} API key account${data.accounts.length === 1 ? "" : "s"} · keys participate in provider routing`}>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => routingMutation.mutate(data.routing.strategy === "round-robin" ? "priority" : "round-robin")} disabled={routingMutation.isPending || data.accounts.length < 2}>
              <RefreshCw size={13} /> {data.routing.strategy === "round-robin" ? "Priority" : "Round robin"}
            </Button>
            <Button size="sm" onClick={() => setAccountOpen(true)}><Plus size={13} /> Add keys</Button>
          </div>
        </CardHeader>
        {data.accounts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--inner-border)] py-6 text-center text-sm text-[var(--text-3)]">No API key accounts yet.</div>
        ) : (
          <div ref={accountWindow.containerRef} onScroll={accountWindow.onScroll} className="max-h-[400px] overflow-y-auto scrollbar-fade">
            <div style={{ height: accountWindow.topPadding }} />
            <div className="space-y-1.5">
              {accountWindow.visibleItems.map((account: CustomAccount) => (
                <div key={account.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5">
                  <div className="min-w-0"><div className="truncate text-xs font-semibold">{account.name}</div><div className="font-mono text-[10px] text-[var(--text-2)]">{account.credentialHint}</div></div>
                  <Badge tone={account.active ? "ok" : "default"}>{account.active ? "Active" : "Disabled"}</Badge>
                </div>
              ))}
            </div>
            <div style={{ height: accountWindow.bottomPadding }} />
          </div>
        )}
        {accountOpen && (
          <div className="mt-3 space-y-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
            <Label>Account name<Input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="key-1" /></Label>
            <Label>API keys<textarea value={accountCredentials} onChange={(event) => setAccountCredentials(event.target.value)} className="min-h-24 w-full rounded-xl border border-[var(--inner-border)] bg-[var(--input-bg)] p-3 font-mono text-xs text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]" placeholder="One API key per line" spellCheck={false} /></Label>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setAccountOpen(false)}>Cancel</Button><Button disabled={accountMutation.isPending} onClick={() => accountMutation.mutate()}>{accountMutation.isPending ? "Adding…" : "Add accounts"}</Button></div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Available Models" icon={ListChecks} iconColor="#30d158" sub="Models are provided by the active provider catalog; routing accepts any model id regardless of this list.">
          <div className="flex flex-wrap items-center justify-end gap-1.5 text-right text-[10px] text-[var(--text-3)]">
            <div className="flex min-w-52 gap-1.5">
              <Input
                className="h-7 min-w-0 font-mono text-[10px]"
                placeholder="Add model ID…"
                value={manualModelId}
                onChange={(event) => setManualModelId(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && manualModelId.trim().length > 0) addModelMutation.mutate(manualModelId.trim()); }}
              />
              <Button variant="secondary" size="sm" disabled={addModelMutation.isPending || manualModelId.trim().length === 0} onClick={() => addModelMutation.mutate(manualModelId.trim())}>
                <Plus size={12} /> Add
              </Button>
            </div>
            <Button variant="secondary" size="sm" disabled={fetchMutation.isPending} onClick={() => fetchMutation.mutate()}><RefreshCw size={12} className={fetchMutation.isPending ? "animate-spin" : ""} /> Fetch</Button>
            <Button variant="secondary" size="sm" disabled={healthCheckMutation.isPending} onClick={() => healthCheckMutation.mutate()}><Activity size={12} className={healthCheckMutation.isPending ? "animate-spin" : ""} /> Health</Button>
          </div>
        </CardHeader>
        {data.models.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-[var(--inner-border)] px-4 py-8 text-center text-sm text-[var(--text-2)]">
            <p className="max-w-xl">No models are available in the active provider catalog. Fetch the provider catalog or enter a model id in Model Studio to probe it directly.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {data.models.map((model, index) => {
              const qualified = `${data.slug}/${model.id}`;
              const testStatus = modelTestStatus[model.id];
              return (
                <div key={model.id} {...staggerClass(index)}>
                  <Card className="flex h-full flex-col gap-1.5 p-2.5">
                    <div className="flex items-start gap-1.5">
                      <Bot size={13} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
                      <div className="min-w-0">
                        <div className="break-all font-mono text-[11px] font-semibold text-[var(--text-1)]">{qualified}</div>
                        <div className="mt-0.5 break-all text-[10px] text-[var(--text-3)]">{model.id}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {model.reasoning && <Badge tone="default">Reasoning</Badge>}
                      {model.vision && <Badge tone="default"><Eye size={11} aria-hidden="true" /> Vision</Badge>}
                      {testStatus?.ok && <Badge tone="ok">passed · {formatDuration(testStatus.latencyMs)}</Badge>}
                      {testStatus && !testStatus.ok && testStatus.latencyMs > 0 && <Badge tone="err" title={testStatus.error}>failed</Badge>}
                    </div>
                    <div className="text-[9px] text-[var(--text-2)]">
                      {model.contextWindow ? `${formatTokens(model.contextWindow)} context` : "Context unknown"}
                      {model.contextWindow && model.maxOutputTokens ? " · " : null}
                      {model.maxOutputTokens ? `${formatTokens(model.maxOutputTokens)} max output` : " · max output unknown"}
                    </div>
                    <div className="text-[9px] text-[var(--text-2)]">
                      {formatCustomPricing(model.pricing)}
                    </div>
                    <div className="mt-auto flex gap-1 pt-0.5">
                      <Button variant="secondary" size="sm" className="flex-1" disabled={pendingModelId === model.id} onClick={() => void runTest(model.id)}>
                        <FlaskConical size={12} /> {pendingModelId === model.id ? "Testing…" : "Test"}
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Copy ${qualified}`} onClick={() => void copyToClipboard(qualified)}>
                        <Copy size={12} />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete fetched ${model.id}`} onClick={() => deleteModelMutation.mutate(model.id)} disabled={deleteModelMutation.isPending}>
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </Card>
                </div>
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

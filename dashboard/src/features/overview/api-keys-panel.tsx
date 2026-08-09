import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { toast } from "../../lib/toast";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { cn } from "../../lib/cn";
import { copyToClipboard } from "../../lib/clipboard";
import { qk } from "../../lib/query-keys";
import { ModelPickerField } from "../../components/model-picker";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { Card, CardHeader } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { StatePanel } from "../../components/ui/state";

export interface ApiKeyRecord {
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
  quoteBigText: string | null;
  modelAllowlist: string[] | null;
  quoteSubText: string | null;
  quoteBody: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CreatedKey {
  key: string;
  note?: string;
}

type TokenBudgetMode = "recurring" | "one-time";
interface KeyLimitsInput {
  rateLimitRpm?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  oneTimeTokenLimit?: number;
  maxConcurrentRequests?: number;
  modelAllowlist?: string[];
}

function parseLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Builds the API key ACL and budget payload shared by create and edit forms. */
export function buildKeyLimitsInput(
  rpm: string,
  daily: string,
  monthly: string,
  concurrent: string,
  selected: string[],
  oneTime = "",
  budgetMode: TokenBudgetMode = "recurring",
): KeyLimitsInput {
  return {
    ...(parseLimit(rpm) !== undefined ? { rateLimitRpm: parseLimit(rpm) } : {}),
    ...(budgetMode === "one-time"
      ? (parseLimit(oneTime) !== undefined ? { oneTimeTokenLimit: parseLimit(oneTime) } : {})
      : {
          ...(parseLimit(daily) !== undefined ? { dailyTokenLimit: parseLimit(daily) } : {}),
          ...(parseLimit(monthly) !== undefined ? { monthlyTokenLimit: parseLimit(monthly) } : {}),
        }),
    ...(parseLimit(concurrent) !== undefined ? { maxConcurrentRequests: parseLimit(concurrent) } : {}),
    ...(selected.length > 0 ? { modelAllowlist: selected } : {}),
  };
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unknown";
}

function limitLabel(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString();
}

interface KeyFormProps {
  mode: "create" | "edit";
  record: ApiKeyRecord | null;
  busy: boolean;
  onDone: (input: { name: string; customKey?: string; prefix?: string; limits: KeyLimitsInput; quoteBigText?: string; quoteSubText?: string; quoteBody?: string }) => void;
  onClose: () => void;
}

function KeyForm({ mode, record, busy, onDone, onClose }: KeyFormProps) {
  const [name, setName] = useState(record?.name ?? "");
  const [customKey, setCustomKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [rpm, setRpm] = useState(record?.rateLimitRpm?.toString() ?? "");
  const [daily, setDaily] = useState(record?.dailyTokenLimit?.toString() ?? "");
  const [monthly, setMonthly] = useState(record?.monthlyTokenLimit?.toString() ?? "");
  const [oneTime, setOneTime] = useState(record?.oneTimeTokenLimit?.toString() ?? "");
  const [budgetMode, setBudgetMode] = useState<TokenBudgetMode>(record?.oneTimeTokenLimit != null ? "one-time" : "recurring");
  const [concurrent, setConcurrent] = useState(record?.maxConcurrentRequests?.toString() ?? "");
  const [models, setModels] = useState<string[]>(record?.modelAllowlist ? [...record.modelAllowlist] : []);
  const [quoteBigText, setQuoteBigText] = useState(record?.quoteBigText ?? "");
  const [quoteSubText, setQuoteSubText] = useState(record?.quoteSubText ?? "");
  const [quoteBody, setQuoteBody] = useState(record?.quoteBody ?? "");
  const isOneTimeBudget = budgetMode === "one-time";

  const submit = () => onDone({
    name: name.trim(),
    customKey: customKey.trim() || undefined,
    prefix: prefix.trim() || undefined,
    limits: buildKeyLimitsInput(
      rpm,
      isOneTimeBudget ? "" : daily,
      isOneTimeBudget ? "" : monthly,
      concurrent,
      models,
      oneTime,
      budgetMode,
    ),
    quoteBigText: quoteBigText.trim() || undefined,
    quoteSubText: quoteSubText.trim() || undefined,
    quoteBody: quoteBody.trim() || undefined,
  });

  return (
    <div className="space-y-5 pb-1">
      {mode === "create" && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-bold text-[var(--text-1)]">Identity</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-3)]">Give this credential a recognizable name.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="api-key-name">Name</Label>
              <Input id="api-key-name" name="name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="ci-key…" disabled={busy} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="api-key-prefix">Key prefix</Label>
              <Input id="api-key-prefix" name="prefix" value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="ctk (default)…" disabled={busy || customKey.trim().length > 0} autoComplete="off" />
            </div>
          </div>
          <div>
            <Label htmlFor="api-key-custom-value">Custom API key value <span className="font-normal text-[var(--text-3)]">(optional)</span></Label>
            <Input id="api-key-custom-value" name="key" value={customKey} onChange={(event) => setCustomKey(event.target.value)} placeholder="Leave blank to generate…" disabled={busy} spellCheck={false} autoComplete="off" />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-bold text-[var(--text-1)]">Limits</h3>
          <p className="mt-0.5 text-[11px] text-[var(--text-3)]">Keep this credential predictable under load.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="api-key-rpm">Requests per minute</Label>
            <Input id="api-key-rpm" name="rateLimitRpm" type="number" min="0" inputMode="numeric" value={rpm} onChange={(event) => setRpm(event.target.value)} placeholder="Unlimited…" disabled={busy} />
          </div>
          <div>
            <Label htmlFor="api-key-concurrent">Max concurrent requests</Label>
            <Input id="api-key-concurrent" name="maxConcurrentRequests" type="number" min="0" inputMode="numeric" value={concurrent} onChange={(event) => setConcurrent(event.target.value)} placeholder="Unlimited…" disabled={busy} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3">
          <div className="min-w-0">
            <div className="text-xs font-bold text-[var(--text-1)]">Token budget</div>
            <p aria-live="polite" className="mt-0.5 text-[10.5px] text-[var(--text-3)]">{isOneTimeBudget ? "One-time cap; it does not reset." : "Daily and monthly limits reset automatically."}</p>
          </div>
          <div className="shrink-0 rounded-lg border border-[var(--inner-border)] bg-[var(--surface-1)] p-0.5" role="tablist" aria-label="Token budget type">
            <button
              type="button"
              role="tab"
              aria-selected={!isOneTimeBudget}
              tabIndex={isOneTimeBudget ? -1 : 0}
              onClick={() => setBudgetMode("recurring")}
              disabled={busy}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[10.5px] font-semibold transition-[color,background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)] disabled:opacity-40",
                !isOneTimeBudget ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-sm" : "text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
              )}
            >
              Daily
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isOneTimeBudget}
              tabIndex={isOneTimeBudget ? 0 : -1}
              onClick={() => setBudgetMode("one-time")}
              disabled={busy}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[10.5px] font-semibold transition-[color,background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)] disabled:opacity-40",
                isOneTimeBudget ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-sm" : "text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
              )}
            >
              One-time
            </button>
          </div>
        </div>
        {isOneTimeBudget ? (
          <div>
            <Label htmlFor="api-key-one-time">One-time token limit</Label>
            <Input id="api-key-one-time" name="oneTimeTokenLimit" type="number" min="0" inputMode="numeric" value={oneTime} onChange={(event) => setOneTime(event.target.value)} placeholder="Unlimited…" disabled={busy} />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="api-key-daily">Daily token limit</Label>
              <Input id="api-key-daily" name="dailyTokenLimit" type="number" min="0" inputMode="numeric" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="Unlimited…" disabled={busy} />
            </div>
            <div>
              <Label htmlFor="api-key-monthly">Monthly token limit</Label>
              <Input id="api-key-monthly" name="monthlyTokenLimit" type="number" min="0" inputMode="numeric" value={monthly} onChange={(event) => setMonthly(event.target.value)} placeholder="Unlimited…" disabled={busy} />
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3.5">
        <div>
          <h3 className="text-sm font-bold text-[var(--text-1)]">Access</h3>
          <p className="mt-0.5 text-[11px] text-[var(--text-3)]">If a whitelist is set, every other model is denied.</p>
        </div>
        <ModelPickerField
          label="Allowed models"
          hint="Leave empty to allow every model."
          values={models}
          onChange={setModels}
          mode="models"
          includeCombos
          includeAliases
          includeCustomProviders={false}
          disabled={busy}
        />
      </section>

      {mode === "edit" && (
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-bold text-[var(--text-1)]">Quote metadata</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-3)]">Optional text shown on shared quote pages.</p>
          </div>
          <Input id="api-key-quote-title" name="quoteBigText" value={quoteBigText} onChange={(event) => setQuoteBigText(event.target.value)} placeholder="Quote headline…" disabled={busy} />
          <Input id="api-key-quote-subtitle" name="quoteSubText" value={quoteSubText} onChange={(event) => setQuoteSubText(event.target.value)} placeholder="Quote subtitle…" disabled={busy} />
          <textarea id="api-key-quote-body" name="quoteBody" value={quoteBody} onChange={(event) => setQuoteBody(event.target.value)} placeholder="Quote body…" disabled={busy} rows={3} className="w-full rounded-lg border border-[var(--inner-border)] bg-transparent px-3 py-2 text-sm text-[var(--text-1)] outline-none focus:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]" />
        </section>
      )}

      <div className="flex flex-col-reverse gap-2 border-t border-[var(--inner-border)] pt-4 sm:flex-row sm:justify-end">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" disabled={busy || (mode === "create" && name.trim().length === 0)} onClick={submit}>{busy ? "Saving…" : mode === "create" ? "Create API key" : "Save changes"}</Button>
      </div>
    </div>
  );
}

export function ApiKeysPanel() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyRecord | null>(null);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const keysQuery = useQuery({ queryKey: qk.apiKeys.all, queryFn: () => apiGet<{ items: ApiKeyRecord[] }>("/keys") });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: qk.apiKeys.all });
  const createMutation = useMutation({ mutationFn: (input: Record<string, unknown>) => apiPost<CreatedKey>("/keys", input), onSuccess: (created) => { setCreateOpen(false); setRevealed(created); invalidate(); }, onError: (error) => toast.error(getErrorMessage(error, "Failed to create key")) });
  const editMutation = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => apiPatch<ApiKeyRecord>(`/keys/${id}`, patch), onSuccess: () => { setEditTarget(null); invalidate(); toast.success("Key updated"); }, onError: (error) => toast.error(getErrorMessage(error, "Failed to update key")) });
  const deleteMutation = useMutation({ mutationFn: (id: string) => apiDelete(`/keys/${id}`), onSuccess: () => { invalidate(); toast.success("Key revoked"); }, onError: (error) => toast.error(getErrorMessage(error, "Failed to revoke key")) });
  const shareMutation = useMutation({ mutationFn: (id: string) => apiPost<{ url: string }>(`/keys/${id}/share`, {}), onSuccess: async ({ url }) => { const copied = await copyToClipboard(url); toast[copied ? "success" : "error"](copied ? "Share URL copied" : "Share URL created; clipboard unavailable"); }, onError: (error) => toast.error(getErrorMessage(error, "Failed to create share link")) });
  if (keysQuery.isLoading) return <StatePanel kind="loading" title="Loading API keys" />;
  if (keysQuery.isError) return <StatePanel kind="error" title="Failed to load API keys" description={getErrorMessage(keysQuery.error)} action={<Button variant="secondary" onClick={() => void keysQuery.refetch()}>Retry</Button>} />;
  const keys = keysQuery.data?.items ?? [];

  return <>
    <Card><CardHeader title="API Keys" sub="Credentials, budgets, access rules, and share links" icon={KeyRound}><Button className="w-full justify-center sm:w-auto" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> New key</Button></CardHeader>
      <div className="space-y-2">{keys.length === 0 ? <StatePanel kind="empty" title="No API keys" description="Create a key for a client or automation job." action={<Button size="sm" onClick={() => setCreateOpen(true)}>Create API key</Button>} /> : keys.map((key) => <div key={key.id} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-[var(--text-1)]">{key.name}</span><Badge tone={key.active ? "ok" : "err"}>{key.active ? "active" : "revoked"}</Badge></div><code className="mt-1 block font-mono text-xs text-[var(--text-2)]">{key.keyPrefix}…</code><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-3)]"><span>RPM {limitLabel(key.rateLimitRpm)}</span><span>Daily {limitLabel(key.dailyTokenLimit)}</span><span>Concurrent {limitLabel(key.maxConcurrentRequests)}</span><span>Last used {formatDate(key.lastUsedAt)}</span></div></div><div className="flex flex-wrap gap-1.5"><Button variant="ghost" size="sm" onClick={() => setEditTarget(key)}><Pencil size={13} /> Edit</Button><Button variant="ghost" size="sm" onClick={() => shareMutation.mutate(key.id)} disabled={shareMutation.isPending}><Share2 size={13} /> Share</Button><Button variant="ghost" size="sm" onClick={() => deleteMutation.mutate(key.id)} disabled={deleteMutation.isPending}><Trash2 size={13} /> Revoke</Button></div></div></div>)}</div>
    </Card>
    <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key" wide><KeyForm mode="create" record={null} busy={createMutation.isPending} onClose={() => setCreateOpen(false)} onDone={(input) => createMutation.mutate({ name: input.name, prefix: input.prefix, key: input.customKey, ...input.limits })} /></Dialog>
    <Dialog open={editTarget !== null} onClose={() => setEditTarget(null)} title="Edit API key" wide><KeyForm mode="edit" record={editTarget} busy={editMutation.isPending} onClose={() => setEditTarget(null)} onDone={(input) => editTarget && editMutation.mutate({ id: editTarget.id, patch: { ...(input.customKey ? { key: input.customKey } : {}), ...input.limits, rateLimitRpm: input.limits.rateLimitRpm ?? null, dailyTokenLimit: input.limits.dailyTokenLimit ?? null, monthlyTokenLimit: input.limits.monthlyTokenLimit ?? null, oneTimeTokenLimit: input.limits.oneTimeTokenLimit ?? null, maxConcurrentRequests: input.limits.maxConcurrentRequests ?? null, modelAllowlist: input.limits.modelAllowlist ?? null, providerAllowlist: null, modelDenylist: null, quoteBigText: input.quoteBigText ?? null, quoteSubText: input.quoteSubText ?? null, quoteBody: input.quoteBody ?? null } })} /></Dialog>
    {revealed && <Dialog open={true} onClose={() => setRevealed(null)} title="New API key created"><div className="space-y-3"><p className="text-sm text-[var(--text-2)]">{revealed.note ?? "Store this key safely. It will not be shown again."}</p><code className="block break-all rounded-xl border border-[var(--inner-border)] bg-[var(--kbd-bg)] p-3 text-sm text-[var(--accent)]">{revealed.key}</code><ClipboardButton value={revealed.key} /></div></Dialog>}
  </>;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Activity, Clock3, Gauge, KeyRound, ListChecks, Pencil, Plus, Share2, Trash2 } from "lucide-react";
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
import { StatePanel, StatCard } from "../../components/ui/state";

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
  totalUsage: number;
  totalRequests: number;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CreatedKey {
  key: string;
  note?: string;
}

type TokenBudgetMode = "recurring" | "one-time";

const TOKEN_BUDGET_PRESETS = [
  { label: "1M", value: "1M", amount: 1_000_000, description: "1 million" },
  { label: "100M", value: "100M", amount: 100_000_000, description: "100 million" },
  { label: "1B", value: "1B", amount: 1_000_000_000, description: "1 billion" },
  { label: "1T", value: "1T", amount: 1_000_000_000_000, description: "1 trillion" },
] as const;

const TOKEN_SUFFIX_MULTIPLIERS: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
  T: 1_000_000_000_000,
};

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

/** Parses token counts with optional K/M/B/T suffixes, e.g. 1.5B. */
export function parseTokenLimit(value: string): number | undefined {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kmbt])?$/i);
  if (!match) return undefined;
  const multiplier = match[2] ? TOKEN_SUFFIX_MULTIPLIERS[match[2].toUpperCase()] : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function tokenInputValue(value: number | null): string {
  if (value === null) return "";
  return TOKEN_BUDGET_PRESETS.find((preset) => preset.amount === value)?.value ?? String(value);
}

function compactTokenLimit(value: number): string {
  const preset = TOKEN_BUDGET_PRESETS.find((entry) => entry.amount === value);
  if (preset) return preset.label;
  const units = [
    { suffix: "T", amount: 1_000_000_000_000 },
    { suffix: "B", amount: 1_000_000_000 },
    { suffix: "M", amount: 1_000_000 },
    { suffix: "K", amount: 1_000 },
  ];
  const unit = units.find((entry) => value >= entry.amount);
  if (!unit) return value.toLocaleString();
  const amount = value / unit.amount;
  return `${Number(amount.toFixed(2))}${unit.suffix}`;
}

function tokenLimitMeasurement(value: string): string {
  if (!value.trim()) return "Leave empty for unlimited.";
  const parsed = parseTokenLimit(value);
  if (parsed === undefined) return "Use whole tokens or a suffix such as 1.5B.";
  return `${parsed.toLocaleString()} tokens · ${compactTokenLimit(parsed)}`;
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
  const rateLimitRpm = parseLimit(rpm);
  const maxConcurrentRequests = parseLimit(concurrent);
  const tokenLimit = budgetMode === "one-time" ? parseTokenLimit(oneTime) : undefined;
  const dailyTokenLimit = budgetMode === "recurring" ? parseTokenLimit(daily) : undefined;
  const monthlyTokenLimit = budgetMode === "recurring" ? parseTokenLimit(monthly) : undefined;
  return {
    ...(rateLimitRpm !== undefined ? { rateLimitRpm } : {}),
    ...(tokenLimit !== undefined ? { oneTimeTokenLimit: tokenLimit } : {}),
    ...(dailyTokenLimit !== undefined ? { dailyTokenLimit } : {}),
    ...(monthlyTokenLimit !== undefined ? { monthlyTokenLimit } : {}),
    ...(maxConcurrentRequests !== undefined ? { maxConcurrentRequests } : {}),
    ...(selected.length > 0 ? { modelAllowlist: selected } : {}),
  };
}
function formatDate(value: string | null): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unknown";
}

function formatTokenUsage(value: number): string {
  return compactTokenLimit(Math.max(0, value));
}

function formatRequestCount(value: number): string {
  return Math.max(0, value).toLocaleString();
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
interface TokenBudgetFieldProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

function TokenBudgetField({ id, name, label, value, onChange, disabled }: TokenBudgetFieldProps) {
  const parsed = parseTokenLimit(value);
  const selectedPreset = TOKEN_BUDGET_PRESETS.find((preset) => preset.amount === parsed)?.value ?? "custom";
  const presetClass = "rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)] disabled:opacity-40";
  return (
    <div className="min-w-0">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type="text" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Unlimited…" disabled={disabled} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={`${label} presets`}>
        {TOKEN_BUDGET_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            aria-pressed={selectedPreset === preset.value}
            aria-label={`${preset.label}, ${preset.description} tokens`}
            onClick={() => onChange(preset.value)}
            disabled={disabled}
            className={cn(
              presetClass,
              selectedPreset === preset.value
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--inner-border)] text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
            )}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={selectedPreset === "custom"}
          onClick={() => { if (selectedPreset !== "custom") onChange(""); }}
          disabled={disabled}
          className={cn(
            presetClass,
            selectedPreset === "custom"
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--inner-border)] text-[var(--text-3)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
          )}
        >
          Custom
        </button>
      </div>
      <p aria-live="polite" className="mt-1.5 text-[10px] tabular-nums text-[var(--text-3)]">{tokenLimitMeasurement(value)}</p>
    </div>
  );
}


function KeyForm({ mode, record, busy, onDone, onClose }: KeyFormProps) {
  const [name, setName] = useState(record?.name ?? "");
  const [customKey, setCustomKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [rpm, setRpm] = useState(record?.rateLimitRpm?.toString() ?? "");
  const [daily, setDaily] = useState(tokenInputValue(record?.dailyTokenLimit ?? null));
  const [monthly, setMonthly] = useState(tokenInputValue(record?.monthlyTokenLimit ?? null));
  const [oneTime, setOneTime] = useState(tokenInputValue(record?.oneTimeTokenLimit ?? null));
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
          <TokenBudgetField id="api-key-one-time" name="oneTimeTokenLimit" label="One-time token limit" value={oneTime} onChange={setOneTime} disabled={busy} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <TokenBudgetField id="api-key-daily" name="dailyTokenLimit" label="Daily token limit" value={daily} onChange={setDaily} disabled={busy} />
            <TokenBudgetField id="api-key-monthly" name="monthlyTokenLimit" label="Monthly token limit" value={monthly} onChange={setMonthly} disabled={busy} />
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
  const totalKeys = keys.length;
  const activeKeys = keys.filter((key) => key.active).length;
  const expiredKeys = totalKeys - activeKeys;
  const totalUsage = keys.reduce((sum, key) => sum + Math.max(0, key.totalUsage), 0);
  const totalRequests = keys.reduce((sum, key) => sum + Math.max(0, key.totalRequests), 0);

  return <>
    <Card className="api-keys-card">
      <CardHeader title="API Keys" sub="Access, budgets, and usage at a glance." icon={KeyRound}>
        <Button className="w-full justify-center sm:w-auto" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> New key</Button>
      </CardHeader>
      <div className="api-key-stats grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard className="api-key-stat" label="Limit" icon={Gauge} tone="neutral" value={<><span>{activeKeys}</span><span className="mx-1 text-[var(--text-3)]">/</span><span className="text-[var(--text-2)]">{totalKeys}</span></>} description="Active keys" />
        <StatCard className="api-key-stat" label="Total usage" icon={Activity} tone="info" value={formatTokenUsage(totalUsage)} description="All-time tokens" />
        <StatCard className="api-key-stat" label="Total requests" icon={ListChecks} tone="accent" value={formatRequestCount(totalRequests)} description="All-time requests" />
        <StatCard className="api-key-stat" label="Expired" icon={Clock3} tone={expiredKeys > 0 ? "warning" : "neutral"} value={expiredKeys} description="Revoked keys" />
      </div>
      <div className="space-y-2.5">
        {keys.length === 0 ? (
          <StatePanel kind="empty" title="No API keys" description="Create a key for a client or automation job." action={<Button size="sm" onClick={() => setCreateOpen(true)}>Create API key</Button>} />
        ) : keys.map((key) => (
          <article key={key.id} className="api-key-row">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <span className="api-key-icon" aria-hidden="true"><KeyRound size={14} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-[var(--text-1)]">{key.name}</span>
                  <Badge tone={key.active ? "ok" : "err"}>{key.active ? "active" : "revoked"}</Badge>
                </div>
                <code className="mt-1 block max-w-full truncate font-mono text-xs text-[var(--text-2)]">{key.keyPrefix}…</code>
                <div className="api-key-meta">
                  <span>Usage {formatTokenUsage(key.totalUsage ?? 0)}</span>
                  <span>Requests {formatRequestCount(key.totalRequests ?? 0)}</span>
                  <span>RPM {limitLabel(key.rateLimitRpm)}</span>
                  <span>Daily {limitLabel(key.dailyTokenLimit)}</span>
                  <span>Concurrent {limitLabel(key.maxConcurrentRequests)}</span>
                  <span>Models {key.modelAllowlist?.length ?? "All"}</span>
                  <span>Last used {formatDate(key.lastUsedAt)}</span>
                </div>
              </div>
            </div>
            <div className="api-key-actions">
              <Button variant="ghost" size="sm" onClick={() => setEditTarget(key)}><Pencil size={13} /> Edit</Button>
              <Button variant="ghost" size="sm" onClick={() => shareMutation.mutate(key.id)} disabled={shareMutation.isPending}><Share2 size={13} /> Share</Button>
              <Button variant="ghost" size="sm" onClick={() => deleteMutation.mutate(key.id)} disabled={deleteMutation.isPending}><Trash2 size={13} /> Revoke</Button>
            </div>
          </article>
        ))}
      </div>
    </Card>
    <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key" wide><KeyForm mode="create" record={null} busy={createMutation.isPending} onClose={() => setCreateOpen(false)} onDone={(input) => createMutation.mutate({ name: input.name, prefix: input.prefix, key: input.customKey, ...input.limits })} /></Dialog>
    <Dialog open={editTarget !== null} onClose={() => setEditTarget(null)} title="Edit API key" wide><KeyForm mode="edit" record={editTarget} busy={editMutation.isPending} onClose={() => setEditTarget(null)} onDone={(input) => editTarget && editMutation.mutate({ id: editTarget.id, patch: { ...(input.customKey ? { key: input.customKey } : {}), ...input.limits, rateLimitRpm: input.limits.rateLimitRpm ?? null, dailyTokenLimit: input.limits.dailyTokenLimit ?? null, monthlyTokenLimit: input.limits.monthlyTokenLimit ?? null, oneTimeTokenLimit: input.limits.oneTimeTokenLimit ?? null, maxConcurrentRequests: input.limits.maxConcurrentRequests ?? null, modelAllowlist: input.limits.modelAllowlist ?? null, providerAllowlist: null, modelDenylist: null, quoteBigText: input.quoteBigText ?? null, quoteSubText: input.quoteSubText ?? null, quoteBody: input.quoteBody ?? null } })} /></Dialog>
    {revealed && <Dialog open={true} onClose={() => setRevealed(null)} title="New API key created"><div className="space-y-3"><p className="text-sm text-[var(--text-2)]">{revealed.note ?? "Store this key safely. It will not be shown again."}</p><code className="block break-all rounded-xl border border-[var(--inner-border)] bg-[var(--kbd-bg)] p-3 text-sm text-[var(--accent)]">{revealed.key}</code><ClipboardButton value={revealed.key} /></div></Dialog>}
  </>;
}

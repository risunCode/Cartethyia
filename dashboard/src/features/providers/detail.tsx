/**
 * Provider detail — model catalog + test modal (account/manual), routing form,
 * accounts CRUD (REQ-11, REQ-20).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowUpDown, Bot, Cable, Copy, ExternalLink, Eye, FlaskConical, Info, LockOpen, Pencil, Plus, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useCallback, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ApiError, apiGet, apiPost, api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { extractCredentialFromPaste } from "../../lib/credentialExtract";
import { formatDuration, formatTokens } from "../../lib/format";
import { staggerItem } from "../../lib/motion";
import { Badge, Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Select } from "../../components/ui/tabs";

import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { ConfirmDialog } from "../../components/shared";

interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface ModelEntry {
  id: string;
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled: boolean;
  source: "built-in" | "manual" | "imported";
  pricing?: ModelPricing;
}

/** "$5 / $30 per 1M" style, or "Free" for a genuinely $0 flat-plan model, distinct from no pricing data at all. */
function formatModelPricing(pricing: ModelPricing | undefined): string | null {
  if (!pricing) return null;
  if (pricing.input === 0 && pricing.output === 0) return "Free";
  const fmt = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  return `${fmt(pricing.input)} / ${fmt(pricing.output)} per 1M`;
}

interface AccountEntry {
  id: string;
  provider: string;
  name: string;
  credentialKind: string;
  credentialHint: string;
  proxyPoolId: string | null;
  useDirect: boolean;
  priority: number;
  active: boolean;
}

interface RoutingConfig {
  strategy: "priority" | "round-robin";
  stickyLimit: number;
  proxyMode: "direct" | "proxy-pool" | "mixed";
  proxyPoolId: string | null;
}

interface ProviderDetail {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "api-key";
  authHint: string;
  credentialUrl: string | null;
  /** bearer/pat/session-token — the credentialKind the account form must submit for this provider. */
  accountCredentialKind: string;
  prefix: string;
  models: ModelEntry[];
  modelManagement: {
    canAddModels: boolean;
    canFetchModels: boolean;
  };
  status: "ok" | "warn";
  usageToday: { requestsToday: number; input: number; cached: number; output: number; errors: number; lastError: string | null } | null;
  routing: RoutingConfig;
  accounts: AccountEntry[];
}

interface TestResult {
  resolveOk: boolean;
  latencyMs: number;
  ok: boolean;
  sample?: string;
  error?: string;
}

type AccountTestStatus =
  | { state: "testing" }
  | { state: "passed"; latencyMs: number }
  | { state: "failed"; error: string };

type AccountSortKey = "name" | "priority" | "status";

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "request failed";
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-[var(--kbd-bg)] px-1 py-0.5 font-mono text-[11px]">{part.slice(1, -1)}</code>;
    return part;
  });
}

function renderTestSample(sample: string): ReactNode {
  return (
    <div className="max-w-sm whitespace-pre-wrap text-xs leading-5 text-[var(--text-2)]">
      {sample.split("\n").map((line, index) => <p key={index}>{renderInlineMarkdown(line)}</p>)}
    </div>
  );
}

/**
 * Copies the qualified routing name. `navigator.clipboard` is absent on
 * insecure origins (plain-http LAN access is a supported deployment), so the
 * failure path has to be a toast rather than an unhandled rejection.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("unavailable");
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Clipboard unavailable on this origin");
  }
}

// Reasoning is assumed for every model here; vision is the one flag that
// actually varies, so it's the only badge worth surfacing.

// ── Model test modal ─────────────────────────────────────────────────────
/**
 * Runs a model test and reports it entirely through a sliding toast — no
 * modal, ever. Testing never asks for a credential either: the server
 * rotates a stored account itself (mode "auto", the same picker the live
 * proxy uses) and gracefully runs with none at all when the provider needs
 * no auth in the first place. A stored account is only a hard requirement
 * when the provider actually needs a real credential, in which case the
 * toast carries an "Add account" action instead of blocking with a dialog.
 *
 * One mutation instance is shared across every model card on the page, so
 * `pendingModelId` names which model (if any) is currently in flight.
 */
function useAccountConnectionTest(providerId: string, models: ModelEntry[], onStatus: (accountId: string, status: AccountTestStatus) => void) {
  const testMutation = useMutation({
    mutationFn: async (accounts: AccountEntry[]) => {
      const model = models[0];
      if (!model) throw new Error("No model is available to test this connection.");
      const results: Array<{ account: AccountEntry; result: TestResult }> = new Array(accounts.length);
      // A small worker pool avoids serial tests while respecting provider limits.
      const workerCount = Math.min(accounts.length, Math.max(2, Math.ceil(accounts.length / 3)));
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < accounts.length) {
          const index = nextIndex++;
          const account = accounts[index]!;
          onStatus(account.id, { state: "testing" });
          try {
            const result = await apiPost<TestResult>(`/providers/${providerId}/models/${encodeURIComponent(model.id)}/test`, { mode: "account", accountId: account.id });
            results[index] = { account, result };
            onStatus(account.id, result.ok
              ? { state: "passed", latencyMs: result.latencyMs }
              : { state: "failed", error: result.error ?? "No response" });
          } catch (error) {
            const result: TestResult = { resolveOk: false, latencyMs: 0, ok: false, error: errorMessage(error) };
            results[index] = { account, result };
            onStatus(account.id, { state: "failed", error: result.error ?? "request failed" });
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, worker));
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter(({ result }) => !result.ok);
      if (failed.length === 0) {
        toast.success(`${results.length} connection${results.length === 1 ? "" : "s"} passed`, { description: results.map(({ account, result }) => `${account.name} · ${formatDuration(result.latencyMs)}`).join("\n") });
        return;
      }
      toast.error(`${failed.length} connection${failed.length === 1 ? "" : "s"} failed`, { description: failed.map(({ account, result }) => `${account.name} · ${result.error ?? "No response"}`).join("\n") });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return {
    testAccount: (account: AccountEntry) => testMutation.mutate([account]),
    testActive: (accounts: AccountEntry[]) => testMutation.mutate(accounts),
    isPending: testMutation.isPending,
  };
}

/**
 * Copies one account's credential. The secret is fetched on demand rather
 * than carried in the accounts list, so it only crosses the wire when the
 * operator actually clicks copy.
 */
function useCredentialCopy(providerId: string) {
  return useMutation({
    mutationFn: async (account: AccountEntry) => {
      const { credential } = await apiGet<{ credential: string }>(`/providers/${providerId}/accounts/${account.id}/credential`);
      await navigator.clipboard.writeText(credential);
      return account.name;
    },
    onSuccess: (name) => toast.success(`Copied ${name}'s credential`),
    onError: (err) => toast.error(errorMessage(err)),
  });
}

function useModelTest(providerId: string, authKind: "none" | "session" | "api-key", accounts: AccountEntry[], onAddAccount: () => void) {
  const activeAccounts = accounts.filter((a) => a.active);
  const needsAccount = authKind !== "none" && activeAccounts.length === 0;

  const testMutation = useMutation({
    mutationFn: (modelId: string) => apiPost<TestResult>(`/providers/${providerId}/models/${encodeURIComponent(modelId)}/test`, { mode: "auto" }),
    onSuccess: (result, modelId) => {
      if (result.ok) {
        toast.success(`${modelId} · ${formatDuration(result.latencyMs)}`, {
          description: result.sample ? renderTestSample(result.sample) : "No sample text in the response.",
        });
      } else {
        toast.error(`${modelId} failed`, { description: result.error ?? "Unknown error." });
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const run = (modelId: string) => {
    if (needsAccount) {
      toast.error("No stored accounts", {
        description: "This provider needs a real credential to test against.",
        action: { label: "Add account", onClick: onAddAccount },
      });
      return;
    }
    testMutation.mutate(modelId);
  };

  return { run, pendingModelId: testMutation.isPending ? testMutation.variables : undefined };
}

// Extra guidance shown under the credential field for providers whose raw
// export format isn't just a bare token — tells the operator what a paste
// can look like and that JSON is auto-parsed.
const CREDENTIAL_PASTE_HINTS: Record<string, string> = {
  cursor:
    "Paste the OAuth access token, or paste the whole exported account JSON " +
    '(e.g. { "id", "provider", "credential_type", "data": "{\\"access\\":...}" }) — ' +
    "the access token is auto-extracted from data.access.",
  devin: "Paste the session token, or a full exported JSON containing an access/session field — it's auto-extracted.",
  qoder: "Paste the PAT (personal access token) directly.",
};

// ── Account create/edit modal ────────────────────────────────────────────
function AccountModal({
  providerId,
  expectedKind,
  existing,
  accounts,
  onClose,
}: {
  providerId: string;
  expectedKind: string;
  existing: AccountEntry | null;
  accounts: AccountEntry[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  // Auto-generate next account name for new accounts.
  const defaultName = existing
    ? existing.name
    : (() => {
        const prefix = providerId === "opencode-free" ? "opencode" : providerId;
        const existingNames = new Set(accounts.map((a) => a.name));
        let n = accounts.length + 1;
        while (existingNames.has(`${prefix}-${n}`)) n++;
        return `${prefix}-${n}`;
      })();
  const [name, setName] = useState(defaultName);
  const [credential, setCredential] = useState("");
  const pasteHint = CREDENTIAL_PASTE_HINTS[providerId];
  // A whole-textarea JSON blob (Cursor/Devin export rows, etc.) is one
  // credential, not newline-separated batch entries — extract it as a
  // single value instead of splitting on "\n". Plain multi-line paste (one
  // token per line) is unaffected since each line individually won't parse
  // as a JSON object.
  const trimmedCredential = credential.trim();
  const detectedCredential = extractCredentialFromPaste(trimmedCredential);
  const credentials = detectedCredential.extracted
    ? [detectedCredential.value]
    : credential.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);

  const mutation = useMutation({
    mutationFn: async (): Promise<number> => {
      if (existing) {
        const patch: Record<string, unknown> = { name: name.trim() };
        if (credential) patch.credential = extractCredentialFromPaste(credential).value;
        await apiPost<{ ok?: boolean }>(`/providers/${providerId}/accounts/${existing.id}`, patch);
        return 1;
      }

      const existingNames = new Set(accounts.map((account) => account.name));
      const names = credentials.map((_, index) => {
        if (credentials.length === 1) return name.trim();
        let number = index + 1;
        let candidate = `${providerId}-${number}`;
        while (existingNames.has(candidate)) candidate = `${providerId}-${++number}`;
        existingNames.add(candidate);
        return candidate;
      });
      await Promise.all(credentials.map((value, index) => apiPost<{ id?: string }>(`/providers/${providerId}/accounts`, {
        name: names[index],
        credentialKind: expectedKind,
        credential: value,
      })));
      return credentials.length;
    },
    onSuccess: (created) => {
      toast.success(existing ? "Account updated" : `${created} connection${created === 1 ? "" : "s"} added`);
      void queryClient.invalidateQueries({ queryKey: ["provider", providerId] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const valid = name.trim().length > 0 && (existing ? true : credentials.length > 0);

  return (
    <Dialog open onClose={onClose} title={existing ? `Edit ${existing.name}` : "Add connections"}>
      <div className="space-y-3">
        <div>
          <Label>{existing ? "Name" : "Name (used for one credential)"}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="account-1" />
        </div>
        <div>
          <Label>Credential ({expectedKind}){existing ? " — leave empty to keep current" : " — one per line for batch add, or paste a JSON export"}</Label>
          {pasteHint && <p className="mb-1.5 text-xs text-[var(--text-3)]">{pasteHint}</p>}
          <div className="flex gap-2">
            {existing ? (
              <Input
                className="flex-1"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                type="password"
                placeholder="••••••"
              />
            ) : (
              <textarea
                className="min-h-24 flex-1 rounded-xl border border-[var(--inner-border)] bg-[var(--input-bg)] px-3 py-2 font-mono text-xs outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)]"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={`Paste ${expectedKind} values, one per line…`}
                spellCheck={false}
              />
            )}
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  setCredential(text);
                  const extracted = extractCredentialFromPaste(text);
                  if (extracted.extracted) {
                    toast.success(`Detected credential from JSON (${extracted.source ?? "data"})`);
                  } else {
                    toast.success("Pasted from clipboard");
                  }
                } catch {
                  toast.error("Clipboard access denied");
                }
              }}
            >
              Paste
            </Button>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>{existing ? "Save" : credentials.length > 1 ? `Add ${credentials.length}` : "Add connection"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [accountModal, setAccountModal] = useState<{ open: boolean; existing: AccountEntry | null }>({ open: false, existing: null });
  const [deleteTarget, setDeleteTarget] = useState<AccountEntry | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [manualModelId, setManualModelId] = useState("");
  const [accountTestStatus, setAccountTestStatus] = useState<Record<string, AccountTestStatus>>({});
  const [accountSort, setAccountSort] = useState<{ key: AccountSortKey; direction: "asc" | "desc" }>({ key: "priority", direction: "asc" });

  // Routing form state (synced from server on load)
  const [routing, setRouting] = useState<RoutingConfig | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["provider", id],
    queryFn: () => apiGet<ProviderDetail>(`/providers/${id}`),
    enabled: Boolean(id),
  });

  if (data && !routing) setRouting(data.routing);

  const routingMutation = useMutation({
    mutationFn: (config: RoutingConfig) => apiPost<{ ok: boolean; routing: RoutingConfig }>(`/providers/${id}/routing`, config),
    onSuccess: ({ routing: savedRouting }) => {
      setRouting(savedRouting);
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
    },
    onError: async (err) => {
      toast.error(errorMessage(err));
      const current = await queryClient.fetchQuery({
        queryKey: ["provider", id],
        queryFn: () => apiGet<ProviderDetail>(`/providers/${id}`),
      });
      setRouting(current.routing);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (accountId: string) => api<{ ok: boolean }>(`/providers/${id}/accounts/${accountId}`, { method: "DELETE", body: "{}" }),
    onSuccess: () => {
      toast.success("Account deleted");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Bulk actions reuse the single-account endpoints — there is no bulk
  // route on the server, so this fires the existing PATCH/DELETE per selected
  // id and settles once every request has resolved.
  const bulkActiveMutation = useMutation({
    mutationFn: ({ ids, active }: { ids: string[]; active: boolean }) =>
      Promise.all(ids.map((accountId) => apiPost(`/providers/${id}/accounts/${accountId}`, { active }))),
    onSuccess: (_res, { ids, active }) => {
      toast.success(`${ids.length} account${ids.length === 1 ? "" : "s"} ${active ? "enabled" : "disabled"}`);
      setSelectedAccounts(new Set());
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const modelMutation = useMutation({
    mutationFn: ({ path, body, method = "POST" }: { path: string; body?: Record<string, unknown>; method?: "POST" | "DELETE" }) =>
      method === "DELETE"
        ? api<{ ok: boolean }>(`/providers/${id}/models${path}`, { method: "DELETE", body: "{}" })
        : apiPost(`/providers/${id}/models${path}`, body ?? {}),
    onSuccess: (_result, { path }) => {
      if (path === "") setManualModelId("");
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((accountId) => api<{ ok: boolean }>(`/providers/${id}/accounts/${accountId}`, { method: "DELETE", body: "{}" }))),
    onSuccess: (_res, ids) => {
      toast.success(`${ids.length} account${ids.length === 1 ? "" : "s"} deleted`);
      setSelectedAccounts(new Set());
      setBulkDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Declared unconditionally, ahead of the loading-state early return below
  // (rules of hooks) — falls back to safe empty values until `data` arrives.
  const { run: runTest, pendingModelId } = useModelTest(
    id ?? "",
    data?.authKind ?? "api-key",
    data?.accounts ?? [],
    () => setAccountModal({ open: true, existing: null })
  );
  const updateAccountTestStatus = useCallback((accountId: string, status: AccountTestStatus) => {
    setAccountTestStatus((previous) => ({ ...previous, [accountId]: status }));
  }, []);
  const accountConnectionTest = useAccountConnectionTest(id ?? "", data?.models ?? [], updateAccountTestStatus);
  const credentialCopy = useCredentialCopy(id ?? "");

  if (!id) return null;

  if (isLoading || !data || !routing) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  // Sourced from the API, not a locally duplicated per-provider map (which
  // previously fell back to "bearer" for any provider it didn't list —
  // silently wrong for e.g. Cursor's "session-token", causing every account
  // add via this form to 400 against the backend's real expectation).
  const expectedKind = data.accountCredentialKind;
  const connections = data.accounts.filter((a) => a.active).length;
  const noAuth = data.authKind === "none";
  const activeModels = data.models.filter((model) => model.enabled);
  const disabledModels = data.models.filter((model) => !model.enabled);
  const accountStatusRank = (account: AccountEntry) => {
    const state = accountTestStatus[account.id]?.state;
    if (state === "testing") return 0;
    if (state === "passed") return 1;
    if (state === "failed") return 2;
    return account.active ? 3 : 4;
  };
  const sortedAccounts = [...data.accounts].sort((left, right) => {
    const comparison = accountSort.key === "name"
      ? left.name.localeCompare(right.name)
      : accountSort.key === "priority"
        ? left.priority - right.priority
        : accountStatusRank(left) - accountStatusRank(right);
    return accountSort.direction === "asc" ? comparison : -comparison;
  });
  const toggleAccountSort = (key: AccountSortKey) => {
    setAccountSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };
  const renderAccountStatus = (account: AccountEntry) => {
    const testStatus = accountTestStatus[account.id];
    if (testStatus?.state === "testing") return <Badge tone="warn">testing</Badge>;
    if (testStatus?.state === "passed") return <Badge tone="ok">passed · {formatDuration(testStatus.latencyMs)}</Badge>;
    if (testStatus?.state === "failed") return <Badge tone="err" title={testStatus.error}>failed</Badge>;
    return <Badge tone={account.active ? "ok" : "default"}>{account.active ? "active" : "disabled"}</Badge>;
  };
  const renderModel = (model: ModelEntry, index: number) => {
    const qualified = `${data.prefix}/${model.id}`;
    const priceLabel = formatModelPricing(model.pricing);
    return (
      <motion.div key={model.id} {...staggerItem(index)}>
        <Card className={cn("flex h-full flex-col gap-1 p-2 transition-transform duration-150 hover:-translate-y-0.5 sm:gap-1.5 sm:p-2.5", !model.enabled && "opacity-65")}>
          <div className="flex items-start gap-1.5 sm:gap-2">
            <Bot size={13} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
            <div className="min-w-0">
              <div className="break-all font-mono text-[10px] font-semibold text-[var(--text-1)] sm:text-[11px]">{qualified}</div>
              <div className="mt-0.5 break-all text-[9px] text-[var(--text-3)] sm:text-[10px]">{model.id}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {model.source !== "built-in" && <Badge tone="info">{model.source}</Badge>}
            {model.vision && (
              <span title="Vision" aria-label="Vision" className="grid h-5 w-5 place-items-center rounded-md bg-[var(--hover)] text-[var(--teal)]">
                <Eye size={11} aria-hidden="true" />
              </span>
            )}
          </div>
          {Boolean(model.contextWindow || model.maxOutputTokens) && (
            <div className="hidden text-[9px] text-[var(--text-2)] sm:block">
              {model.contextWindow ? `${formatTokens(model.contextWindow)} context` : null}
              {model.contextWindow && model.maxOutputTokens ? " \u00b7 " : null}
              {model.maxOutputTokens ? `${formatTokens(model.maxOutputTokens)} max output` : null}
            </div>
          )}
          {priceLabel && <div className="hidden text-[9px] text-[var(--text-2)] sm:block">{priceLabel}</div>}
          <div className="mt-auto flex gap-1 pt-0.5 sm:gap-1.5">
            <Button variant="secondary" size="sm" className="flex-1" disabled={!model.enabled || pendingModelId === model.id} onClick={() => runTest(model.id)}>
              <FlaskConical size={12} /> {pendingModelId === model.id ? "Testing…" : "Test"}
            </Button>
            <Button variant="secondary" size="sm" disabled={modelMutation.isPending} onClick={() => modelMutation.mutate({ path: `/${encodeURIComponent(model.id)}/enabled`, body: { enabled: !model.enabled } })}>
              {model.enabled ? "Disable" : "Enable"}
            </Button>
            {model.source !== "built-in" && (
              <Button variant="ghost" size="sm" className="text-[var(--red)]" aria-label={`Delete ${qualified}`} disabled={modelMutation.isPending} onClick={() => modelMutation.mutate({ path: `/${encodeURIComponent(model.id)}`, method: "DELETE" })}>
                <Trash2 size={12} />
              </Button>
            )}
            <Button variant="ghost" size="sm" aria-label={`Copy ${qualified}`} onClick={() => void copyToClipboard(qualified)}>
              <Copy size={12} />
            </Button>
          </div>
        </Card>
      </motion.div>
    );
  };

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
          <ProviderIcon icon={data.icon} name={data.name} size={48} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{data.name}</h1>
              <code className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--accent)]">
                {data.prefix}
              </code>
              {data.credentialUrl && (
                <a
                  href={data.credentialUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--accent)] hover:underline"
                >
                  <ExternalLink size={12} /> Get API Key
                </a>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--text-2)]">
              <StatusDot status={data.status} />
              <span>{connections === 1 ? "1 connection" : `${connections} connections`}</span>
            </div>
          </div>
        </div>
      </div>

      <Card className={cn("py-3.5", noAuth ? "border-[rgba(48,209,88,0.3)]" : "border-[rgba(100,210,255,0.3)]")}>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[9px]",
              noAuth ? "bg-[rgba(48,209,88,0.14)] text-[var(--green)]" : "bg-[rgba(100,210,255,0.15)] text-[var(--teal)]"
            )}
          >
            {noAuth ? <LockOpen size={14} /> : <Info size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            {noAuth && <div className="text-[12.5px] font-bold">No authentication required</div>}
            <p className={cn("text-[11.5px] text-[var(--text-2)]", noAuth && "mt-0.5")}>{data.authHint}</p>
          </div>
          {!noAuth && data.credentialUrl && (
            <a
              href={data.credentialUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[var(--accent)] hover:underline"
            >
              <ExternalLink size={12} /> Get API Key
            </a>
          )}
        </div>
      </Card>

      <Card className="space-y-4">
        {noAuth ? (
          <CardHeader title="Routing" icon={Cable} sub="Prebuilt — no accounts to manage" />
        ) : (
          <CardHeader title="Connections & Routing" icon={Cable} sub={`${data.accounts.length} account${data.accounts.length === 1 ? "" : "s"}`}>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {data.accounts.length > 0 && (
                <Button variant="secondary" size="sm" disabled={accountConnectionTest.isPending || data.models.length === 0} onClick={() => accountConnectionTest.testActive(data.accounts)}>
                  <FlaskConical size={13} /> Test all
                </Button>
              )}
              <Button size="sm" onClick={() => setAccountModal({ open: true, existing: null })}>
                <Plus size={14} /> New account
              </Button>
            </div>
          </CardHeader>
        )}

        <div className="grid grid-cols-1 gap-2.5 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 sm:grid-cols-2">
          <div>
            <Label>Strategy</Label>
            <Select
              ariaLabel="Strategy"
              className="mt-1 w-full"
              value={routing.strategy}
              onChange={(v) => {
                const next = { ...routing, strategy: v as RoutingConfig["strategy"] };
                setRouting(next);
                routingMutation.mutate(next);
              }}
              options={[
                { value: "priority", label: "Priority (failover)" },
                { value: "round-robin", label: "Round-robin" },
              ]}
            />
          </div>
          <div>
            <Label>Proxy mode</Label>
            <Select
              ariaLabel="Proxy mode"
              className="mt-1 w-full"
              value={routing.proxyMode}
              onChange={(v) => {
                const next = { ...routing, proxyMode: v as RoutingConfig["proxyMode"] };
                setRouting(next);
                routingMutation.mutate(next);
              }}
              options={[
                { value: "direct", label: "Direct" },
                { value: "proxy-pool", label: "Proxy pool" },
                { value: "mixed", label: "Mixed" },
              ]}
            />
          </div>
        </div>

        {routing.proxyMode !== "direct" && (
          <p className="text-[10.5px] text-[var(--orange)]">Proxy pools arrive in M6 — set the pool id via API for now.</p>
        )}

        {!noAuth && selectedAccounts.size > 0 && (
          <div className="flex flex-wrap items-center gap-2.5 rounded-xl bg-[var(--accent-soft)] px-3.5 py-2.5">
            <span className="text-[11.5px] font-semibold text-[var(--accent)]">
              {selectedAccounts.size} selected
            </span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={bulkActiveMutation.isPending}
                onClick={() => bulkActiveMutation.mutate({ ids: [...selectedAccounts], active: true })}
              >
                Enable
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={bulkActiveMutation.isPending}
                onClick={() => bulkActiveMutation.mutate({ ids: [...selectedAccounts], active: false })}
              >
                Disable
              </Button>
              <Button variant="ghost" size="sm" className="text-[#ff453a]" onClick={() => setBulkDeleteConfirm(true)}>
                <Trash2 size={12} /> Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedAccounts(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {!noAuth && (
          <div className="overflow-hidden rounded-xl border border-[var(--inner-border)]">
            {data.accounts.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--text-3)]">No connections yet — add one to start routing requests.</div>
            ) : (
              <div className="max-h-[21rem] overflow-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 z-10 bg-[var(--hover)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                    <tr>
                      <th className="w-9 px-2 py-2.5">
                        <input
                          type="checkbox"
                          aria-label="Select all accounts"
                          className="h-3.5 w-3.5 accent-[var(--accent)]"
                          checked={data.accounts.every((account) => selectedAccounts.has(account.id))}
                          ref={(element) => {
                            if (!element) return;
                            element.indeterminate = selectedAccounts.size > 0 && !data.accounts.every((account) => selectedAccounts.has(account.id));
                          }}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelectedAccounts((previous) => {
                              const next = new Set(previous);
                              for (const account of data.accounts) {
                                if (checked) next.add(account.id);
                                else next.delete(account.id);
                              }
                              return next;
                            });
                          }}
                        />
                      </th>
                      <th className="px-2 py-2.5">
                        <button className="inline-flex items-center gap-1" onClick={() => toggleAccountSort("name")}>Account <ArrowUpDown size={11} /></button>
                      </th>
                      <th className="hidden px-2 py-2.5 sm:table-cell">Credential</th>
                      <th className="hidden px-2 py-2.5 md:table-cell">
                        <button className="inline-flex items-center gap-1" onClick={() => toggleAccountSort("priority")}>Priority <ArrowUpDown size={11} /></button>
                      </th>
                      <th className="px-2 py-2.5">
                        <button className="inline-flex items-center gap-1" onClick={() => toggleAccountSort("status")}>Status <ArrowUpDown size={11} /></button>
                      </th>
                      <th className="px-2 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAccounts.map((account) => (
                      <tr key={account.id} className="border-t border-[var(--inner-border)] transition-colors hover:bg-[var(--hover)]">
                        <td className="px-2 py-2.5 align-top">
                          <input
                            type="checkbox"
                            aria-label={`Select ${account.name}`}
                            className="h-3.5 w-3.5 accent-[var(--accent)]"
                            checked={selectedAccounts.has(account.id)}
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedAccounts((previous) => {
                                const next = new Set(previous);
                                if (checked) next.add(account.id);
                                else next.delete(account.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="min-w-0 px-2 py-2.5 align-top">
                          <div className="max-w-28 truncate text-xs font-semibold sm:max-w-none">{account.name}</div>
                          <code className="mt-0.5 block max-w-28 truncate font-mono text-[10px] text-[var(--text-3)] sm:hidden">{account.credentialHint}</code>
                        </td>
                        <td className="hidden px-2 py-2.5 font-mono text-[10px] text-[var(--text-3)] sm:table-cell">{account.credentialHint}</td>
                        <td className="hidden px-2 py-2.5 text-[11px] text-[var(--text-2)] md:table-cell">{account.priority}</td>
                        <td className="px-2 py-2.5 align-top">
                          <div className="flex flex-wrap gap-1">
                            {renderAccountStatus(account)}
                            <span className="hidden sm:contents"><Badge tone="info">{account.credentialKind}</Badge>{account.useDirect && <Badge tone="info">direct</Badge>}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <div className="flex justify-end gap-0.5 whitespace-nowrap">
                            <Button variant="ghost" size="sm" title="Test connection" aria-label={`Test ${account.name}`} disabled={accountConnectionTest.isPending || data.models.length === 0} onClick={() => accountConnectionTest.testAccount(account)}>
                              <FlaskConical size={12} /> Test
                            </Button>
                            <Button variant="ghost" size="sm" title="Copy credential" aria-label={`Copy ${account.name}'s credential`} disabled={credentialCopy.isPending} onClick={() => credentialCopy.mutate(account)}>
                              <Copy size={12} /> Copy
                            </Button>
                            <Button variant="ghost" size="sm" title="Edit connection" aria-label={`Edit ${account.name}`} onClick={() => setAccountModal({ open: true, existing: account })}>
                              <Pencil size={12} /> Edit
                            </Button>
                            <Button variant="ghost" size="sm" className="text-[#ff453a]" title="Delete connection" aria-label={`Delete ${account.name}`} onClick={() => setDeleteTarget(account)}>
                              <Trash2 size={12} /> Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold">Available Models</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{data.models.filter((model) => model.enabled).length} active · {data.models.filter((model) => !model.enabled).length} disabled</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="secondary" size="sm" disabled={modelMutation.isPending} onClick={() => modelMutation.mutate({ path: "/enabled", body: { enabled: false } })}>
                <PowerOff size={13} /> Disable all
              </Button>
              {data.modelManagement.canFetchModels && (
                <Button variant="secondary" size="sm" disabled={modelMutation.isPending} onClick={() => modelMutation.mutate({ path: "/import" })}>
                  <RefreshCw size={13} /> Fetch models
                </Button>
              )}
            </div>
          </div>
          {data.modelManagement.canAddModels && (
            <div className="mt-3 flex items-center gap-1.5">
              <Input className="h-8 min-w-0 flex-1" value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} placeholder="Model ID" aria-label="Model ID" />
              <Button variant="secondary" size="sm" disabled={modelMutation.isPending || !manualModelId.trim()} onClick={() => modelMutation.mutate({ path: "", body: { modelId: manualModelId.trim() } })}>Add model</Button>
            </div>
          )}
        </div>
        {activeModels.length === 0 && disabledModels.length === 0 ? (
          <Card className="py-8 text-center text-xs text-[var(--text-3)]">No models published by this provider yet.</Card>
        ) : (
          <>
            {activeModels.length > 0 && <div className="grid grid-cols-2 gap-1.5 sm:gap-2 lg:grid-cols-3 xl:grid-cols-4">{activeModels.map(renderModel)}</div>}
            {disabledModels.length > 0 && (
              <section className="mt-5 border-t border-[var(--inner-border)] pt-4">
                <div className="mb-2 text-xs font-semibold text-[var(--text-2)]">Disabled models · {disabledModels.length}</div>
                <div className="grid grid-cols-2 gap-1.5 sm:gap-2 lg:grid-cols-3 xl:grid-cols-4">{disabledModels.map((model, index) => renderModel(model, activeModels.length + index))}</div>
              </section>
            )}
          </>
        )}
      </Card>


      {accountModal.open && (
        <AccountModal
          providerId={data.id}
          expectedKind={expectedKind}
          existing={accountModal.existing}
          accounts={data.accounts}
          onClose={() => setAccountModal({ open: false, existing: null })}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        title="Delete account"
        message={`Delete "${deleteTarget?.name}"? Stored credentials are removed permanently.`}
        danger
        confirmLabel="Delete"
      />
      <ConfirmDialog
        open={bulkDeleteConfirm}
        onClose={() => setBulkDeleteConfirm(false)}
        onConfirm={() => bulkDeleteMutation.mutate([...selectedAccounts])}
        title="Delete accounts"
        message={`Delete ${selectedAccounts.size} account${selectedAccounts.size === 1 ? "" : "s"}? Stored credentials are removed permanently.`}
        danger
        confirmLabel="Delete"
      />
    </div>
  );
}

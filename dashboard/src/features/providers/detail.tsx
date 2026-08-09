/**
 * Provider detail — model catalog + test modal (account/manual), routing form,
 * accounts CRUD (REQ-11, REQ-20).
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpDown, Bot, Brain, Cable, CheckCircle2, Copy, Download, ExternalLink, Eye, FileJson, FileUp, FlaskConical, Globe, Info, Loader2, LockOpen, Pencil, Plus, PowerOff, RefreshCw, Trash2, Users, AlertTriangle } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "../../lib/toast";
import { ApiError, apiGet, apiPost, apiPatch, apiDelete } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { cn } from "../../lib/cn";
import { extractCredentialFromPaste } from "../../lib/credentialExtract";
import { formatDuration, formatTokens } from "../../lib/format";
import {
  formatAccountHealthAccessibleStatus,
  formatAccountHealthStatus,
  formatHealthAccessibleStatus,
  formatRouteHealthStatus,
  healthPollingInterval,
  type AccountHealthSnapshot,
  type RouteHealthSnapshot,
} from "../../lib/account-health";
import { staggerClass } from "../../lib/motion";
import { displayAccountHint as displayHint, formatModelPricing, type ModelPricing } from "./formatters";
import { useWindowedList } from "../../hooks/use-windowed-list";
import { Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";

import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";

interface ModelMetadataResponse {
  context?: { inputTokens?: number | null; outputTokens?: number | null };
  categories?: readonly ("vision" | "text" | "reasoning")[];
  pricing?: { inputPerMillion?: number | null; outputPerMillion?: number | null };
  source?: "catalog" | "custom";
}
interface ModelEntry {
  id: string;
  reasoning?: boolean;
  vision?: boolean;
  websearch?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled: boolean;
  source: "built-in" | "manual" | "imported";
  pricing?: ModelPricing;
}

interface AccountEntry {
  id: string;
  provider: string;
  name: string;
  credentialKind: string;
  credentialHint: string;
  active: boolean;
  health: (AccountHealthSnapshot & { occurredAt?: string | null; lastRefreshAt?: string | null }) | null;
}

interface RouteState {
  id?: string;
  routeId?: string;
  name?: string;
  label?: string;
  health?: RouteHealthSnapshot | null;
  status?: RouteHealthSnapshot["status"];
  failureKind?: string | null;
  statusCode?: number | null;
  sanitizedMessage?: string | null;
  retryAt?: string | null;
}

interface RouteSwitchEvent {
  scope?: "account" | "proxy";
  previousRouteId?: string | null;
  replacementRouteId?: string | null;
  reason?: string;
  occurredAt?: string;
}

interface ProviderDetail {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "oauth" | "api-key";
  supportsOAuth: boolean;
  credentialKinds: string[];
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
  accounts: AccountEntry[];
  routing: { strategy: "priority" | "round-robin"; stickyLimit: number; useStickyLimit: boolean; proxyRouteId: string | null };
  health?: RouteHealthSnapshot | null;
  proxyHealth?: RouteHealthSnapshot | null;
  failedRoute?: RouteState | null;
  replacementRoute?: RouteState | null;
  switchEvent?: RouteSwitchEvent | null;
}

interface TestResult {
  resolveOk: boolean;
  latencyMs: number;
  /** Stream mode: time to first visible text (TFFT). */
  firstVisibleTextMs?: number;
  ok: boolean;
  sample?: string;
  error?: string;
  /** The model name returned by the provider (from response body `model` field). */
  returnedModel?: string;
  /** Whether the returned model name matches the requested model (true = real model, false = likely aliased). */
  aliased?: boolean;
}

interface ProviderDetailResponse {
  id: string;
  name: string;
  protocol: string;
  credentialKind: "api_key" | "oauth" | "session" | "manual" | "none";
  credentialKinds?: Array<"api_key" | "oauth" | "session" | "manual" | "none">;
  credentialUrl?: string | null;
  enabled: boolean;
  models: Array<{ modelId: string; displayName?: string; enabled: boolean; source?: "built-in" | "manual" | "imported"; metadata?: ModelMetadataResponse }>;
  modelManagement?: { canAddModels: boolean; canFetchModels: boolean };
  accounts: Array<AccountEntry & { providerId?: string }>;
  routing?: { strategy?: "priority" | "round-robin"; stickyLimit?: number; useStickyLimit?: boolean; proxyRouteId?: string | null };
}

function normalizeProviderDetail(response: ProviderDetailResponse): ProviderDetail {
  const authKind = response.credentialKind === "api_key"
    ? "api-key"
    : response.credentialKind === "manual" ? "none" : response.credentialKind;
  const supportsOAuth = response.credentialKinds?.includes("oauth") ?? response.credentialKind === "oauth";
  return {
    id: response.id,
    name: response.name,
    icon: response.id,
    authKind,
    supportsOAuth,
    credentialKinds: response.credentialKinds ?? [response.credentialKind],
    authHint: authKind === "none" ? "No authentication required" : supportsOAuth ? "Use an API key or connect an OAuth account." : "Add an account credential to route requests.",
    credentialUrl: response.credentialUrl ?? null,
    // Providers such as Kimchi expose both OAuth and API-key accounts. API
    // keys are the explicit, non-refreshing default; OAuth remains selectable
    // in the account form instead of being inferred for every pasted token.
    accountCredentialKind: response.credentialKinds?.includes("api_key") ? "api_key" : response.credentialKind,
    prefix: response.id,
    models: response.models.map((model) => {
      const metadata = model.metadata;
      const categories = metadata?.categories ?? [];
      const contextWindow = metadata?.context?.inputTokens ?? null;
      const maxOutputTokens = metadata?.context?.outputTokens ?? null;
      const input = metadata?.pricing?.inputPerMillion ?? null;
      const output = metadata?.pricing?.outputPerMillion ?? null;
      return {
        id: model.modelId,
        enabled: model.enabled,
        source: model.source ?? (metadata?.source === "custom" ? "manual" : "built-in"),
        reasoning: categories.includes("reasoning"),
        vision: categories.includes("vision"),
        contextWindow: contextWindow ?? undefined,
        maxOutputTokens: maxOutputTokens ?? undefined,
        pricing: input !== null && output !== null ? { input, output } : undefined,
      };
    }),
    modelManagement: response.modelManagement ?? { canAddModels: true, canFetchModels: true },
    status: response.enabled && (authKind === "none" || response.accounts.some((account) => account.active)) ? "ok" : "warn",
    usageToday: null,
    accounts: response.accounts.map((account) => ({ ...account, provider: account.providerId ?? response.id })),
    routing: {
      strategy: response.routing?.strategy === "round-robin" ? "round-robin" : "priority",
      stickyLimit: response.routing?.stickyLimit ?? 1,
      useStickyLimit: response.routing?.useStickyLimit ?? false,
      proxyRouteId: response.routing?.proxyRouteId ?? null,
    },
    health: null,
    proxyHealth: null,
    failedRoute: null,
    replacementRoute: null,
    switchEvent: null,
  };
}

type AccountTestStatus =
  | { state: "testing" }
  | { state: "passed"; latencyMs: number }
  | { state: "failed"; error: string };

type AccountSortKey = "name" | "status";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return "request failed";
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-[var(--kbd-bg)] px-1 py-0.5 font-mono text-[11px]">{part.slice(1, -1)}</code>;
    return part;
  });
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

// ── Model test ───────────────────────────────────────────────────────────
/**
 * Runs a model test and reports the result through a rich toast — icon +
 * model name + TFFT + END timing, real-model line, and sample text. No
 * inline card, no modal.
 */
function selectAccountTestModel(providerId: string, models: ModelEntry[]): ModelEntry | undefined {
  const preferredId = providerId === "codex" ? "gpt-5.4-mini" : null;
  return (preferredId ? models.find((model) => model.id === preferredId) : undefined) ?? models[0];
}

async function probeModel(provider: string, model: string, credentialMode: "auto" | "account", accountId?: string): Promise<TestResult> {
  const result = await apiPost<{ ok: boolean; latencyMs: number; firstVisibleTextMs?: number; sample?: string; error?: { message?: string }; returnedModel?: string }>("/model-studio/probe", {
    provider,
    model,
    credentialMode,
    ...(accountId ? { accountId } : {}),
  });
  const returned = result.returnedModel?.trim();
  let aliased: boolean | undefined;
  if (returned) {
    const returnedLast = returned.split("/").pop()?.toLowerCase();
    const requestedLast = model.split("/").pop()?.toLowerCase();
    aliased = returnedLast !== requestedLast;
  }
  return {
    resolveOk: true,
    ok: result.ok,
    latencyMs: result.latencyMs,
    firstVisibleTextMs: result.firstVisibleTextMs,
    sample: result.sample,
    error: result.error?.message,
    returnedModel: returned,
    aliased,
  };
}

function useAccountConnectionTest(providerId: string, models: ModelEntry[], onStatus: (accountId: string, status: AccountTestStatus) => void) {
  const queryClient = useQueryClient();
  const testMutation = useMutation({
    mutationFn: async (accounts: AccountEntry[]) => {
      const model = selectAccountTestModel(providerId, models);
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
            const result = await probeModel(providerId, model.id, "account", account.id);
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
      // Backend probe already called recordSuccess/recordFailure per account,
      // so invalidate health + accounts queries to surface the fresh status.
      void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(providerId) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(providerId) });
      const failed = results.filter(({ result }) => !result.ok);
      if (failed.length === 0) {
        toast.success(`${results.length} connection${results.length === 1 ? "" : "s"} passed`, { description: results.map(({ account, result }) => `${account.name} · ${formatDuration(result.latencyMs)}`).join("\n") });
        return;
      }
      toast.error(`${failed.length} connection${failed.length === 1 ? "" : "s"} failed`, { description: failed.map(({ account, result }) => `${account.name} · ${result.error ?? "No response"}`).join("\n") });
    },
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => {
      // Always refresh health after test completes — even on error, backend
      // may have recorded failures that should surface in the account table.
      void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(providerId) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(providerId) });
    },
  });

  return {
    testAccount: (account: AccountEntry) => testMutation.mutate([account]),
    testActive: (accounts: AccountEntry[]) => testMutation.mutate(accounts),
    isPending: testMutation.isPending,
  };
}

function useModelTest(
  providerId: string,
  authKind: "none" | "session" | "oauth" | "api-key",
  accounts: AccountEntry[],
  onAddAccount: () => void,
) {
  const activeAccounts = accounts.filter((a) => a.active);
  const needsAccount = authKind !== "none" && activeAccounts.length === 0;
  const [modelResults, setModelResults] = useState<Record<string, { ok: boolean; latencyMs: number; error?: string }>>({});

  const testMutation = useMutation({
    mutationFn: async (modelIds: string[]) => {
      // Fire all probes concurrently — each resolves independently.
      const results = await Promise.all(
        modelIds.map((modelId) => probeModel(providerId, modelId, "auto").catch((err) => ({
          resolveOk: false,
          ok: false,
          latencyMs: 0,
          error: errorMessage(err),
        }) as TestResult)),
      );
      return modelIds.map((modelId, i) => ({ modelId, result: results[i]! }));
    },
    onSuccess: (entries) => {
      const updates: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
      for (const { modelId, result } of entries) {
        updates[modelId] = { ok: result.ok, latencyMs: result.latencyMs, error: result.ok ? undefined : (result.error ?? "Unknown error") };
        if (!result.ok) {
          toast.error(`${modelId} failed`, { description: result.error ?? "Unknown error." });
          continue;
        }
        const returned = result.returnedModel?.trim();
        const modelLine = returned
          ? result.aliased
            ? `Likely aliased \`${returned}\``
            : `Real model \`${returned}\``
          : null;
        toast.success(`${modelId} · END ${formatDuration(result.latencyMs)}`, {
          description: (
            <div className="max-w-sm space-y-0.5">
              {modelLine && <p className="text-[10px] text-[var(--text-3)]">{renderInlineMarkdown(modelLine)}</p>}
              {result.sample && (
                <p className="whitespace-pre-wrap text-[11px] leading-5 text-[var(--text-2)]">{renderInlineMarkdown(result.sample)}</p>
              )}
              {!result.sample && <p className="text-[10px] text-[var(--text-3)]">No sample text in the response.</p>}
            </div>
          ),
        });
      }
      setModelResults((prev) => ({ ...prev, ...updates }));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const pendingModelIds = testMutation.isPending ? new Set(testMutation.variables ?? []) : new Set<string>();

  const run = (modelId: string) => {
    if (needsAccount) {
      toast.error("No stored accounts", {
        description: "This provider needs a real credential to test against.",
        action: { label: "Add account", onClick: onAddAccount },
      });
      return;
    }
    testMutation.mutate([modelId]);
  };

  const runMultiple = (modelIds: string[]) => {
    if (needsAccount) {
      toast.error("No stored accounts", {
        description: "This provider needs a real credential to test against.",
        action: { label: "Add account", onClick: onAddAccount },
      });
      return;
    }
    if (modelIds.length === 0) return;
    testMutation.mutate(modelIds);
  };

  const isTesting = (modelId: string) => pendingModelIds.has(modelId);

  return { run, runMultiple, isTesting, pendingModelIds, isPending: testMutation.isPending, getResult: (modelId: string) => modelResults[modelId] ?? null };
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
  "codex": "Paste the full OMP OAuth JSON export containing access, refresh, expires, accountId, and email — it is converted automatically.",
  "claude": "Paste the full OMP OAuth JSON export containing access, refresh, expires, accountId, and email — it is converted automatically.",
  "grok-cli": "Paste a Grok CLI OAuth export containing access, refresh, expires, userId, and email — it is converted automatically.",
  "antigravity": "Paste an Antigravity OAuth export containing access, refresh, expires, projectId, and email — it is converted automatically.",
  cline: "Paste a Cline OAuth export containing accessToken, refreshToken, and expiresAt — it is converted automatically.",
  cloudflare: "Cloudflare requires JSON credentials: { \"apiKey\": \"…\", \"accountId\": \"32-character account ID\" }.",
};

// ── Account create/edit modal ────────────────────────────────────────────
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBulkOAuthJson(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste at least one OAuth JSON object.");

  const parseValue = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value.filter(isJsonRecord);
    if (!isJsonRecord(value)) return [];
    for (const key of ["accounts", "credentials", "items"]) {
      if (Array.isArray(value[key])) return value[key].filter(isJsonRecord);
    }
    return [value];
  };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const records = parseValue(parsed);
    if (records.length > 0) return records;
  } catch {
    const records = trimmed.split(/\r?\n/).flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parseValue(parsed);
      } catch {
        return [];
      }
    });
    if (records.length > 0) return records;
  }
  throw new Error("OAuth import expects a JSON object, array, or newline-delimited JSON objects.");
}

function bulkOAuthAccountName(record: Record<string, unknown>, index: number, used: Set<string>): string {
  const preferred = [record.name, record.email, record.accountId, record.id].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
  const base = preferred ?? `codex-${index + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} (${suffix++})`;
  used.add(name);
  return name;
}

function BulkOAuthModal({
  providerId,
  accounts,
  onClose,
}: {
  providerId: string;
  accounts: AccountEntry[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      const records = parseBulkOAuthJson(text);
      const used = new Set(accounts.map((account) => account.name));
      let imported = 0;
      const failed: string[] = [];
      for (const [index, record] of records.entries()) {
        const name = bulkOAuthAccountName(record, index, used);
        try {
          await apiPost(`/providers/${providerId}/accounts`, {
            name,
            credentialKind: "oauth",
            credential: JSON.stringify(record),
          });
          imported++;
        } catch (error) {
          failed.push(`${name}: ${errorMessage(error)}`);
        }
      }
      return { imported, failed };
    },
    onSuccess: ({ imported, failed }) => {
      if (imported > 0) {
        toast.success(`${imported} Codex connection${imported === 1 ? "" : "s"} imported`);
        void queryClient.invalidateQueries({ queryKey: qk.provider.detail(providerId) });
        void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(providerId) });
        void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} connection${failed.length === 1 ? "" : "s"} skipped`, { description: failed.slice(0, 3).join("\n") });
      }
      if (failed.length === 0) onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open onClose={onClose} title="Add Codex connections" wide>
      <div className="space-y-3">
        <div>
          <p className="text-sm text-[var(--text-2)]">Paste a JSON object, a JSON array, or newline-delimited OAuth exports. Each valid entry becomes a separate OpenAI Codex account.</p>
          <p className="mt-1 text-[11px] text-[var(--text-3)]">Supported fields: access/accessToken, refresh/refreshToken, expires/expiresAt, accountId, and email.</p>
        </div>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={'[{"access":"…","refresh":"…","expires":1735689600000,"accountId":"…","email":"…"}]'}
          aria-label="Codex OAuth JSON exports"
          className="min-h-48 w-full resize-y rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5 font-mono text-[11px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          spellCheck={false}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!text.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            <FileJson size={14} /> {mutation.isPending ? "Importing…" : "Import connections"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AccountModal({
  providerId,
  expectedKind,
  credentialKinds,
  existing,
  accounts,
  initialKind,
  onClose,
}: {
  providerId: string;
  expectedKind: string;
  credentialKinds?: string[];
  existing: AccountEntry | null;
  initialKind?: string;
  accounts: AccountEntry[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  // Auto-generate next account name for new accounts.
  const defaultName = existing
    ? existing.name
    : (() => {
        const prefix = providerId === "opencodeft" ? "opencode" : providerId;
        const existingNames = new Set(accounts.map((a) => a.name));
        let n = accounts.length + 1;
        while (existingNames.has(`${prefix}-${n}`)) n++;
        return `${prefix}-${n}`;
      })();
  const [name, setName] = useState(defaultName);
  const [selectedKind, setSelectedKind] = useState(existing?.credentialKind ?? initialKind ?? expectedKind);
  const [credential, setCredential] = useState("");
  const [cloudflareAccountId, setCloudflareAccountId] = useState("");
  const pasteHint = CREDENTIAL_PASTE_HINTS[providerId];
  // A whole-textarea JSON blob (Cursor/Devin export rows, etc.) is one
  // credential, not newline-separated batch entries — extract it as a
  // single value instead of splitting on "\n". Plain multi-line paste (one
  // token per line) is unaffected since each line individually won't parse
  // as a JSON object.
  const trimmedCredential = credential.trim();
  const detectedCredential = extractCredentialFromPaste(trimmedCredential);
  const credentials = selectedKind === "oauth"
    ? (trimmedCredential ? [trimmedCredential] : [])
    : providerId === "cloudflare"
      ? (trimmedCredential && cloudflareAccountId.trim() ? [JSON.stringify({ apiKey: detectedCredential.extracted ? detectedCredential.value : trimmedCredential, accountId: cloudflareAccountId.trim() })] : [])
      : detectedCredential.extracted
        ? [detectedCredential.value]
        : credential.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);

  const mutation = useMutation({
    mutationFn: async (): Promise<number> => {
      if (existing) {
        const patch: Record<string, unknown> = { name: name.trim(), credentialKind: selectedKind };
        if (credential) patch.credential = selectedKind === "oauth" ? credential.trim() : extractCredentialFromPaste(credential).value;
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
        credentialKind: selectedKind,
        credential: value,
      })));
      return credentials.length;
    },
    onSuccess: (created) => {
      toast.success(existing ? "Account updated" : `${created} connection${created === 1 ? "" : "s"} added`);
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(providerId) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
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
        {credentialKinds && credentialKinds.length > 1 && (
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[var(--hover)] p-1 text-xs">
            {credentialKinds.map((kind) => (
              <button key={kind} type="button" className={cn("rounded-lg px-2 py-2", selectedKind === kind && "bg-[var(--card)] font-semibold")} onClick={() => setSelectedKind(kind)}>
                {kind === "oauth" ? "OAuth" : kind === "api_key" ? "API key" : kind}
              </button>
            ))}
          </div>
        )}
        <div>
          <Label>Credential ({selectedKind}){existing ? " — leave empty to keep current" : " — one per line for batch add, or paste a JSON export"}</Label>
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
                placeholder={`Paste ${selectedKind} values, one per line…`}
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
                  const extracted = selectedKind === "oauth" ? null : extractCredentialFromPaste(text);
                  if (extracted?.extracted) {
                    toast.success(`Detected credential from JSON (${extracted.source ?? "data"})`);
                  } else {
                    toast.success(selectedKind === "oauth" ? "Pasted OAuth account JSON" : "Pasted from clipboard");
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
        {providerId === "cloudflare" && selectedKind === "api_key" && !existing && (
          <div>
            <Label>Cloudflare Account ID</Label>
            <Input value={cloudflareAccountId} onChange={(event) => setCloudflareAccountId(event.target.value)} placeholder="32-character account ID" maxLength={32} />
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => mutation.mutate()}>{existing ? "Save" : credentials.length > 1 ? `Add ${credentials.length}` : "Add connection"}</Button>
        </div>
      </div>
    </Dialog>
  );
}

interface OAuthLoginStart {
  sessionId: string;
  provider: string;
  status: string;
  authorizationUrl: string;
  redirectUri: string;
  instructions: string;
  expiresAt: number;
  userCode?: string | null;
  verificationUri?: string | null;
  intervalSeconds?: number | null;
}

interface OAuthLoginStatus {
  sessionId: string;
  provider: string;
  status: string;
  accountId?: string;
  errorKind?: string;
  errorMessage?: string;
  expiresAt: number;
}

function KiroOAuthDialog({ onClose, onConnected, accountName }: { onClose: () => void; onConnected: () => void; accountName: string }) {
  const [method, setMethod] = useState<"builder-id" | "idc" | "import">("builder-id");
  const [name, setName] = useState(accountName);
  const [refreshToken, setRefreshToken] = useState("");
  const [session, setSession] = useState<{ sessionId: string; verificationUri: string; userCode: string; intervalSeconds: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [polling, setPolling] = useState(false);

  // Auto-poll device flow session status
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        setPolling(true);
        const status = await apiGet<OAuthLoginStatus>(`/oauth/sessions/${session.sessionId}`);
        if (stopped) return;
        if (status.status === "completed") {
          toast.success("Kiro account connected");
          onConnected();
          return;
        }
        if (status.status === "failed" || status.status === "expired" || status.status === "cancelled") {
          setMessage(status.errorMessage ?? status.errorKind ?? "Authorization failed");
          setSession(null);
          return;
        }
        // Still waiting — schedule next poll
        timer = window.setTimeout(() => void poll(), (session.intervalSeconds ?? 5) * 1000);
      } catch (error) {
        if (!stopped) {
          setMessage(errorMessage(error));
          setSession(null);
        }
      } finally {
        if (!stopped) setPolling(false);
      }
    };
    // Start first poll after the interval
    let timer: number | undefined = window.setTimeout(() => void poll(), session.intervalSeconds * 1000);
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [session, onConnected]);

  const start = async () => {
    setBusy(true); setMessage("");
    try {
      if (method === "import") {
        if (!refreshToken.trim()) { setMessage("Refresh token is required."); setBusy(false); return; }
        const result = await apiPost<OAuthLoginStart>("/providers/kiro/oauth/start", { name: name.trim() || accountName });
        // Complete immediately with the imported refresh token as the callback value
        const completed = await apiPost<OAuthLoginStatus>(`/oauth/sessions/${result.sessionId}/complete`, { value: refreshToken.trim() });
        if (completed.status === "completed") {
          toast.success("Kiro account imported");
          onConnected();
        } else {
          setMessage(completed.errorMessage ?? "Import failed");
        }
        return;
      }
      const result = await apiPost<OAuthLoginStart>("/providers/kiro/oauth/start", { name: name.trim() || accountName });
      setSession({
        sessionId: result.sessionId,
        verificationUri: result.verificationUri ?? result.authorizationUrl,
        userCode: result.userCode ?? "",
        intervalSeconds: result.intervalSeconds ?? 5,
      });
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };

  const cancelSession = async () => {
    if (session) {
      try { await apiPost(`/oauth/sessions/${session.sessionId}/cancel`, {}); } catch { /* best-effort */ }
    }
    onClose();
  };

  return <Dialog open onClose={cancelSession} title="Connect Kiro OAuth" footer={<div className="flex w-full justify-between gap-2"><Button variant="ghost" onClick={cancelSession}>Cancel</Button><Button disabled={busy || !name.trim() || (method === "import" && !refreshToken.trim()) || Boolean(session)} onClick={() => void start()}>{busy ? "Starting…" : method === "import" ? "Import token" : "Start authorization"}</Button></div>}>
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--hover)] p-1 text-xs"><button className={cn("rounded-lg px-2 py-2", method === "builder-id" && "bg-[var(--card)] font-semibold")} onClick={() => setMethod("builder-id")}>Builder ID</button><button className={cn("rounded-lg px-2 py-2", method === "idc" && "bg-[var(--card)] font-semibold")} onClick={() => setMethod("idc")}>IAM Identity</button><button className={cn("rounded-lg px-2 py-2", method === "import" && "bg-[var(--card)] font-semibold")} onClick={() => setMethod("import")}>Import</button></div>
      <Label>Account name<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Kiro account" /></Label>
      {method === "import" ? <Label>Refresh token<textarea value={refreshToken} onChange={(event) => setRefreshToken(event.target.value)} className="min-h-24 w-full rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 font-mono text-xs" placeholder="Paste Kiro refresh token" /></Label> : session ? <div className="space-y-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3"><div className="flex items-center gap-2 text-sm font-semibold"><Loader2 size={14} className={cn("shrink-0", polling ? "animate-spin text-[var(--accent)]" : "text-[var(--text-3)]")} aria-hidden="true" />{polling ? "Polling for authorization…" : "Waiting for authorization…"}</div><a className="break-all text-xs text-[var(--accent)] hover:underline" href={session.verificationUri} target="_blank" rel="noreferrer">{session.verificationUri}</a><div className="font-mono text-xl tracking-widest">{session.userCode}</div><p className="text-xs text-[var(--text-3)]">Open the verification URL above and enter the device code, then wait — this dialog auto-checks for authorization.</p></div> : null}
      {message && <div className="rounded-xl border border-[var(--red)]/40 px-3 py-2 text-xs text-[var(--red)]">{message}</div>}
    </div>
  </Dialog>;
}

function OAuthConnectDialog({
  providerName,
  session,
  status,
  callbackValue,
  onCallbackValueChange,
  onComplete,
  onCancel,
  completing,
}: {
  providerName: string;
  session: OAuthLoginStart;
  status: OAuthLoginStatus | null;
  callbackValue: string;
  onCallbackValueChange: (value: string) => void;
  onComplete: () => void;
  onCancel: () => void;
  completing: boolean;
}) {
  const waiting = status?.status === "waiting-for-user" || status?.status === "exchanging-code";
  const isDeviceFlow = Boolean(session.userCode && session.verificationUri);
  const hasCallback = Boolean(callbackValue.trim());
  const statusMessage = status?.status === "exchanging-code"
    ? "Finishing authorization…"
    : status?.status === "completed"
      ? "Connected successfully"
      : status && status.status !== "waiting-for-user"
        ? status.errorMessage ?? status.errorKind ?? "Authorization failed"
        : isDeviceFlow
          ? "Polling for authorization — complete the device flow in your browser…"
          : "Waiting for popup authorization…";
  const statusTone = status?.status === "completed"
    ? "text-[var(--green)]"
    : status && !waiting
      ? "text-[var(--red)]"
      : "text-[var(--text-2)]";

  const pasteCallback = async () => {
    try {
      if (!navigator.clipboard) throw new Error("unavailable");
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        toast.error("Clipboard is empty");
        return;
      }
      onCallbackValueChange(value);
      toast.success("Pasted redirect URL");
    } catch {
      toast.error("Clipboard unavailable on this origin");
    }
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Connect ${providerName}`}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {!isDeviceFlow && (
            <Button disabled={!hasCallback || completing || !waiting} onClick={onComplete}>
              {completing ? "Checking…" : "Connect"}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2.5 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3">
          {status?.status === "completed" ? (
            <CheckCircle2 size={18} className="shrink-0 text-[var(--green)]" aria-hidden="true" />
          ) : (
            <Loader2 size={18} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden="true" />
          )}
          <span className={cn("text-sm font-medium", statusTone)}>{statusMessage}</span>
        </div>

        {!isDeviceFlow && (
          <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-3)] before:h-px before:flex-1 before:bg-[var(--inner-border)] after:h-px after:flex-1 after:bg-[var(--inner-border)]">
            Or paste callback URL manually
          </div>
        )}

        <section className="space-y-2">
          <div className="text-sm font-semibold">Step 1: Open this URL in your browser</div>
          <div className="flex min-w-0 gap-2">
            <a
              href={session.authorizationUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate rounded-xl bg-[var(--hover)] px-3 py-2.5 font-mono text-[11px] text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title={session.authorizationUrl}
            >
              {session.authorizationUrl}
            </a>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              aria-label="Copy OAuth authorization URL"
              onClick={() => void copyToClipboard(session.authorizationUrl)}
            >
              <Copy size={14} aria-hidden="true" /> Copy
            </Button>
          </div>
          <p className="text-[11px] leading-4 text-[var(--text-3)]">{session.instructions}</p>
          {isDeviceFlow && <div className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Device code</div><div className="mt-1 font-mono text-xl tracking-[0.2em] text-[var(--text-1)]">{session.userCode}</div><a href={session.verificationUri ?? session.authorizationUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[11px] text-[var(--accent)] hover:underline">{session.verificationUri ?? session.authorizationUrl}</a></div>}
        </section>

        {!isDeviceFlow && (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">Step 2: Paste the callback URL here</div>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void pasteCallback()}>Paste</Button>
            </div>
            <p className="text-[11px] leading-4 text-[var(--text-3)]">After authorization, copy the full URL from your browser.</p>
            <textarea
              value={callbackValue}
              onChange={(event) => onCallbackValueChange(event.target.value)}
              placeholder={`${session.redirectUri}?code=…`}
              name="oauth-redirect-url"
              autoComplete="off"
              aria-label="Final redirect URL or authorization code"
              className="min-h-16 max-h-24 w-full resize-y rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5 font-mono text-[11px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              spellCheck={false}
            />
          </section>
        )}

        {status && status.status !== "waiting-for-user" && status.status !== "completed" && (
          <div className="rounded-xl border border-[var(--red)]/40 bg-[var(--red)]/5 px-3 py-2 text-xs text-[var(--red)]">
            {statusMessage}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Add Custom Model modal ─────────────────────────────────────────────
function AddModelModal({
  providerId,
  prefix,
  onAdded,
  onClose,
}: {
  providerId: string;
  prefix: string;
  onAdded: () => void;
  onClose: () => void;
}) {
  const [modelId, setModelId] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "passed" | "failed">("idle");
  const [testError, setTestError] = useState("");
  const testMutation = useMutation({
    mutationFn: (id: string) => apiPost<{ ok: boolean; error?: { message?: string } }>("/model-studio/probe", { provider: providerId, model: id, credentialMode: "auto" }),
    onMutate: () => { setTestState("testing"); setTestError(""); },
    onSuccess: (result) => {
      if (result.ok) {
        setTestState("passed");
        return;
      }
      setTestState("failed");
      setTestError(result.error?.message ?? "Model probe failed");
    },
    onError: (err) => { setTestState("failed"); setTestError(errorMessage(err)); },
  });
  const addMutation = useMutation({
    mutationFn: (id: string) => apiPost(`/providers/${providerId}/models`, { modelId: id }),
    onSuccess: () => { toast.success("Custom model added"); onAdded(); onClose(); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const trimmed = modelId.trim();
  const qualified = trimmed.length > 0 ? `${prefix}/${trimmed}` : "";

  return (
    <Dialog open onClose={onClose} title="Add Custom Model" footer={
      <div className="flex w-full justify-between gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={addMutation.isPending || trimmed.length === 0} onClick={() => addMutation.mutate(trimmed)}>
          {addMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add Model
        </Button>
      </div>
    }>
      <div className="space-y-3">
        <div>
          <Label>Model ID</Label>
          <div className="flex gap-1.5">
            <Input
              autoFocus
              className="flex-1 font-mono text-xs"
              placeholder="e.g. claude-opus-4-5"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); setTestState("idle"); setTestError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && trimmed.length > 0) testMutation.mutate(trimmed); }}
            />
            <Button variant="secondary" size="sm" disabled={testMutation.isPending || trimmed.length === 0} onClick={() => testMutation.mutate(trimmed)}>
              {testState === "testing" ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test
            </Button>
          </div>
          {qualified.length > 0 && <div className="mt-1 text-[10px] text-[var(--text-3)]">Sent to provider as: <span className="font-mono">{qualified}</span></div>}
        </div>
        {testState === "passed" && <div className="rounded-xl border border-[var(--green)]/40 bg-[var(--green)]/5 px-3 py-2 text-xs text-[var(--green)]">Model test passed — ready to add.</div>}
        {testState === "failed" && <div className="rounded-xl border border-[var(--red)]/40 bg-[var(--red)]/5 px-3 py-2 text-xs text-[var(--red)]">{testError || "Model test failed."}</div>}
      </div>
    </Dialog>
  );
}

function routeHealthSnapshot(route: RouteState): RouteHealthSnapshot | null {
  if (route.health) return route.health;
  if (!route.status) return null;
  return {
    status: route.status,
    failureKind: route.failureKind ?? null,
    statusCode: route.statusCode ?? null,
    sanitizedMessage: route.sanitizedMessage ?? null,
    retryAt: route.retryAt ?? null,
  };
}

function routeLabel(route: RouteState): string {
  const label = route.label ?? route.name ?? route.routeId ?? route.id ?? "unknown route";
  return label.length <= 96 ? label : `${label.slice(0, 95)}…`;
}

function RouteHealthNotice({ title, route, tone }: { title: string; route: RouteState; tone: "failed" | "replacement" }) {
  const health = routeHealthSnapshot(route);
  const status = formatRouteHealthStatus({ health });
  const accessibleStatus = formatHealthAccessibleStatus(health) ?? "No health details";
  const label = routeLabel(route);
  return (
    <div className={cn(
      "rounded-xl border px-3 py-2.5",
      tone === "failed" ? "border-[var(--red)]/35 bg-[var(--red)]/5" : "border-[var(--green)]/35 bg-[var(--green)]/5",
    )}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{title}</div>
      <div className="mt-1 truncate text-xs font-semibold text-[var(--text-1)]">{label}</div>
      <div
        className={cn("mt-0.5 truncate text-[10px]", tone === "failed" ? "text-[var(--red)]" : "text-[var(--green)]")}
        title={accessibleStatus}
        aria-label={`${title} health: ${accessibleStatus}`}
      >
        {status ?? "No health details"}
      </div>
    </div>
  );
}

function RouteSwitchNotice({ event }: { event: RouteSwitchEvent }) {
  const previous = event.previousRouteId ? event.previousRouteId.slice(0, 96) : "unknown route";
  const replacement = event.replacementRouteId ? event.replacementRouteId.slice(0, 96) : "no replacement";
  return (
    <div className="rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2.5 text-[10px] text-[var(--text-2)]" role="status">
      <div className="font-semibold text-[var(--accent)]">Route replaced</div>
      <div className="mt-1 break-words">{previous} → {replacement}</div>
      {event.reason && <div className="mt-0.5 break-words text-[var(--text-3)]">Reason: {event.reason.slice(0, 160)}</div>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [accountModal, setAccountModal] = useState<{ open: boolean; existing: AccountEntry | null; initialKind?: string }>({ open: false, existing: null });
  const location = useLocation();
  const handledActionRef = useRef<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [accountTestStatus, setAccountTestStatus] = useState<Record<string, AccountTestStatus>>({});
  const [accountSort, setAccountSort] = useState<{ key: AccountSortKey; direction: "asc" | "desc" }>({ key: "name", direction: "asc" });
  const [oauthSession, setOauthSession] = useState<OAuthLoginStart | null>(null);
  const [oauthCallbackValue, setOauthCallbackValue] = useState("");
  const [bulkOAuthModal, setBulkOAuthModal] = useState(false);
  const [kiroOAuthModal, setKiroOAuthModal] = useState(false);
  const [deleteAccountConfirm, setDeleteAccountConfirm] = useState<{ open: boolean; account: AccountEntry | null }>({ open: false, account: null });
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [deleteFetchedConfirmOpen, setDeleteFetchedConfirmOpen] = useState(false);
  const [addModelModalOpen, setAddModelModalOpen] = useState(false);
  const oauthPopupRef = useRef<Window | null>(null);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const oauthStartMutation = useMutation({
    mutationFn: () => apiPost<OAuthLoginStart>(`/providers/${id}/oauth/start`, { name: `${data?.name ?? id} ${(data?.accounts.length ?? 0) + 1}` }),
    onSuccess: (session) => {
      setOauthSession(session);
      oauthPopupRef.current = window.open(session.authorizationUrl, "cartethyia-oauth", "popup,width=720,height=820");
      if (!oauthPopupRef.current) toast.error("Allow popups to start OAuth authorization, or use the authorization URL in the dialog.");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const oauthStatusQuery = useQuery({
    queryKey: qk.oauthLogin.session(oauthSession?.sessionId),
    queryFn: () => apiGet<OAuthLoginStatus>(`/oauth/sessions/${oauthSession?.sessionId}`),
    enabled: Boolean(oauthSession),
    refetchInterval: pageVisible ? 2_000 : false,
    refetchIntervalInBackground: false,
  });

  // Stop polling and auto-close on terminal states (completed, failed, expired).
  useEffect(() => {
    const status = oauthStatusQuery.data?.status;
    const accountId = oauthStatusQuery.data?.accountId;
    if (status === "completed" && accountId !== null) {
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      setOauthSession(null);
      setOauthCallbackValue("");
      return;
    }
    if (status === "failed" || status === "expired" || status === "cancelled") {
      if (status === "expired") toast.error("OAuth session expired — please try again.");
      else if (status === "failed") toast.error(oauthStatusQuery.data?.errorMessage ?? "OAuth authorization failed.");
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      setOauthSession(null);
      setOauthCallbackValue("");
    }
  }, [id, oauthStatusQuery.data?.status, oauthStatusQuery.data?.accountId, oauthStatusQuery.data?.errorMessage, queryClient]);
  const oauthCompleteMutation = useMutation({
    mutationFn: () => apiPost<OAuthLoginStatus>(`/oauth/sessions/${oauthSession?.sessionId}/complete`, { value: oauthCallbackValue }),
    onSuccess: (status) => {
      if (status.status === "completed") {
        toast.success("OAuth account connected");
        void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
        void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(id) });
        void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
        oauthPopupRef.current?.close();
        oauthPopupRef.current = null;
        setOauthSession(null);
        setOauthCallbackValue("");
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const oauthCancelMutation = useMutation({
    mutationFn: () => apiPost(`/oauth/sessions/${oauthSession?.sessionId}/cancel`, {}),
    onSuccess: () => {
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      setOauthSession(null);
      setOauthCallbackValue("");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // Clean up the OAuth popup if the user navigates away mid-authorization.
  useEffect(() => () => { oauthPopupRef.current?.close(); oauthPopupRef.current = null; }, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.provider.detail(id),
    queryFn: async () => normalizeProviderDetail(await apiGet<ProviderDetailResponse>(`/providers/${id}`)),
    enabled: Boolean(id),
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!data || !id) return;
    const params = new URLSearchParams(location.search);
    const action = params.get("action");
    if (action !== "oauth" && action !== "json") return;
    const actionKey = `${id}:${action}:${params.get("kind") ?? ""}`;
    if (handledActionRef.current === actionKey) return;
    handledActionRef.current = actionKey;
    if (action === "oauth" && data.supportsOAuth) {
      oauthStartMutation.mutate();
    } else if (action === "json") {
      const requestedKind = params.get("kind");
      const initialKind = requestedKind === "oauth" && data.credentialKinds.includes("oauth")
        ? "oauth"
        : requestedKind === "api_key" && data.credentialKinds.includes("api_key")
          ? "api_key"
          : data.accountCredentialKind;
      setAccountModal({ open: true, existing: null, initialKind });
    }
  }, [data, id, location.search]);

  const accountsQuery = useInfiniteQuery({
    queryKey: qk.provider.accounts(id),
    queryFn: async ({ pageParam }) => {
      const response = await apiGet<{ items: Array<AccountEntry & { providerId?: string }>; nextCursor?: string | null }>(`/providers/${id}/accounts?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`);
      return {
        items: response.items.map((account) => ({ ...account, provider: account.providerId ?? id ?? "" })),
        nextCursor: response.nextCursor ?? null,
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(id),
    refetchInterval: healthPollingInterval(pageVisible),
    refetchIntervalInBackground: false,
  });
  const pagedAccounts = useMemo(
    () => accountsQuery.data?.pages.flatMap((page) => page.items) ?? data?.accounts ?? [],
    [accountsQuery.data?.pages, data?.accounts],
  );

  // Hooks must run unconditionally on every render — hoisted above the
  // loading-state early return below so hook order never changes once data
  // arrives (previously caused "Rendered fewer hooks than expected").
  const sortedAccounts = useMemo(() => {
    const accountStatusRank = (account: AccountEntry): number => {
      const state = accountTestStatus[account.id]?.state;
      if (state === "testing") return 0;
      if (state === "passed") return 1;
      if (state === "failed") return 2;
      return account.active ? 3 : 4;
    };
    return [...pagedAccounts].sort((left, right) => {
      const comparison = accountSort.key === "name"
        ? left.name.localeCompare(right.name)
        : accountStatusRank(left) - accountStatusRank(right);
      return accountSort.direction === "asc" ? comparison : -comparison;
    });
  }, [accountSort, accountTestStatus, pagedAccounts]);
  const accountWindow = useWindowedList(sortedAccounts, 56);

  // Pre-compute selection state once per data/selection change, not per render.
  const allSelected = useMemo(() => (data?.accounts?.length === selectedAccounts.size && (data?.accounts ?? []).every((account) => selectedAccounts.has(account.id))) ?? false, [data?.accounts, selectedAccounts]);
  const someSelected = selectedAccounts.size > 0;

  // Auto-loads the next accounts page once the scroll position nears the
  // bottom of the (still row-virtualized) table container, instead of
  // requiring a manual "Load more" click.
  const handleAccountsScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      accountWindow.onScroll();
      const el = event.currentTarget;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (nearBottom && accountsQuery.hasNextPage && !accountsQuery.isFetchingNextPage) {
        void accountsQuery.fetchNextPage();
      }
    },
    [accountWindow, accountsQuery],
  );

  // Bulk actions reuse the single-account endpoints — there is no bulk
  // route on the server, so this fires the existing PATCH/DELETE per selected
  // id and settles once every request has resolved.
  const bulkActiveMutation = useMutation({
    mutationFn: ({ ids, active }: { ids: string[]; active: boolean }) =>
      Promise.all(ids.map((accountId) => apiPost(`/providers/${id}/accounts/${accountId}`, { active }))),
    onSuccess: (_res, { ids, active }) => {
      toast.success(`${ids.length} account${ids.length === 1 ? "" : "s"} ${active ? "enabled" : "disabled"}`);
      setSelectedAccounts(new Set());
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((accountId) => apiDelete<{ ok: boolean }>(`/providers/${id}/accounts/${accountId}`))),
    onSuccess: (_result, ids) => {
      toast.success(`Deleted ${ids.length} account${ids.length === 1 ? "" : "s"}`);
      setSelectedAccounts(new Set());
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.providers });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const deleteSelectedAccounts = () => {
    const ids = [...selectedAccounts];
    if (ids.length === 0 || bulkDeleteMutation.isPending) return;
    setBulkDeleteConfirmOpen(true);
  };

  const modelMutation = useMutation({
    mutationFn: ({ path, body, method = "POST" }: { path: string; body?: Record<string, unknown>; method?: "POST" | "PATCH" }) =>
      method === "PATCH"
        ? apiPatch(`/providers/${id}/models${path}`, body ?? {})
        : apiPost(`/providers/${id}/models${path}`, body ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.provider(id) });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const fetchCatalogMutation = useMutation({
    mutationFn: () => apiPost(`/providers/${id}/models/fetch`, {}),
    onSuccess: () => { toast.success("Provider registry catalog synced"); void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) }); void queryClient.invalidateQueries({ queryKey: qk.catalog.provider(id) }); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const deleteModelMutation = useMutation({
    mutationFn: (modelId: string) => apiDelete(`/providers/${id}/models/${encodeURIComponent(modelId)}`),
    onSuccess: () => { toast.success("Custom model removed"); void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) }); void queryClient.invalidateQueries({ queryKey: qk.catalog.provider(id) }); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const deleteFetchedModelsMutation = useMutation({
    mutationFn: (modelIds: string[]) => Promise.all(modelIds.map((modelId) => apiDelete<{ ok: boolean }>(`/providers/${id}/models/${encodeURIComponent(modelId)}`))),
    onSuccess: (_result, modelIds) => {
      toast.success(`Deleted ${modelIds.length} fetched model${modelIds.length === 1 ? "" : "s"}`);
      void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.provider(id) });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });


  // Declared unconditionally, ahead of the loading-state early return below
  // (rules of hooks) — falls back to safe empty values until `data` arrives.
  const { run: runTest, isTesting: checkTesting, getResult: getTestResult } = useModelTest(
    id ?? "",
    data?.authKind ?? "api-key",
    data?.accounts ?? [],
    () => setAccountModal({ open: true, existing: null }),
  );
  const updateAccountTestStatus = useCallback((accountId: string, status: AccountTestStatus) => {
    setAccountTestStatus((previous) => ({ ...previous, [accountId]: status }));
  }, []);
  const accountConnectionTest = useAccountConnectionTest(id ?? "", data?.models ?? [], updateAccountTestStatus);

  // (OAuth terminal-state handling is in the useEffect above the status query.)

  if (!id) return null;

  // `!data` alone can't distinguish "still loading" from "the fetch failed" -
  // without this branch a failed request left the skeleton spinning forever
  // instead of ever showing an error.
  if (isError) {
    return (
      <Card className="text-center">
        <p className="py-8 text-sm text-[var(--text-2)]">Failed to load this provider.</p>
        <Button variant="secondary" onClick={() => refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (isLoading || !data) {
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
  const providerHealth = data.proxyHealth ?? data.health ?? null;
  const activeModels = data.models.filter((model) => model.enabled);
  const disabledModels = data.models.filter((model) => !model.enabled);
  const fetchedModels = data.models.filter((model) => model.source !== "built-in");
  const toggleAccountSort = (key: AccountSortKey) => {
    setAccountSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };
  const renderAccountStatus = (account: AccountEntry): string => {
    const testStatus = accountTestStatus[account.id];
    if (testStatus?.state === "testing") return "testing";
    if (testStatus?.state === "passed") return `passed · ${formatDuration(testStatus.latencyMs)}`;
    if (testStatus?.state === "failed") return `failed · ${testStatus.error}`;
    return formatAccountHealthStatus(account) ?? (account.active ? "active" : "disabled");
  };

  // ── Model management ──────────────────────────────────────────────────

  const renderModel = (model: ModelEntry, index: number) => {
    const qualified = `${data.prefix}/${model.id}`;
    const priceLabel = formatModelPricing(model.pricing);
    const testing = checkTesting(model.id);
    return (
      <div key={model.id} {...staggerClass(index)}>
        <Card className={cn("flex h-full min-h-[168px] flex-col gap-1.5 rounded-xl p-2.5 transition-transform duration-150 hover:-translate-y-0.5 sm:min-h-[180px]", !model.enabled && "opacity-65")}>
          {/* Header: icon + qualified name + copy — fixed height */}
          <div className="flex min-h-[34px] items-start gap-1.5">
            <Bot size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-3)]" />
            <div className="min-w-0 flex-1">
              <div className="break-all font-mono text-[10px] font-semibold leading-4 text-[var(--text-1)] sm:text-[11px]">{qualified}</div>
              <div className="mt-0.5 break-all text-[9px] leading-4 text-[var(--text-3)] sm:text-[10px]">{model.id}</div>
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" aria-label={`Copy ${qualified}`} onClick={() => void copyToClipboard(qualified)}>
              <Copy size={12} aria-hidden="true" />
            </Button>
          </div>
          {/* Capabilities — fixed height row, badges or placeholder */}
          <div className="flex min-h-[18px] flex-wrap items-center gap-1">
            {model.source !== "built-in" && <FileUp size={11} aria-hidden="true" className="text-[var(--text-3)]" />}
            {!model.reasoning && <span className="rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px] text-[var(--text-2)]">Standard</span>}
            {model.reasoning && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--accent)]">
                <Brain size={10} aria-hidden="true" /> Reasoning
              </span>
            )}
            {model.vision && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--teal)]">
                <Eye size={10} aria-hidden="true" /> Vision
              </span>
            )}
            {model.websearch && (
              <span className="inline-flex items-center gap-0.5 rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--green)]">
                <Globe size={10} aria-hidden="true" /> Web
              </span>
            )}
          </div>
          {/* Context + pricing — fixed two-line block */}
          <div className="flex-1 flex-col gap-1">
            <div className="min-h-[16px] text-[9px] leading-4 text-[var(--text-2)]">
              {model.contextWindow ? `${formatTokens(model.contextWindow)} context` : "Context unknown"}
              {model.contextWindow && model.maxOutputTokens ? " · " : null}
              {model.maxOutputTokens ? `${formatTokens(model.maxOutputTokens)} max out` : " · max out unknown"}
            </div>
            <div className="min-h-[16px] text-[9px] leading-4 text-[var(--text-2)]">{priceLabel ?? "Pricing unknown"}</div>
          </div>
          {/* Actions — pinned to bottom */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {model.enabled && (
              <Button variant="secondary" size="sm" className={cn("h-7 min-w-0 flex-1 gap-1 rounded-lg px-2 text-[10px] sm:h-7", getTestResult(model.id)?.ok && "bg-[var(--green-soft)] text-[var(--green)] hover:bg-[var(--green-soft)]", getTestResult(model.id) && !getTestResult(model.id)!.ok && "bg-[var(--red-soft)] text-[var(--red)] hover:bg-[var(--red-soft)]")} disabled={testing} onClick={() => runTest(model.id)}>
                {testing ? <Loader2 size={10} className="animate-spin" /> : getTestResult(model.id) ? (getTestResult(model.id)!.ok ? <CheckCircle2 size={10} aria-hidden="true" /> : <AlertTriangle size={10} aria-hidden="true" />) : <FlaskConical size={10} aria-hidden="true" />}
                <span className="truncate">{testing ? "Thinking…" : getTestResult(model.id) ? (getTestResult(model.id)!.ok ? `pass · ${formatDuration(getTestResult(model.id)!.latencyMs)}` : "fail") : "Test"}</span>
              </Button>
            )}
            <button
              type="button"
              disabled={modelMutation.isPending}
              onClick={() => modelMutation.mutate({ path: `/${encodeURIComponent(model.id)}`, method: "PATCH", body: { enabled: !model.enabled } })}
              title={model.enabled ? "Disable" : "Enable"}
              aria-label={model.enabled ? "Disable" : "Enable"}
              className={`inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-[10px] font-medium transition-colors ${model.enabled ? "border-transparent bg-[var(--red-soft)] text-[var(--red)] hover:bg-[var(--red-soft)] hover:brightness-95 dark:hover:brightness-125" : "border-transparent bg-[var(--green-soft)] text-[var(--green)] hover:bg-[var(--green-soft)] hover:brightness-95 dark:hover:brightness-125"}`}
            >
              {model.enabled ? <PowerOff size={10} aria-hidden="true" /> : <LockOpen size={10} aria-hidden="true" />} {model.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              disabled={modelMutation.isPending}
              onClick={() => {
                if (model.source === "built-in") {
                  modelMutation.mutate({ path: `/${encodeURIComponent(model.id)}`, method: "PATCH", body: { enabled: false } });
                } else {
                  deleteModelMutation.mutate(model.id);
                }
              }}
              title={model.source === "built-in" ? "Delete (disable)" : "Delete (remove)"}
              aria-label={`Delete ${model.id}`}
              className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-transparent px-2 text-[10px] font-medium text-[var(--red)] transition-colors hover:bg-[var(--red-soft)]"
            >
              <Trash2 size={10} aria-hidden="true" /> Delete
            </button>
          </div>
        </Card>
      </div>
    );
  };

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
          <ProviderIcon icon={data.icon} name={data.name} size={48} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{data.name}</h1>
              <button
                onClick={() => refetch()}
                disabled={isLoading}
                title="Refresh provider data"
                aria-label="Refresh"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
              >
                <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
              </button>
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

      {(providerHealth?.status !== "healthy" && providerHealth?.status !== "refreshing") || data.failedRoute || data.replacementRoute || data.switchEvent ? (
        <section className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Route health">
          {providerHealth && <RouteHealthNotice title="Proxy health" route={{ health: providerHealth }} tone="failed" />}
          {data.failedRoute && <RouteHealthNotice title="Failed route" route={data.failedRoute} tone="failed" />}
          {data.replacementRoute && <RouteHealthNotice title="Replacement route" route={data.replacementRoute} tone="replacement" />}
          {data.switchEvent && <RouteSwitchNotice event={data.switchEvent} />}
        </section>
      ) : null}

      <Card className="space-y-4">
        <CardHeader title="Accounts" icon={Cable} sub={`${data.accounts.length} account${data.accounts.length === 1 ? "" : "s"}`}>
          <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            {data.supportsOAuth && (
              <Button variant="secondary" className="h-8 min-w-0 px-2.5 text-[11px]" size="sm" disabled={oauthStartMutation.isPending} onClick={() => oauthStartMutation.mutate()}>
                <ExternalLink size={12} /> <span className="truncate">{oauthStartMutation.isPending ? "Starting…" : "Connect OAuth"}</span>
              </Button>
            )}
            <Button className="h-8 min-w-0 px-2.5 text-[11px]" size="sm" onClick={() => setAccountModal({ open: true, existing: null })}>
              <Plus size={13} /> <span className="truncate">New account</span>
            </Button>
          </div>
        </CardHeader>

        {/* Account summary stat boxes — only for providers that need auth */}
        {!noAuth && (
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-stretch">
            {/* Account counts */}
            <div className="flex min-w-[140px] flex-1 flex-col justify-center gap-2 rounded-[12px] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                <Users size={11} /> Accounts
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-base font-bold tabular-nums text-[var(--text-1)]">{data.accounts.length}</span>
                <span className="text-[9.5px] text-[var(--text-3)]">total</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
                  <span className="text-[9.5px] tabular-nums text-[var(--text-2)]">{data.accounts.filter((a) => a.active).length} active</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-3)]" />
                  <span className="text-[9.5px] tabular-nums text-[var(--text-2)]">{data.accounts.filter((a) => !a.active).length} disabled</span>
                </div>
              </div>
              {/* Stacked bar */}
              <div className="flex h-1 overflow-hidden rounded-full bg-[var(--track)]">
                <div className="bg-[var(--green)] transition-all duration-300" style={{ width: `${data.accounts.length > 0 ? (data.accounts.filter((a) => a.active).length / data.accounts.length) * 100 : 0}%` }} />
              </div>
            </div>
            {/* Health breakdown */}
            <div className="flex min-w-[140px] flex-1 flex-col justify-center gap-2 rounded-[12px] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5">
              {(() => {
                const active = data.accounts.filter((a) => a.active);
                const exhausted = active.filter((a) => a.health?.status === "cooling_down").length;
                const errors = active.filter((a) => a.health?.status === "error" || a.health?.status === "reauthentication-required").length;
                const healthy = active.filter((a) => !a.health || a.health?.status === "healthy" || a.health?.status === "refreshing").length;
                const totalIssues = exhausted + errors;
                return (
                  <>
                    <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                      <AlertTriangle size={11} /> Health
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-base font-bold tabular-nums text-[var(--text-1)]">{totalIssues > 0 ? totalIssues : "OK"}</span>
                      {totalIssues === 0 && <span className="text-[9.5px] text-[var(--green)]">all healthy</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {exhausted > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--orange)]" />
                          <span className="text-[9.5px] tabular-nums text-[var(--text-2)]">{exhausted} exh.</span>
                        </div>
                      )}
                      {errors > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--red)]" />
                          <span className="text-[9.5px] tabular-nums text-[var(--text-2)]">{errors} err.</span>
                        </div>
                      )}
                      {totalIssues === 0 && (
                        <div className="flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
                          <span className="text-[9.5px] tabular-nums text-[var(--text-2)]">{healthy} ok</span>
                        </div>
                      )}
                    </div>
                    {/* Stacked bar */}
                    <div className="flex h-1 overflow-hidden rounded-full bg-[var(--track)]">
                      {healthy > 0 && <div className="bg-[var(--green)] transition-all duration-300" style={{ width: `${(healthy / active.length) * 100}%` }} />}
                      {exhausted > 0 && <div className="bg-[var(--orange)] transition-all duration-300" style={{ width: `${(exhausted / active.length) * 100}%` }} />}
                      {errors > 0 && <div className="bg-[var(--red)] transition-all duration-300" style={{ width: `${(errors / active.length) * 100}%` }} />}
                    </div>
                  </>
                );
              })()}
            </div>
            {/* Warmup Test button — full-width on mobile, auto on desktop */}
            <div className="flex w-full items-center sm:w-auto sm:min-w-[120px]">
              <Button variant="secondary" size="sm" className="h-full w-full flex-col gap-0.5 rounded-[12px] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5 text-[var(--text-2)] hover:bg-[var(--active-pill)] hover:text-[var(--text-1)]" disabled={accountConnectionTest.isPending || data.accounts.length === 0 || data.models.length === 0} onClick={() => accountConnectionTest.testActive(data.accounts)}>
                {accountConnectionTest.isPending ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
                <span className="text-[9.5px] font-semibold">{accountConnectionTest.isPending ? "Testing…" : "Warmup Test"}</span>
                <span className="text-[8.5px] text-[var(--text-3)]">{data.accounts.filter((a) => a.active).length} active</span>
              </Button>
            </div>
          </div>
        )}

        {selectedAccounts.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--accent-soft)] px-3 py-2.5">
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
                className="h-8 px-2.5 text-[11px]"
                disabled={bulkActiveMutation.isPending || bulkDeleteMutation.isPending}
                onClick={() => bulkActiveMutation.mutate({ ids: [...selectedAccounts], active: false })}
              >
                Disable
              </Button>
              <Button
                variant="danger"
                size="sm"
                className="h-8 px-2.5 text-[11px]"
                disabled={bulkActiveMutation.isPending || bulkDeleteMutation.isPending}
                onClick={deleteSelectedAccounts}
              >
                <Trash2 size={12} /> Delete
              </Button>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-[11px]" onClick={() => setSelectedAccounts(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-[var(--inner-border)]">
          {data.accounts.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--text-3)]">No connections yet — add one to start routing requests.</div>
          ) : (
              <div ref={accountWindow.containerRef} onScroll={handleAccountsScroll} className="max-h-[21rem] overflow-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 z-10 bg-[var(--hover)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                    <tr>
                      <th className="w-8 px-1.5 py-2.5 sm:w-9 sm:px-2">
                        <input
                          type="checkbox"
                          aria-label="Select all accounts"
                          className="h-3.5 w-3.5 accent-[var(--accent)]"
                          checked={allSelected}
                          ref={(element) => {
                            if (!element) return;
                            element.indeterminate = someSelected && !allSelected;
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
                      <th className="w-auto px-1.5 py-2.5 text-right sm:px-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountWindow.topPadding > 0 && <tr aria-hidden="true" style={{ height: accountWindow.topPadding }}><td colSpan={5} /></tr>}
                    {accountWindow.visibleItems.map((account) => {
                      const accountStatus = renderAccountStatus(account);
                      const accessibleAccountStatus = formatAccountHealthAccessibleStatus(account) ?? accountStatus;
                      const hasHealthError = Boolean(formatAccountHealthStatus(account));
                      return (
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
                          <div className="max-w-48 truncate text-xs font-semibold sm:max-w-none">{displayHint(account.credentialHint, account.name)}</div>
                          {displayHint(account.credentialHint, account.name) !== account.name ? <div className="mt-0.5 max-w-48 truncate text-[10px] text-[var(--text-3)] sm:max-w-none">{account.name}</div> : null}
                          <div className={cn("mt-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-medium", hasHealthError || accountTestStatus[account.id]?.state === "failed" ? "bg-[var(--red-soft)] text-[var(--red)]" : accountTestStatus[account.id]?.state === "passed" ? "bg-[var(--green-soft)] text-[var(--green)]" : "bg-[var(--hover)] text-[var(--text-3)]")} title={accessibleAccountStatus} aria-label={`Account status: ${accessibleAccountStatus}`}>
                            {accountTestStatus[account.id]?.state === "passed" ? "passed" : accountTestStatus[account.id]?.state === "failed" ? "error" : accountStatus}
                          </div>
                        </td>
                        <td className="w-[104px] px-1.5 py-2.5 align-top sm:w-auto sm:px-2">
                          <div className="flex items-center justify-end gap-0.5 whitespace-nowrap sm:gap-1">
                            <Button variant="ghost" size="icon" className="size-6 sm:size-7" title="Test connection" aria-label={`Test ${account.name}`} disabled={accountConnectionTest.isPending || data.models.length === 0} onClick={() => accountConnectionTest.testAccount(account)}>
                              <FlaskConical size={13} />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-6 sm:size-7" title="Edit connection" aria-label={`Edit ${account.name}`} onClick={() => setAccountModal({ open: true, existing: account })}>
                              <Pencil size={13} />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-6 sm:size-7 text-[var(--red)]" title="Delete account" aria-label={`Delete ${account.name}`} onClick={() => setDeleteAccountConfirm({ open: true, account })}>
                              <Trash2 size={13} />
                            </Button>
                            <Switch checked={account.active} disabled={bulkActiveMutation.isPending} onChange={(active) => bulkActiveMutation.mutate({ ids: [account.id], active })} label={`${account.active ? "Disable" : "Enable"} ${account.name}`} />
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                    {accountWindow.bottomPadding > 0 && <tr aria-hidden="true" style={{ height: accountWindow.bottomPadding }}><td colSpan={7} /></tr>}
                  </tbody>
                </table>
                {accountsQuery.isFetchingNextPage && <div className="border-t border-[var(--inner-border)] p-2 text-center text-[11px] text-[var(--text-3)]">Loading more…</div>}
              </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="mb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold">Available Models</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--text-2)]">{data.models.filter((model) => model.enabled).length} active · {data.models.filter((model) => !model.enabled).length} disabled</div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {data.modelManagement.canAddModels && <Button variant="secondary" size="sm" onClick={() => setAddModelModalOpen(true)}>
                <Plus size={13} /> Add Model
              </Button>}
              {data.modelManagement.canFetchModels && <Button variant="secondary" size="sm" disabled={fetchCatalogMutation.isPending} onClick={() => fetchCatalogMutation.mutate()}>
                {fetchCatalogMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {fetchCatalogMutation.isPending ? "Fetching…" : "Fetch models"}
              </Button>}
              {fetchedModels.length > 0 && (
                <Button variant="ghost" size="sm" className="text-[var(--red)]" disabled={modelMutation.isPending || deleteFetchedModelsMutation.isPending} onClick={() => setDeleteFetchedConfirmOpen(true)}>
                  <Trash2 size={13} /> Delete fetched
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={modelMutation.isPending} onClick={() => modelMutation.mutate({ path: "/enabled", body: { enabled: false } })}>
                <PowerOff size={13} /> Disable all
              </Button>
            </div>
          </div>

        </div>
        {activeModels.length === 0 && disabledModels.length === 0 ? (
          <Card className="py-8 text-center text-xs text-[var(--text-3)]">No models published by this provider yet.</Card>
        ) : (
          <>
            {activeModels.length > 0 && <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{activeModels.map(renderModel)}</div>}
            {disabledModels.length > 0 && (
              <section className="mt-5 border-t border-[var(--inner-border)] pt-4">
                <div className="mb-2 text-xs font-semibold text-[var(--text-2)]">Disabled models · {disabledModels.length}</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{disabledModels.map((model, index) => renderModel(model, activeModels.length + index))}</div>
              </section>
            )}
          </>
        )}
      </Card>


      {accountModal.open && (
        <AccountModal
          providerId={data.id}
          expectedKind={expectedKind}
          credentialKinds={data.credentialKinds}
          existing={accountModal.existing}
          accounts={data.accounts}
          initialKind={accountModal.initialKind}
          onClose={() => setAccountModal({ open: false, existing: null })}
        />
      )}

      {kiroOAuthModal && data.id === "kiro" && (
        <KiroOAuthDialog
          accountName={`Kiro ${data.accounts.length + 1}`}
          onClose={() => setKiroOAuthModal(false)}
          onConnected={() => { setKiroOAuthModal(false); void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) }); void queryClient.invalidateQueries({ queryKey: qk.provider.accounts(id) });
      void queryClient.invalidateQueries({ queryKey: qk.catalog.providers }); }}
        />
      )}

      {bulkOAuthModal && data.id === "codex" && (
        <BulkOAuthModal
          providerId={data.id}
          accounts={data.accounts}
          onClose={() => setBulkOAuthModal(false)}
        />
      )}

      {addModelModalOpen && (
        <AddModelModal
          providerId={data.id}
          prefix={data.prefix}
          onAdded={() => { setAddModelModalOpen(false); void queryClient.invalidateQueries({ queryKey: qk.provider.detail(id) }); }}
          onClose={() => setAddModelModalOpen(false)}
        />
      )}

      {deleteAccountConfirm.open && deleteAccountConfirm.account && (
        <Dialog open onClose={() => setDeleteAccountConfirm({ open: false, account: null })} title="Delete Account" footer={
          <div className="flex w-full justify-between gap-2">
            <Button variant="ghost" onClick={() => setDeleteAccountConfirm({ open: false, account: null })}>Cancel</Button>
            <Button variant="danger" disabled={bulkDeleteMutation.isPending} onClick={() => {
              const account = deleteAccountConfirm.account;
              if (account) bulkDeleteMutation.mutate([account.id]);
              setDeleteAccountConfirm({ open: false, account: null });
            }}>
              {bulkDeleteMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
            </Button>
          </div>
        }>
          <p className="text-sm text-[var(--text-2)]">Are you sure you want to delete <strong>{deleteAccountConfirm.account.name}</strong>? This action cannot be undone.</p>
        </Dialog>
      )}

      {oauthSession && (
        <OAuthConnectDialog
          providerName={data.name}
          session={oauthSession}
          status={oauthStatusQuery.data ?? null}
          callbackValue={oauthCallbackValue}
          onCallbackValueChange={setOauthCallbackValue}
          onComplete={() => {
            if (oauthSession.userCode && oauthSession.verificationUri) void oauthStatusQuery.refetch();
            else oauthCompleteMutation.mutate();
          }}
          onCancel={() => oauthCancelMutation.mutate()}
          completing={oauthCompleteMutation.isPending || oauthCancelMutation.isPending}
        />
      )}

      <ConfirmDialog
        open={bulkDeleteConfirmOpen}
        onClose={() => setBulkDeleteConfirmOpen(false)}
        onConfirm={() => bulkDeleteMutation.mutate([...selectedAccounts])}
        title="Delete selected accounts?"
        message={`Delete ${selectedAccounts.size} selected account${selectedAccounts.size === 1 ? "" : "s"}? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
      <ConfirmDialog
        open={deleteFetchedConfirmOpen}
        onClose={() => setDeleteFetchedConfirmOpen(false)}
        onConfirm={() => deleteFetchedModelsMutation.mutate(fetchedModels.map((model) => model.id))}
        title="Delete fetched models?"
        message={`Delete ${fetchedModels.length} fetched model${fetchedModels.length === 1 ? "" : "s"}? Built-in models will stay.`}
        confirmLabel="Delete"
        danger
      />

    </div>
  );
}

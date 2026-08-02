/**
 * Provider detail — model catalog + test modal (account/manual), routing form,
 * accounts CRUD (REQ-11, REQ-20).
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpDown, Bot, Brain, Cable, CheckCircle2, Copy, ExternalLink, Eye, FileJson, FileUp, FlaskConical, Globe, Info, Loader2, LockOpen, Pencil, Plus, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ApiError, apiGet, apiPost, apiDelete } from "../../lib/api";
import { cn } from "../../lib/cn";
import { extractCredentialFromPaste } from "../../lib/credentialExtract";
import { formatDuration, formatTokens } from "../../lib/format";
import { staggerClass } from "../../lib/motion";
import { useWindowedList } from "../../hooks/use-windowed-list";
import { Skeleton } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";

import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Switch } from "../../components/ui/switch";

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
  websearch?: boolean;
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
  active: boolean;
  health: {
    status: "healthy" | "refreshing" | "error" | "disabled" | "reauthentication-required";
    errorKind: string | null;
    statusCode: number | null;
    sanitizedMessage: string | null;
    occurredAt: string | null;
    retryAt: string | null;
    lastRefreshAt: string | null;
  } | null;
}

interface ProviderDetail {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "oauth" | "api-key";
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

type AccountSortKey = "name" | "status";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return "request failed";
}

function formatRetryCountdown(retryAt: string | null): string {
  if (!retryAt) return "";
  const remaining = Math.max(0, new Date(retryAt).getTime() - Date.now());
  if (remaining <= 0) return "retrying soon";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes >= 60) return `retry in ${Math.ceil(minutes / 60)}h`;
  return `retry in ${minutes}m`;
}

function accountHealthLabel(account: AccountEntry): string | null {
  const health = account.health;
  if (!health || health.status === "healthy" || health.status === "refreshing") return null;
  if (health.status === "reauthentication-required") return "Re-authentication required";
  const statusLabel = health.status === "disabled"
    ? "Disabled"
    : health.statusCode === 502 ? "502 Bad Gateway" : health.statusCode ? `${health.statusCode} error` : health.errorKind ?? "Provider error";
  const retry = formatRetryCountdown(health.retryAt);
  return retry ? `${statusLabel} · ${retry}` : statusLabel;
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
function selectAccountTestModel(providerId: string, models: ModelEntry[]): ModelEntry | undefined {
  const preferredId = providerId === "openai-codex" ? "gpt-5.4-mini" : null;
  return (preferredId ? models.find((model) => model.id === preferredId) : undefined) ?? models[0];
}

function useAccountConnectionTest(providerId: string, models: ModelEntry[], onStatus: (accountId: string, status: AccountTestStatus) => void) {
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

function useModelTest(providerId: string, authKind: "none" | "session" | "oauth" | "api-key", accounts: AccountEntry[], onAddAccount: () => void) {
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
  "openai-codex": "Paste the full OMP OAuth JSON export containing access, refresh, expires, accountId, and email — it is converted automatically.",
  "anthropic-oauth": "Paste the full OMP OAuth JSON export containing access, refresh, expires, accountId, and email — it is converted automatically.",
  "grok-cli": "Paste a Grok CLI OAuth export containing access, refresh, expires, userId, and email — it is converted automatically.",
  "google-antigravity": "Paste an Antigravity OAuth export containing access, refresh, expires, projectId, and email — it is converted automatically.",
  cline: "Paste a Cline OAuth export containing accessToken, refreshToken, and expiresAt — it is converted automatically.",
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
  const base = preferred ?? `openai-codex-${index + 1}`;
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
        void queryClient.invalidateQueries({ queryKey: ["provider", providerId] });
        void queryClient.invalidateQueries({ queryKey: ["provider-accounts", providerId] });
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
  const credentials = expectedKind === "oauth"
    ? (trimmedCredential ? [trimmedCredential] : [])
    : detectedCredential.extracted
      ? [detectedCredential.value]
      : credential.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);

  const mutation = useMutation({
    mutationFn: async (): Promise<number> => {
      if (existing) {
        const patch: Record<string, unknown> = { name: name.trim() };
        if (credential) patch.credential = expectedKind === "oauth" ? credential.trim() : extractCredentialFromPaste(credential).value;
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
                  const extracted = expectedKind === "oauth" ? null : extractCredentialFromPaste(text);
                  if (extracted?.extracted) {
                    toast.success(`Detected credential from JSON (${extracted.source ?? "data"})`);
                  } else {
                    toast.success(expectedKind === "oauth" ? "Pasted OAuth account JSON" : "Pasted from clipboard");
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

interface OAuthLoginStart {
  sessionId: string;
  provider: string;
  status: string;
  authorizationUrl: string;
  redirectUri: string;
  instructions: string;
  expiresAt: number;
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
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await apiPost<{ status: string; intervalSeconds?: number; accountId?: string }>(`/providers/kiro/oauth/device/${session.sessionId}/poll`, {});
        if (stopped) return;
        if (result.status === "completed") { toast.success("Kiro OAuth account connected"); onConnected(); return; }
        window.setTimeout(() => void poll(), Math.max(2, result.intervalSeconds ?? session.intervalSeconds) * 1000);
      } catch (error) { if (!stopped) { setMessage(errorMessage(error)); setSession(null); } }
    };
    const timer = window.setTimeout(() => void poll(), session.intervalSeconds * 1000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [session, onConnected]);
  const start = async () => {
    setBusy(true); setMessage("");
    try {
      if (method === "import") {
        await apiPost(`/providers/kiro/oauth/import`, { name: name.trim(), refreshToken: refreshToken.trim() });
        toast.success("Kiro token imported"); onConnected(); return;
      }
      const result = await apiPost<{ sessionId: string; verificationUri: string; userCode: string; intervalSeconds: number }>(`/providers/kiro/oauth/device/start`, { name: name.trim(), method });
      setSession(result);
    } catch (error) { setMessage(errorMessage(error)); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title="Connect Kiro OAuth" footer={<div className="flex w-full justify-between gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy || !name.trim() || (method === "import" && !refreshToken.trim()) || Boolean(session)} onClick={() => void start()}>{busy ? "Starting…" : method === "import" ? "Import token" : "Start authorization"}</Button></div>}>
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-[var(--hover)] p-1 text-xs"><button className={cn("rounded-lg px-2 py-2", method === "builder-id" && "bg-[var(--card)] font-semibold")} onClick={() => setMethod("builder-id")}>Builder ID</button><button className={cn("rounded-lg px-2 py-2", method === "idc" && "bg-[var(--card)] font-semibold")} onClick={() => setMethod("idc")}>IAM Identity</button><button className={cn("rounded-lg px-2 py-2", method === "import" && "bg-[var(--card)] font-semibold")} onClick={() => setMethod("import")}>Import</button></div>
      <Label>Account name<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Kiro account" /></Label>
      {method === "import" ? <Label>Refresh token<textarea value={refreshToken} onChange={(event) => setRefreshToken(event.target.value)} className="min-h-24 w-full rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 font-mono text-xs" placeholder="Paste Kiro refresh token" /></Label> : session ? <div className="space-y-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3"><div className="text-sm font-semibold">Open Kiro authorization</div><a className="break-all text-xs text-[var(--accent)] hover:underline" href={session.verificationUri} target="_blank" rel="noreferrer">{session.verificationUri}</a><div className="font-mono text-xl tracking-widest">{session.userCode}</div><p className="text-xs text-[var(--text-3)]">Authorize in the browser. This dialog will connect automatically.</p></div> : <p className="text-xs leading-5 text-[var(--text-2)]">Kiro registers a public OAuth client and opens the AWS device authorization flow. No secret is stored in the browser.</p>}
      {message && <div className="rounded-xl border border-[var(--red)]/40 px-3 py-2 text-xs text-[var(--red)]">{message}</div>}
    </div>
  </Dialog>;
}

function OAuthConnectDialog({
  providerId,
  session,
  status,
  callbackValue,
  onCallbackValueChange,
  onComplete,
  onCancel,
  completing,
}: {
  providerId: string;
  session: OAuthLoginStart;
  status: OAuthLoginStatus | null;
  callbackValue: string;
  onCallbackValueChange: (value: string) => void;
  onComplete: () => void;
  onCancel: () => void;
  completing: boolean;
}) {
  const providerName = providerId === "openai-codex" ? "OpenAI Codex" : providerId === "anthropic-oauth" ? "Claude Code" : providerId === "grok-cli" ? "Grok CLI" : providerId === "google-antigravity" ? "Antigravity" : "Cline";
  const waiting = status?.status === "waiting-for-user" || status?.status === "exchanging-code";
  const isDeviceFlow = providerId === "grok-cli";
  const hasCallback = Boolean(callbackValue.trim());
  const statusMessage = status?.status === "exchanging-code"
    ? "Finishing authorization…"
    : status?.status === "completed"
      ? "Connected successfully"
      : status && status.status !== "waiting-for-user"
        ? status.errorMessage ?? status.errorKind ?? "Authorization failed"
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
          <Button disabled={(!isDeviceFlow && !hasCallback) || completing || !waiting} onClick={onComplete}>
            {completing ? "Checking…" : isDeviceFlow ? "Check authorization" : "Connect"}
          </Button>
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

        <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-3)] before:h-px before:flex-1 before:bg-[var(--inner-border)] after:h-px after:flex-1 after:bg-[var(--inner-border)]">
          Or paste callback URL manually
        </div>

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
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">{isDeviceFlow ? "Step 2: Check device authorization" : "Step 2: Paste the callback URL here"}</div>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void pasteCallback()}>Paste</Button>
          </div>
          <p className="text-[11px] leading-4 text-[var(--text-3)]">{isDeviceFlow ? "After authorization, press Check authorization until the account is connected." : "After authorization, copy the full URL from your browser."}</p>
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

        {status && status.status !== "waiting-for-user" && status.status !== "completed" && (
          <div className="rounded-xl border border-[var(--red)]/40 bg-[var(--red)]/5 px-3 py-2 text-xs text-[var(--red)]">
            {statusMessage}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [accountModal, setAccountModal] = useState<{ open: boolean; existing: AccountEntry | null }>({ open: false, existing: null });
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [manualModelId, setManualModelId] = useState("");
  const [accountTestStatus, setAccountTestStatus] = useState<Record<string, AccountTestStatus>>({});
  const [accountSort, setAccountSort] = useState<{ key: AccountSortKey; direction: "asc" | "desc" }>({ key: "name", direction: "asc" });
  const [oauthSession, setOauthSession] = useState<OAuthLoginStart | null>(null);
  const [oauthCallbackValue, setOauthCallbackValue] = useState("");
  const [bulkOAuthModal, setBulkOAuthModal] = useState(false);
  const [kiroOAuthModal, setKiroOAuthModal] = useState(false);
  const oauthPopupRef = useRef<Window | null>(null);

  const oauthStatusQuery = useQuery({
    queryKey: ["oauth-login", oauthSession?.sessionId],
    queryFn: () => apiGet<OAuthLoginStatus>(`/oauth/login/${oauthSession!.sessionId}`),
    enabled: Boolean(oauthSession),
    refetchInterval: 2_000,
  });
  const oauthStartMutation = useMutation({
    mutationFn: (name: string) => apiPost<OAuthLoginStart>(`/providers/${id}/oauth/login`, { name }),
    onSuccess: (session) => {
      setOauthSession(session);
      setOauthCallbackValue("");
      if (oauthPopupRef.current && !oauthPopupRef.current.closed) {
        oauthPopupRef.current.location.href = session.authorizationUrl;
        oauthPopupRef.current.focus();
      } else {
        oauthPopupRef.current = window.open(session.authorizationUrl, "cartethyia-oauth", "popup,width=520,height=720");
      }
    },
    onError: (error) => {
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      toast.error(errorMessage(error));
    },
  });
  const oauthCompleteMutation = useMutation({
    mutationFn: () => apiPost<OAuthLoginStatus>(`/oauth/login/${oauthSession!.sessionId}/complete`, { value: oauthCallbackValue.trim() }),
    onSuccess: (status) => {
      if (status.status === "completed") {
        toast.success("OAuth account connected");
        void queryClient.invalidateQueries({ queryKey: ["provider", id] });
        void queryClient.invalidateQueries({ queryKey: ["provider-accounts", id] });
        oauthPopupRef.current?.close();
        oauthPopupRef.current = null;
        setOauthSession(null);
        setOauthCallbackValue("");
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const startOAuth = () => {
    oauthPopupRef.current?.close();
    oauthPopupRef.current = window.open("about:blank", "cartethyia-oauth", "popup,width=520,height=720");
    oauthStartMutation.mutate(`${data?.name ?? id} ${(data?.accounts.length ?? 0) + 1}`);
  };

  const oauthCancelMutation = useMutation({
    mutationFn: () => apiPost(`/oauth/login/${oauthSession!.sessionId}/cancel`, {}),
    onSuccess: () => {
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      setOauthSession(null);
      setOauthCallbackValue("");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["provider", id],
    queryFn: () => apiGet<ProviderDetail>(`/providers/${id}`),
    enabled: Boolean(id),
  });

  const accountsQuery = useInfiniteQuery({
    queryKey: ["provider-accounts", id],
    queryFn: ({ pageParam }) => apiGet<{ items: AccountEntry[]; nextCursor: string | null }>(`/providers/${id}/accounts?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(id),
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
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
      void queryClient.invalidateQueries({ queryKey: ["provider-accounts", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((accountId) => apiDelete<{ ok: boolean }>(`/providers/${id}/accounts/${accountId}`))),
    onSuccess: (_result, ids) => {
      toast.success(`Deleted ${ids.length} account${ids.length === 1 ? "" : "s"}`);
      setSelectedAccounts(new Set());
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
      void queryClient.invalidateQueries({ queryKey: ["provider-accounts", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const deleteSelectedAccounts = () => {
    const ids = [...selectedAccounts];
    if (ids.length === 0 || bulkDeleteMutation.isPending) return;
    if (window.confirm(`Delete ${ids.length} selected account${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) bulkDeleteMutation.mutate(ids);
  };

  const modelMutation = useMutation({
    mutationFn: ({ path, body, method = "POST" }: { path: string; body?: Record<string, unknown>; method?: "POST" | "DELETE" }) =>
      method === "DELETE"
        ? apiDelete<{ ok: boolean }>(`/providers/${id}/models${path}`)
        : apiPost(`/providers/${id}/models${path}`, body ?? {}),
    onSuccess: (_result, { path }) => {
      if (path === "") setManualModelId("");
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const deleteFetchedModelsMutation = useMutation({
    mutationFn: (modelIds: string[]) => Promise.all(modelIds.map((modelId) => apiDelete<{ ok: boolean }>(`/providers/${id}/models/${encodeURIComponent(modelId)}`))),
    onSuccess: (_result, modelIds) => {
      toast.success(`Deleted ${modelIds.length} fetched model${modelIds.length === 1 ? "" : "s"}`);
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

  useEffect(() => {
    if (oauthStatusQuery.data?.status === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["provider", id] });
      void queryClient.invalidateQueries({ queryKey: ["provider-accounts", id] });
      oauthPopupRef.current?.close();
      oauthPopupRef.current = null;
      setOauthSession(null);
      setOauthCallbackValue("");
    }
  }, [id, oauthStatusQuery.data?.status, queryClient]);

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
  const activeModels = data.models.filter((model) => model.enabled);
  const disabledModels = data.models.filter((model) => !model.enabled);
  const fetchedModels = data.models.filter((model) => model.source !== "built-in");
  const toggleAccountSort = (key: AccountSortKey) => {
    setAccountSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };
  const renderAccountStatus = (account: AccountEntry): ReactNode => {
    const testStatus = accountTestStatus[account.id];
    if (testStatus?.state === "testing") return "testing";
    if (testStatus?.state === "passed") return `passed · ${formatDuration(testStatus.latencyMs)}`;
    if (testStatus?.state === "failed") return `failed · ${testStatus.error}`;
    return accountHealthLabel(account) ?? (account.active ? "active" : "disabled");
  };
  const renderModel = (model: ModelEntry, index: number) => {
    const qualified = `${data.prefix}/${model.id}`;
    const priceLabel = formatModelPricing(model.pricing);
    return (
      <div key={model.id} {...staggerClass(index)}>
        <Card className={cn("flex h-full flex-col gap-1.5 rounded-xl p-2.5 transition-transform duration-150 hover:-translate-y-0.5", !model.enabled && "opacity-65")}>
          <div className="flex min-w-0 items-start gap-1.5">
            <Bot size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-3)]" />
            <div className="min-w-0 flex-1">
              <div className="break-all font-mono text-[10px] font-semibold leading-4 text-[var(--text-1)] sm:text-[11px]">{qualified}</div>
              <div className="mt-0.5 break-all text-[9px] leading-4 text-[var(--text-3)] sm:text-[10px]">{model.id}</div>
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" aria-label={`Copy ${qualified}`} onClick={() => void copyToClipboard(qualified)}>
              <Copy size={12} aria-hidden="true" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {model.source !== "built-in" && <FileUp size={11} aria-hidden="true" className="text-[var(--text-3)]" />}
            <span className="inline-flex items-center gap-0.5 rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--accent)]">
              <Brain size={10} aria-hidden="true" /> Reasoning
            </span>
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
          {Boolean(model.contextWindow || model.maxOutputTokens) && (
            <div className="text-[9px] leading-4 text-[var(--text-2)]">
              {model.contextWindow ? `${formatTokens(model.contextWindow)} context` : null}
              {model.contextWindow && model.maxOutputTokens ? " · " : null}
              {model.maxOutputTokens ? `${formatTokens(model.maxOutputTokens)} max out` : null}
            </div>
          )}
          {priceLabel && <div className="text-[9px] leading-4 text-[var(--text-2)]">{priceLabel}</div>}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {model.enabled && (
              <Button variant="secondary" size="sm" className="h-7 min-w-0 flex-1 gap-1 rounded-lg px-2 text-[10px] sm:h-7" disabled={pendingModelId === model.id} onClick={() => runTest(model.id)}>
                {pendingModelId === model.id ? <Loader2 size={10} className="animate-spin" /> : <FlaskConical size={10} aria-hidden="true" />}
                <span className="truncate">{pendingModelId === model.id ? "Testing…" : "Test"}</span>
              </Button>
            )}
            <button
              type="button"
              disabled={modelMutation.isPending}
              onClick={() => modelMutation.mutate({ path: `/${encodeURIComponent(model.id)}/enabled`, body: { enabled: !model.enabled } })}
              title={model.enabled ? "Disable" : "Enable"}
              aria-label={model.enabled ? "Disable" : "Enable"}
              className={`inline-flex h-7 items-center justify-center gap-1 rounded-lg border px-2 text-[10px] font-medium transition-colors ${model.enabled ? "border-transparent bg-[rgba(255,69,58,0.13)] text-[#c95145] hover:bg-[rgba(255,69,58,0.22)] dark:text-[var(--red)] dark:hover:bg-[rgba(255,69,58,0.24)]" : "border-transparent bg-[rgba(48,209,88,0.14)] text-[#1fa84a] hover:bg-[rgba(48,209,88,0.22)] dark:text-[var(--green)] dark:hover:bg-[rgba(48,209,88,0.24)]"}`}
            >
              {model.enabled ? <PowerOff size={10} aria-hidden="true" /> : <LockOpen size={10} aria-hidden="true" />} {model.enabled ? "Disable" : "Enable"}
            </button>
            {model.source !== "built-in" && (
              <Button variant="ghost" size="sm" className="text-[var(--red)]" aria-label={`Delete ${qualified}`} disabled={modelMutation.isPending} onClick={() => modelMutation.mutate({ path: `/${encodeURIComponent(model.id)}`, method: "DELETE" })}>
                <Trash2 size={12} aria-hidden="true" />
              </Button>
            )}
          </div>
        </Card>
      </div>
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

      {!noAuth && (
      <Card className="space-y-4">
        <CardHeader title="Accounts" icon={Cable} sub={`${data.accounts.length} account${data.accounts.length === 1 ? "" : "s"}`}>
          <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            {data.accounts.length > 0 && (
              <Button variant="secondary" size="sm" className="h-8 min-w-0 px-2.5 text-[11px]" disabled={accountConnectionTest.isPending || data.models.length === 0} onClick={() => accountConnectionTest.testActive(data.accounts)}>
                <FlaskConical size={12} /> <span className="truncate">Test all</span>
              </Button>
            )}
            {data.authKind === "oauth" ? (
              <>
                <Button className="h-8 min-w-0 px-2.5 text-[11px]" size="sm" disabled={data.id === "kiro" ? false : oauthStartMutation.isPending} onClick={data.id === "kiro" ? () => setKiroOAuthModal(true) : startOAuth}>
                  <Plus size={13} /> <span className="truncate">{data.id === "kiro" ? "Connect OAuth" : oauthStartMutation.isPending ? "Starting…" : "Connect OAuth"}</span>
                </Button>
                {data.id === "openai-codex" && (
                  <Button className="col-span-2 h-8 min-w-0 px-2.5 text-[11px] sm:col-span-1" variant="secondary" size="sm" onClick={() => setBulkOAuthModal(true)}>
                    <FileJson size={13} /> <span className="truncate">Add bulk JSON</span>
                  </Button>
                )}
              </>
            ) : (
              <Button className="h-8 min-w-0 px-2.5 text-[11px]" size="sm" onClick={() => setAccountModal({ open: true, existing: null })}>
                <Plus size={13} /> <span className="truncate">New account</span>
              </Button>
            )}
          </div>
        </CardHeader>

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
                <table className="w-full table-fixed text-left text-[11px] sm:table-auto">
                  <thead className="sticky top-0 z-10 bg-[var(--hover)] text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                    <tr>
                      <th className="w-8 px-1.5 py-2.5 sm:w-9 sm:px-2">
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
                      <th className="w-[104px] px-1.5 py-2.5 text-right sm:w-auto sm:px-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountWindow.topPadding > 0 && <tr aria-hidden="true" style={{ height: accountWindow.topPadding }}><td colSpan={5} /></tr>}
                    {accountWindow.visibleItems.map((account) => (
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
                          <div className="max-w-48 truncate text-xs font-semibold sm:max-w-none">{account.name}</div>
                          <div className="mt-0.5 max-w-48 truncate font-mono text-[10px] text-[var(--text-2)] sm:max-w-none">{account.credentialHint}</div>
                          <div className={cn("mt-0.5 max-w-56 truncate text-[10px]", accountHealthLabel(account) || accountTestStatus[account.id]?.state === "failed" ? "text-[var(--red)]" : "text-[var(--text-3)]")} title={account.health?.sanitizedMessage ?? undefined}>{renderAccountStatus(account)}</div>
                        </td>
                        <td className="w-[104px] px-1.5 py-2.5 align-top sm:w-auto sm:px-2">
                          <div className="flex items-center justify-end gap-0.5 whitespace-nowrap sm:gap-1">
                            <Button variant="ghost" size="icon" className="size-6 sm:size-7" title="Test connection" aria-label={`Test ${account.name}`} disabled={accountConnectionTest.isPending || data.models.length === 0} onClick={() => accountConnectionTest.testAccount(account)}>
                              <FlaskConical size={13} />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-6 sm:size-7" title="Edit connection" aria-label={`Edit ${account.name}`} onClick={() => setAccountModal({ open: true, existing: account })}>
                              <Pencil size={13} />
                            </Button>
                            <Switch checked={account.active} disabled={bulkActiveMutation.isPending} onChange={(active) => bulkActiveMutation.mutate({ ids: [account.id], active })} label={`${account.active ? "Disable" : "Enable"} ${account.name}`} />
                          </div>
                        </td>
                      </tr>
                    ))}
                    {accountWindow.bottomPadding > 0 && <tr aria-hidden="true" style={{ height: accountWindow.bottomPadding }}><td colSpan={7} /></tr>}
                  </tbody>
                </table>
                {accountsQuery.isFetchingNextPage && <div className="border-t border-[var(--inner-border)] p-2 text-center text-[11px] text-[var(--text-3)]">Loading more…</div>}
              </div>
          )}
        </div>
      </Card>
      )}

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
              {fetchedModels.length > 0 && (
                <Button variant="ghost" size="sm" className="text-[var(--red)]" disabled={modelMutation.isPending || deleteFetchedModelsMutation.isPending} onClick={() => {
                  if (window.confirm(`Delete ${fetchedModels.length} fetched models? Built-in models will stay.`)) deleteFetchedModelsMutation.mutate(fetchedModels.map((model) => model.id));
                }}>
                  <Trash2 size={13} /> Delete fetched
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
          existing={accountModal.existing}
          accounts={data.accounts}
          onClose={() => setAccountModal({ open: false, existing: null })}
        />
      )}

      {kiroOAuthModal && data.id === "kiro" && (
        <KiroOAuthDialog
          accountName={`Kiro ${data.accounts.length + 1}`}
          onClose={() => setKiroOAuthModal(false)}
          onConnected={() => { setKiroOAuthModal(false); void queryClient.invalidateQueries({ queryKey: ["provider", id] }); void queryClient.invalidateQueries({ queryKey: ["provider-accounts", id] }); }}
        />
      )}

      {bulkOAuthModal && data.id === "openai-codex" && (
        <BulkOAuthModal
          providerId={data.id}
          accounts={data.accounts}
          onClose={() => setBulkOAuthModal(false)}
        />
      )}

      {oauthSession && (
        <OAuthConnectDialog
          providerId={data.id}
          session={oauthSession}
          status={oauthStatusQuery.data ?? null}
          callbackValue={oauthCallbackValue}
          onCallbackValueChange={setOauthCallbackValue}
          onComplete={() => oauthCompleteMutation.mutate()}
          onCancel={() => oauthCancelMutation.mutate()}
          completing={oauthCompleteMutation.isPending || oauthCancelMutation.isPending}
        />
      )}

    </div>
  );
}

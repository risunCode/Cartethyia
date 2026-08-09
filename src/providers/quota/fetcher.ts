import type { OAuthTokenRecord } from "../../application/auth/credentials";
import { claudeCodeOAuthBetas } from "../../providers/claude-code";


export interface ProviderQuotaWindow {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
}

export interface ProviderQuotaResult {
  readonly source: string;
  readonly plan: string | null;
  readonly windows: readonly ProviderQuotaWindow[];
  readonly error: string | null;
}

type FetchLike = typeof fetch;
const TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function isoDate(value: unknown): string | null {
  const n = number(value);
  if (n !== null) return new Date(n > 1_000_000_000_000 ? n : n * 1000).toISOString();
  const s = text(value);
  return s !== null && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
}
function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Quota request failed — provider did not return a valid response";
  return message.replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]").replace(/\s+/g, " ").slice(0, 240);
}
function quotaRecord(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? record(root.result) ?? record(root.usage) ?? root;
}
function clampPercent(value: number): number { return Math.min(100, Math.max(0, value)); }
function percentWindow(kind: string, label: string, used: number | null, resetsAt: string | null, usedValue?: number | null, limit?: number | null): ProviderQuotaWindow {
  const usedPercent = used === null ? null : clampPercent(used);
  return { kind, label, usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent), resetsAt, used: usedValue ?? null, limit: limit ?? null };
}
function authCredential(credential: string): Record<string, unknown> {
  const parsed = record(credential.startsWith("{") ? (() => { try { return JSON.parse(credential); } catch { return null; } })() : null);
  return parsed ?? { accessToken: credential };
}

function codexJwtAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = record(JSON.parse(atob((parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"))));
    const auth = record(payload?.["https://api.openai.com/auth"]);
    return text(auth?.chatgpt_account_id) ?? text(payload?.chatgpt_account_id) ?? text(payload?.account_id);
  } catch {
    return null;
  }
}
async function getJson(url: string, headers: Record<string, string>, fetcher: FetchLike, body?: unknown): Promise<unknown> {
  const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const textBody = await response.text();
  let parsed: unknown = null;
  try { parsed = textBody.length > 0 ? JSON.parse(textBody) : null; } catch { parsed = null; }
  if (!response.ok) {
    const envelope = record(parsed);
    const detail = text(envelope?.error) ?? text(envelope?.message) ?? `HTTP ${response.status}`;
    throw new Error(`Quota endpoint rejected request: ${detail}`);
  }
  const envelope = record(parsed);
  if (envelope?.success === false) throw new Error(text(envelope.error) ?? "Quota endpoint rejected the request.");
  return envelope?.success === true && "data" in envelope ? envelope.data : parsed;
}

function codex(body: unknown, fetchedAt: string): ProviderQuotaResult {
  const payload = quotaRecord(body); const rate = record(payload.rate_limit); const windows: ProviderQuotaWindow[] = [];
  const add = (raw: unknown, fallback: string) => { const value = record(raw); if (!value) return; const used = number(value.used_percent); const duration = number(value.limit_window_seconds); const reset = isoDate(value.reset_at) ?? (number(value.reset_after_seconds) !== null ? new Date(Date.parse(fetchedAt) + (number(value.reset_after_seconds) ?? 0) * 1000).toISOString() : null); if (used !== null || reset !== null) windows.push(percentWindow(duration !== null && duration <= 21_600 ? "session" : duration !== null && duration <= 86_400 ? "daily" : "weekly", duration !== null ? `${Math.max(1, Math.round(duration / 3600))} Hour` : fallback, used, reset)); };
  add(rate?.primary_window, "Primary"); add(rate?.secondary_window, "Secondary");
  return { source: "codex", plan: text(payload.plan_type), windows, error: null };
}
function anthropic(body: unknown): ProviderQuotaResult {
  const payload = record(body) ?? {}; const windows: ProviderQuotaWindow[] = [];
  const add = (key: string, label: string, kind: string) => { const value = record(payload[key]); if (value) windows.push(percentWindow(kind, label, number(value.utilization), isoDate(value.resets_at))); };
  add("five_hour", "5 Hour", "session"); add("seven_day", "7 Day", "weekly");
  return { source: "claude", plan: text(payload.plan_type) ?? text(payload.plan), windows, error: null };
}
function antigravity(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body); const models = record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota) ?? {}; const windows: ProviderQuotaWindow[] = [];
  for (const [modelId, raw] of Object.entries(models)) { const model = record(raw); if (!model) continue; const infos = [model.quotaInfo, model.dailyQuotaInfo, model.weeklyQuotaInfo, model.quotaInfos, model.dailyQuotaInfos, model.weeklyQuotaInfos].flatMap((value) => Array.isArray(value) ? value : [value]); for (const infoRaw of infos) { const info = record(infoRaw); if (!info) continue; const remaining = number(info.remainingFraction); const reset = isoDate(info.resetTime); if (remaining === null && reset === null) continue; const label = text(info.windowLabel) ?? text(info.windowId) ?? "Quota"; windows.push(percentWindow("other", `${modelId} · ${label}`, remaining === null ? 100 : (1 - clampPercent(remaining * 100)), reset)); } }
  return { source: "antigravity", plan: text(payload.tier) ?? text(payload.plan) ?? "Antigravity", windows, error: null };
}
function kiro(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body); const list = Array.isArray(payload.usageBreakdownList) ? payload.usageBreakdownList : []; const reset = isoDate(payload.nextDateReset ?? payload.resetDate); const windows: ProviderQuotaWindow[] = [];
  for (const raw of list) { const value = record(raw); if (!value) continue; const used = number(value.currentUsageWithPrecision); const limit = number(value.usageLimitWithPrecision); if (limit !== null && limit > 0) windows.push(percentWindow("monthly", text(value.resourceType) ?? "Kiro usage", used === null ? null : used / limit * 100, reset, used, limit)); }
  const subscription = record(payload.subscriptionInfo);
  return { source: "kiro", plan: text(subscription?.subscriptionTitle) ?? "Kiro", windows, error: windows.length === 0 ? "Kiro quota payload contained no usage windows." : null };
}

function grokBuild(body: unknown, userBody: unknown): ProviderQuotaResult {
  const billing = quotaRecord(body);
  const user = quotaRecord(userBody);
  const plan = text(billing.plan) ?? text(billing.subscriptionAccess) ?? text(user.subscriptionType) ?? "Grok Build";
  const total = number(billing.onDemandCap) ?? number(billing.totalCredits) ?? number(billing.creditLimit);
  const used = number(billing.onDemandUsed) ?? number(billing.usedCredits) ?? number(billing.creditUsed);
  const remaining = number(billing.remainingCredits) ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
  const reset = isoDate(billing.currentPeriodEnd) ?? isoDate(billing.periodEnd) ?? isoDate(billing.resetAt);
  const windows = remaining !== null || reset !== null
    ? [percentWindow("credit", "Grok Build credits", used !== null && total !== null && total > 0 ? used / total * 100 : null, reset, used, total)]
    : [];
  return { source: "grok-build", plan, windows, error: null };
}

async function cline(credential: string, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential); const access = text(fields.accessToken);
  if (!access) throw new Error("Cline credential has no access token.");
  const headers = { authorization: `Bearer ${access.startsWith("workos:") ? access : `workos:${access}`}` };
  const me = record(await getJson("https://api.cline.bot/api/v1/users/me", headers, fetcher));
  const userId = text(me?.id); if (!userId) throw new Error("Cline account response has no user id.");
  const [planRaw, balanceRaw] = await Promise.allSettled([getJson("https://api.cline.bot/api/v1/users/me/plan", headers, fetcher), getJson(`https://api.cline.bot/api/v1/users/${encodeURIComponent(userId)}/balance`, headers, fetcher)]);
  const plan = record(planRaw.status === "fulfilled" ? planRaw.value : null); const balance = record(balanceRaw.status === "fulfilled" ? balanceRaw.value : null); const amount = number(balance?.balance);
  const errors = [planRaw.status === "rejected" ? "plan" : null, balanceRaw.status === "rejected" ? "balance" : null].filter(Boolean);
  return { source: "cline", plan: text(plan?.plan && record(plan.plan)?.displayName) ?? text(plan?.displayName) ?? "Cline", windows: [{ kind: "credit", label: "Credits", usedPercent: null, remainingPercent: null, resetsAt: null, used: amount, limit: null }], error: errors.length > 0 ? `Failed to fetch ${errors.join(" and ")}.` : null };
}

export async function fetchProviderQuota(providerId: string, credential: string, token: OAuthTokenRecord | undefined, fetcher: FetchLike = fetch): Promise<ProviderQuotaResult> {
  const accessCredential = token?.accessToken ?? credential;
  const fetchedAt = new Date().toISOString();
  try {
    if (providerId === "cline") return await cline(accessCredential, fetcher);
    if (providerId === "codex") {
      const fields = authCredential(credential);
      const access = text(token?.accessToken) ?? text(fields.accessToken) ?? accessCredential;
      const accountId = text(fields.providerAccountId) ?? text(fields.accountId) ?? text(fields.account_id) ?? codexJwtAccountId(access);
      return codex(await getJson("https://chatgpt.com/backend-api/wham/usage", { authorization: `Bearer ${access}`, ...(accountId === null ? {} : { "chatgpt-account-id": accountId }) }, fetcher), fetchedAt);
    }
    const fields = authCredential(accessCredential);
    const access = text(fields.accessToken) ?? accessCredential;
    if (providerId === "antigravity") {
      return antigravity(await getJson("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", { authorization: `Bearer ${access}`, "user-agent": "antigravity/hub/2.1.4", "x-client-name": "antigravity", "x-client-version": "1.0.0" }, fetcher, { project: fields.projectId ?? fields.providerAccountId }));
    }
    if (providerId === "claude") {
      return anthropic(await getJson("https://api.anthropic.com/api/oauth/usage", { authorization: `Bearer ${access}`, "anthropic-beta": claudeCodeOAuthBetas.join(","), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli", "x-client-request-id": crypto.randomUUID(), "accept-encoding": "gzip, deflate, br", connection: "keep-alive" }, fetcher));
    }
    if (providerId === "grok-build") {
      const headers = {
        authorization: `Bearer ${access}`,
        accept: "application/json",
        "user-agent": "grok-shell/0.2.120",
        "x-xai-token-auth": "grok-cli",
        "x-grok-client-identifier": "grok-shell",
      };
      const [billing, user] = await Promise.all([
        getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, fetcher),
        getJson("https://cli-chat-proxy.grok.com/v1/user?include=subscription", headers, fetcher),
      ]);
      return grokBuild(billing, user);
    }
    if (providerId === "kiro") {
      const region = text(fields.region) ?? "us-east-1";
      return kiro(await getJson(`https://codewhisperer.${region}.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`, { authorization: `Bearer ${access}`, "user-agent": "aws-sdk-js/1.0.0 KiroIDE" }, fetcher));
    }
    return { source: providerId, plan: null, windows: [], error: "Quota endpoint is not available for this provider." };
  } catch (error) {
    return { source: providerId, plan: null, windows: [], error: cleanError(error) };
  }
}

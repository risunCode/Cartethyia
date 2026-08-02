import type { AccountQuota, AccountQuotaWindow, AccountQuotaWindowKind } from "../console/quota";
import type { OAuthProviderId, TokenLease } from "./types";
import { exchangeQoderPat, fetchQoderUsage } from "../upstream/providers/qoder/protocol";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTIGRAVITY_MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_SANDBOX_MODELS_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels";
const QUOTA_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function quotaRecord(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? record(root.result) ?? record(root.usage) ?? root;
}

function isoReset(value: unknown, afterSeconds: unknown, now: number): string | null {
  const absolute = number(value);
  if (absolute !== null) {
    const milliseconds = absolute > 1_000_000_000_000 ? absolute : absolute * 1_000;
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  }
  const after = number(afterSeconds);
  return after !== null && after > 0 ? new Date(now + after * 1_000).toISOString() : null;
}

function classifyWindow(durationSeconds: number | null, label: string): AccountQuotaWindowKind {
  const normalized = label.toLowerCase();
  if (normalized.includes("month") || normalized.includes("spend")) return "monthly";
  if (durationSeconds !== null && durationSeconds >= 5 * 24 * 60 * 60) return "weekly";
  if (durationSeconds !== null && durationSeconds <= 6 * 60 * 60) return "session";
  if (durationSeconds !== null && durationSeconds <= 24 * 60 * 60) return "daily";
  return "other";
}

function windowLabel(durationSeconds: number | null, fallback: string): string {
  if (/month|spend/i.test(fallback)) return fallback;
  if (durationSeconds === null) return fallback;
  if (durationSeconds >= 24 * 60 * 60) return `${Math.round(durationSeconds / (24 * 60 * 60))} Day`;
  if (durationSeconds >= 60 * 60) return `${Math.max(1, Math.round(durationSeconds / (60 * 60)))} Hour`;
  return fallback;
}

function percentWindow(kind: AccountQuotaWindowKind, label: string, used: number | null, resetsAt: string | null): AccountQuotaWindow {
  const usedPercent = used === null ? null : clampPercent(used);
  return {
    kind,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt,
  };
}

function planLabel(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function codexWindow(payload: unknown, fallback: string, now: number): AccountQuotaWindow | null {
  const value = record(payload);
  if (!value) return null;
  const used = number(value.used_percent);
  const duration = number(value.limit_window_seconds);
  const reset = isoReset(value.reset_at, value.reset_after_seconds, now);
  if (used === null && duration === null && reset === null) return null;
  const label = windowLabel(duration, fallback);
  return percentWindow(classifyWindow(duration, fallback), label, used, reset);
}

function parseCodexQuota(body: unknown, fetchedAt: string): AccountQuota {
  const payload = record(body) ?? {};
  const rateLimit = record(payload.rate_limit);
  const windows: AccountQuotaWindow[] = [];
  const now = Date.parse(fetchedAt);
  const primary = codexWindow(rateLimit?.primary_window, "Primary", now);
  const secondary = codexWindow(rateLimit?.secondary_window, "Secondary", now);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    const extra = record(item);
    const extraRate = record(extra?.rate_limit);
    const name = text(extra?.limit_name) ?? text(extra?.metered_feature) ?? "Additional";
    const extraPrimary = codexWindow(extraRate?.primary_window, `${name} · Primary`, now);
    const extraSecondary = codexWindow(extraRate?.secondary_window, `${name} · Secondary`, now);
    if (extraPrimary) windows.push(extraPrimary);
    if (extraSecondary) windows.push(extraSecondary);
  }

  return { plan: planLabel(text(payload.plan_type)), windows, fetchedAt, error: null };
}

function anthropicWindow(payload: unknown, label: string, kind: AccountQuotaWindowKind): AccountQuotaWindow | null {
  const value = record(payload);
  if (!value) return null;
  const used = number(value.utilization);
  const resetsAt = text(value.resets_at);
  if (used === null && !resetsAt) return null;
  return percentWindow(kind, label, used, resetsAt && Number.isFinite(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null);
}

function parseAnthropicQuota(body: unknown, fetchedAt: string): AccountQuota {
  const payload = record(body) ?? {};
  const windows: AccountQuotaWindow[] = [];
  const fiveHour = anthropicWindow(payload.five_hour, "5 Hour", "session");
  const sevenDay = anthropicWindow(payload.seven_day, "7 Day", "weekly");
  if (fiveHour) windows.push(fiveHour);
  if (sevenDay) windows.push(sevenDay);

  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  for (const item of limits) {
    const limit = record(item);
    if (text(limit?.kind) !== "weekly_scoped") continue;
    const scope = record(limit?.scope);
    const model = record(scope?.model);
    const displayName = text(model?.display_name);
    const scoped = anthropicWindow(limit, displayName ? `7 Day · ${displayName}` : "7 Day", "weekly");
    if (scoped) windows.push(scoped);
  }

  const extra = record(payload.extra_usage);
  const monthlyLimit = number(extra?.monthly_limit);
  const usedCredits = number(extra?.used_credits);
  if (monthlyLimit !== null && monthlyLimit > 0 && usedCredits !== null) {
    windows.push(percentWindow("monthly", "Monthly", (usedCredits / monthlyLimit) * 100, null));
  }

  const plan = text(payload.plan_type) ?? text(payload.plan) ?? text(record(payload.organization)?.name);
  return { plan: planLabel(plan), windows, fetchedAt, error: null };
}

function quotaError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\s+/g, " ").slice(0, 240);
  return "Quota request failed.";
}

async function fetchJson(url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Quota endpoint returned HTTP ${response.status}.`);
  return response.json();
}

async function fetchCodexQuota(lease: TokenLease, fetchedAt: string): Promise<AccountQuota> {
  const accountId = lease.providerMetadata.chatgptAccountId ?? lease.accountId;
  const headers: Record<string, string> = {
    authorization: `Bearer ${lease.accessToken}`,
    "user-agent": "OpenCode-Status-Plugin/1.0",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return parseCodexQuota(await fetchJson(CODEX_USAGE_URL, headers), fetchedAt);
}

async function fetchAnthropicQuota(lease: TokenLease, fetchedAt: string): Promise<AccountQuota> {
  return parseAnthropicQuota(await fetchJson(ANTHROPIC_USAGE_URL, {
    accept: "application/json, text/plain, */*",
    authorization: `Bearer ${lease.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27",
    "content-type": "application/json",
    "user-agent": "claude-code/1.0.0",
  }), fetchedAt);
}

interface AntigravityQuotaInfo {
  remainingFraction?: unknown;
  resetTime?: unknown;
  windowId?: unknown;
  windowLabel?: unknown;
  apiProvider?: unknown;
  modelProvider?: unknown;
}

function antigravityCounterName(info: AntigravityQuotaInfo, fallback: string): string {
  const provider = text(info.modelProvider) ?? text(info.apiProvider);
  if (provider === "MODEL_PROVIDER_ANTHROPIC" || provider === "API_PROVIDER_ANTHROPIC_VERTEX") return "Anthropic";
  if (provider === "MODEL_PROVIDER_GOOGLE" || provider === "API_PROVIDER_GOOGLE_GEMINI") return "Google";
  if (provider === "MODEL_PROVIDER_OPENAI" || provider === "API_PROVIDER_OPENAI_VERTEX") return "OpenAI";
  return fallback;
}

function antigravityWindowKind(label: string): AccountQuotaWindowKind {
  const normalized = label.toLowerCase();
  if (normalized.includes("week") || normalized.includes("7d") || normalized.includes("7 day")) return "weekly";
  if (normalized.includes("day") || normalized.includes("daily") || normalized.includes("24h")) return "daily";
  return "other";
}

function parseAntigravityQuota(body: unknown, fetchedAt: string): AccountQuota {
  const payload = quotaRecord(body);
  const models = record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota);
  const windows: AccountQuotaWindow[] = [];
  const seen = new Set<string>();
  for (const [modelId, rawModel] of Object.entries(models ?? {})) {
    const model = record(rawModel);
    if (!model) continue;
    const infos: AntigravityQuotaInfo[] = [];
    const add = (value: unknown, label?: string) => {
      if (Array.isArray(value)) { for (const item of value) add(item, label); return; }
      const info = record(value);
      if (!info) return;
      infos.push({
        ...info,
        ...(info.modelProvider ?? model.modelProvider ? { modelProvider: info.modelProvider ?? model.modelProvider } : {}),
        ...(info.apiProvider ?? model.apiProvider ? { apiProvider: info.apiProvider ?? model.apiProvider } : {}),
        ...(label ? { windowLabel: info.windowLabel ?? label } : {}),
      });
    };
    add(model.quotaInfo); add(model.quotaInfos);
    add(model.dailyQuotaInfo, "Daily"); add(model.dailyQuotaInfos, "Daily");
    add(model.weeklyQuotaInfo, "Weekly"); add(model.weeklyQuotaInfos, "Weekly");
    for (const [window, value] of Object.entries(record(model.quotaInfoByWindow) ?? {})) add(value, window);
    for (const info of infos) {
      const remaining = number(info.remainingFraction);
      const reset = text(info.resetTime);
      const label = text(info.windowLabel) ?? text(info.windowId) ?? (reset && Date.parse(reset) - Date.now() > 86_400_000 ? "Weekly" : "Daily");
      const provider = antigravityCounterName(info, modelId);
      const key = `${provider}:${label}:${reset ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (remaining === null && !reset) continue;
      const usedPercent = remaining === null ? 100 : Math.round(clampPercent((1 - Math.min(1, Math.max(0, remaining))) * 100) * 100) / 100;
      windows.push({ kind: antigravityWindowKind(label), label: `${provider} · ${label}`, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: reset && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null });
    }
  }
  return { plan: planLabel(text(payload.tier) ?? text(payload.plan) ?? "Antigravity"), windows, fetchedAt, error: null };
}

function parseKiroQuota(body: unknown, fetchedAt: string): AccountQuota {
  const payload = quotaRecord(body);
  const usageList = Array.isArray(payload.usageBreakdownList) ? payload.usageBreakdownList : [];
  const resetAt = isoDate(payload.nextDateReset ?? payload.resetDate);
  const windows: AccountQuotaWindow[] = [];
  for (const item of usageList) {
    const breakdown = record(item);
    if (!breakdown) continue;
    const resourceType = text(breakdown.resourceType) ?? "Kiro usage";
    const used = number(breakdown.currentUsageWithPrecision) ?? 0;
    const total = number(breakdown.usageLimitWithPrecision) ?? 0;
    if (total > 0) windows.push({ kind: "monthly", label: resourceType, usedPercent: Math.min(100, Math.max(0, (used / total) * 100)), remainingPercent: Math.max(0, 100 - (used / total) * 100), resetsAt: resetAt });
    const freeTrial = record(breakdown.freeTrialInfo);
    const freeUsed = number(freeTrial?.currentUsageWithPrecision) ?? 0;
    const freeTotal = number(freeTrial?.usageLimitWithPrecision) ?? 0;
    if (freeTrial && freeTotal > 0) windows.push({ kind: "monthly", label: `${resourceType} · Free trial`, usedPercent: Math.min(100, Math.max(0, (freeUsed / freeTotal) * 100)), remainingPercent: Math.max(0, 100 - (freeUsed / freeTotal) * 100), resetsAt: isoDate(freeTrial.freeTrialExpiry) ?? resetAt });
  }
  const subscription = record(payload.subscriptionInfo);
  return { plan: text(subscription?.subscriptionTitle) ?? "Kiro", windows, fetchedAt, error: windows.length > 0 ? null : "Kiro quota payload contained no usage windows." };
}

async function fetchKiroQuota(lease: TokenLease, fetchedAt: string): Promise<AccountQuota> {
  const metadata = lease.providerMetadata;
  const region = text(metadata.region) ?? "us-east-1";
  const authMethod = text(metadata.authMethod) ?? "builder-id";
  const isApiKey = authMethod === "api_key";
  const isExternalIdp = authMethod === "external_idp";
  const profileArn = isApiKey ? text(metadata.profileArn) : text(metadata.profileArn);
  const headers: Record<string, string> = { authorization: `Bearer ${lease.accessToken}`, accept: "application/json", "user-agent": "aws-sdk-js/1.0.0 KiroIDE", "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE" };
  if (isApiKey) headers.tokentype = "API_KEY";
  if (isExternalIdp) headers.TokenType = "EXTERNAL_IDP";
  const query = new URLSearchParams({ isEmailRequired: "true", origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST", ...(profileArn ? { profileArn } : {}) });
  const base = `https://codewhisperer.${region}.amazonaws.com`;
  try {
    return parseKiroQuota(await fetchJson(`${base}/getUsageLimits?${query.toString()}`, headers), fetchedAt);
  } catch {
    try {
      return parseKiroQuota(await fetchJson(base, { ...headers, "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits" }, { origin: "AI_EDITOR", ...(profileArn ? { profileArn } : {}), resourceType: "AGENTIC_REQUEST" }), fetchedAt);
    } catch {
      const qBase = `https://q.${region}.amazonaws.com`;
      return parseKiroQuota(await fetchJson(`${qBase}/getUsageLimits?${query.toString()}`, headers), fetchedAt);
    }
  }
}

async function fetchAntigravityQuota(lease: TokenLease, fetchedAt: string): Promise<AccountQuota> {
  const projectId = lease.providerMetadata.projectId;
  if (!projectId) return { plan: null, windows: [], fetchedAt, error: "Antigravity OAuth credential is missing project metadata." };
  const headers = { authorization: `Bearer ${lease.accessToken}`, accept: "application/json", "user-agent": "antigravity/hub/2.1.4" };
  try {
    try {
      const quota = parseAntigravityQuota(await fetchJson(ANTIGRAVITY_MODELS_URL, headers, { project: projectId }), fetchedAt);
      return quota.windows.length > 0 ? quota : { ...quota, error: "Antigravity quota payload contained no quota windows." };
    } catch {
      const quota = parseAntigravityQuota(await fetchJson(ANTIGRAVITY_SANDBOX_MODELS_URL, headers, { project: projectId }), fetchedAt);
      return quota.windows.length > 0 ? quota : { ...quota, error: "Antigravity quota payload contained no quota windows." };
    }
  } catch (error) { return { plan: null, windows: [], fetchedAt, error: quotaError(error) }; }
}

export async function fetchQoderQuota(pat: string): Promise<AccountQuota> {
  const fetchedAt = new Date().toISOString();
  try {
    const auth = await exchangeQoderPat(pat, AbortSignal.timeout(QUOTA_TIMEOUT_MS));
    const payload = quotaRecord(await fetchQoderUsage(auth, AbortSignal.timeout(QUOTA_TIMEOUT_MS)));
    const windows: AccountQuotaWindow[] = [];
    const expiresAt = isoDate(payload?.expiresAt);
    const addBucket = (raw: unknown, label: string) => {
      const bucket = record(raw);
      const total = number(bucket?.total);
      const used = number(bucket?.used);
      if (total === null || total <= 0 || used === null) return;
      const usedPercent = Math.round(clampPercent((used / total) * 100) * 100) / 100;
      windows.push({ kind: "monthly", label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: expiresAt });
    };
    addBucket(payload?.userQuota, "User Quota");
    addBucket(payload?.orgResourcePackage, "Org Resource Package");
    return { plan: "Qoder AI Plan", windows, fetchedAt, error: windows.length > 0 ? null : "Qoder usage payload contained no quota buckets." };
  } catch (error) { return { plan: null, windows: [], fetchedAt, error: quotaError(error) }; }
}

function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 1_000_000_000_000 ? value : value * 1_000).toISOString();
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export async function fetchOAuthQuota(provider: OAuthProviderId, lease: TokenLease): Promise<AccountQuota> {
  const fetchedAt = new Date().toISOString();
  try {
    if (provider === "openai-codex") return await fetchCodexQuota(lease, fetchedAt);
    if (provider === "anthropic-oauth") return await fetchAnthropicQuota(lease, fetchedAt);
    if (provider === "google-antigravity") return await fetchAntigravityQuota(lease, fetchedAt);
    if (provider === "kiro") return await fetchKiroQuota(lease, fetchedAt);
    return { plan: null, windows: [], fetchedAt, error: "Quota endpoint is not available for this provider." };
  } catch (error) {
    return { plan: null, windows: [], fetchedAt, error: quotaError(error) };
  }
}

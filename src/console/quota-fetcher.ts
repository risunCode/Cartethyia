import { exchangeQoderPat, fetchQoderUsage } from "../providers/qoder";
import type { OAuthTokenRecord } from "../auth/credentials";
import { claudeCodeOAuthBetas } from "../providers/claude-code";
import type { AccountQuotaWindowView } from "./services";

export interface ProviderQuotaResult {
  readonly source: string;
  readonly plan: string | null;
  readonly windows: readonly AccountQuotaWindowView[];
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
function percentWindow(kind: string, label: string, used: number | null, resetsAt: string | null, usedValue?: number | null, limit?: number | null): AccountQuotaWindowView {
  const usedPercent = used === null ? null : clampPercent(used);
  return { kind, label, usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent), resetsAt, used: usedValue ?? null, limit: limit ?? null };
}
function authCredential(credential: string): Record<string, unknown> {
  const parsed = record(credential.startsWith("{") ? (() => { try { return JSON.parse(credential); } catch { return null; } })() : null);
  return parsed ?? { accessToken: credential };
}
async function getJson(url: string, headers: Record<string, string>, fetcher: FetchLike, body?: unknown): Promise<unknown> {
  const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const textBody = await response.text();
  let parsed: unknown = null;
  try { parsed = textBody.length > 0 ? JSON.parse(textBody) : null; } catch { parsed = null; }
  // Return parsed body even on error — provider parsers extract partial data
  const envelope = record(parsed);
  if (envelope?.success === false) throw new Error(text(envelope.error) ?? "Quota endpoint rejected the request.");
  return envelope?.success === true && "data" in envelope ? envelope.data : parsed;
}

function codex(body: unknown, fetchedAt: string): ProviderQuotaResult {
  const payload = quotaRecord(body); const rate = record(payload.rate_limit); const windows: AccountQuotaWindowView[] = [];
  const add = (raw: unknown, fallback: string) => { const value = record(raw); if (!value) return; const used = number(value.used_percent); const duration = number(value.limit_window_seconds); const reset = isoDate(value.reset_at) ?? (number(value.reset_after_seconds) !== null ? new Date(Date.parse(fetchedAt) + (number(value.reset_after_seconds) ?? 0) * 1000).toISOString() : null); if (used !== null || reset !== null) windows.push(percentWindow(duration !== null && duration <= 21_600 ? "session" : duration !== null && duration <= 86_400 ? "daily" : "weekly", duration !== null ? `${Math.max(1, Math.round(duration / 3600))} Hour` : fallback, used, reset)); };
  add(rate?.primary_window, "Primary"); add(rate?.secondary_window, "Secondary");
  return { source: "codex", plan: text(payload.plan_type), windows, error: null };
}
function anthropic(body: unknown): ProviderQuotaResult {
  const payload = record(body) ?? {}; const windows: AccountQuotaWindowView[] = [];
  const add = (key: string, label: string, kind: string) => { const value = record(payload[key]); if (value) windows.push(percentWindow(kind, label, number(value.utilization), isoDate(value.resets_at))); };
  add("five_hour", "5 Hour", "session"); add("seven_day", "7 Day", "weekly");
  return { source: "claude", plan: text(payload.plan_type) ?? text(payload.plan), windows, error: null };
}
function antigravity(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body); const models = record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota) ?? {}; const windows: AccountQuotaWindowView[] = [];
  for (const [modelId, raw] of Object.entries(models)) { const model = record(raw); if (!model) continue; const infos = [model.quotaInfo, model.dailyQuotaInfo, model.weeklyQuotaInfo, model.quotaInfos, model.dailyQuotaInfos, model.weeklyQuotaInfos].flatMap((value) => Array.isArray(value) ? value : [value]); for (const infoRaw of infos) { const info = record(infoRaw); if (!info) continue; const remaining = number(info.remainingFraction); const reset = isoDate(info.resetTime); if (remaining === null && reset === null) continue; const label = text(info.windowLabel) ?? text(info.windowId) ?? "Quota"; windows.push(percentWindow("other", `${modelId} · ${label}`, remaining === null ? 100 : (1 - clampPercent(remaining * 100)), reset)); } }
  return { source: "antigravity", plan: text(payload.tier) ?? text(payload.plan) ?? "Antigravity", windows, error: null };
}
function kiro(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body); const list = Array.isArray(payload.usageBreakdownList) ? payload.usageBreakdownList : []; const reset = isoDate(payload.nextDateReset ?? payload.resetDate); const windows: AccountQuotaWindowView[] = [];
  for (const raw of list) { const value = record(raw); if (!value) continue; const used = number(value.currentUsageWithPrecision); const limit = number(value.usageLimitWithPrecision); if (limit !== null && limit > 0) windows.push(percentWindow("monthly", text(value.resourceType) ?? "Kiro usage", used === null ? null : used / limit * 100, reset, used, limit)); }
  const subscription = record(payload.subscriptionInfo);
  return { source: "kiro", plan: text(subscription?.subscriptionTitle) ?? "Kiro", windows, error: windows.length === 0 ? "Kiro quota payload contained no usage windows." : null };
}
function qoder(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body); const windows: AccountQuotaWindowView[] = []; const expiry = isoDate(payload.expiresAt);
  for (const [key, label] of [["userQuota", "User Quota"], ["orgResourcePackage", "Org Resource Package"]] as const) { const bucket = record(payload[key]); const total = number(bucket?.total); const used = number(bucket?.used); if (total !== null && total > 0 && used !== null) windows.push(percentWindow("monthly", label, used / total * 100, expiry, used, total)); }
  return { source: "qoder", plan: "Qoder AI Plan", windows, error: windows.length === 0 ? "Qoder usage payload contained no quota buckets." : null };
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
    const fields = authCredential(accessCredential); const access = text(fields.accessToken) ?? accessCredential;
    if (providerId === "qoder") return qoder(await fetchQoderUsage(await exchangeQoderPat(credential, AbortSignal.timeout(TIMEOUT_MS), fetcher as never), AbortSignal.timeout(TIMEOUT_MS), fetcher as never));
    if (providerId === "codex") return codex(await getJson("https://chatgpt.com/backend-api/wham/usage", { authorization: `Bearer ${access}`, ...(text(fields.providerAccountId) ? { "chatgpt-account-id": text(fields.providerAccountId) as string } : {}) }, fetcher), fetchedAt);
    if (providerId === "claude") return anthropic(await getJson("https://api.anthropic.com/api/oauth/usage", { authorization: `Bearer ${access}`, "anthropic-beta": claudeCodeOAuthBetas.join(","), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli", "x-client-request-id": crypto.randomUUID(), "accept-encoding": "gzip, deflate, br", connection: "keep-alive" }, fetcher));
    if (providerId === "antigravity") return antigravity(await getJson("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", { authorization: `Bearer ${access}`, "user-agent": "antigravity/hub/2.1.4" }, fetcher, { project: fields.projectId ?? fields.providerAccountId }));
    if (providerId === "kiro") { const region = text(fields.region) ?? "us-east-1"; return kiro(await getJson(`https://codewhisperer.${region}.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`, { authorization: `Bearer ${access}`, "user-agent": "aws-sdk-js/1.0.0 KiroIDE" }, fetcher)); }
    return { source: providerId, plan: null, windows: [], error: "Quota endpoint is not available for this provider." };
  } catch (error) {
    return { source: providerId, plan: null, windows: [], error: cleanError(error) };
  }
}

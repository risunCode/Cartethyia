import type { FetchLike, OAuthQuotaToken, ProviderQuotaResult, ProviderQuotaWindow } from "./types";
import { authCredential, getJson, isoDate, number, percentWindow, quotaRecord, record, text } from "./shared";

interface AntigravityQuotaFamily {
  readonly key: string;
  readonly label: string;
}

const IMPORTANT_MODELS = new Set([
  "gemini-3-flash-agent",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
  "gemini-pro-agent",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "gpt-oss-120b-medium",
  "gemini-3-flash",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
]);

function modelFamily(modelId: string): AntigravityQuotaFamily {
  if (/^(?:gemini[-_]|tab_)/i.test(modelId)) return { key: "google", label: "Google" };
  if (/^(?:claude[-_]|gpt-oss[-_])/i.test(modelId)) return { key: "claude", label: "Claude" };
  return { key: `model:${modelId}`, label: modelId };
}

function earlierReset(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function mergeWindow(left: ProviderQuotaWindow, right: ProviderQuotaWindow): ProviderQuotaWindow {
  const remaining = left.remainingPercent === null ? right.remainingPercent : right.remainingPercent === null ? left.remainingPercent : Math.min(left.remainingPercent, right.remainingPercent);
  return { ...left, usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining, resetsAt: earlierReset(left.resetsAt, right.resetsAt) };
}

function parseAntigravityQuota(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body);
  const models = record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota) ?? {};
  const grouped = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, raw] of Object.entries(models)) {
    const model = record(raw);
    if (!model || model.isInternal === true || !IMPORTANT_MODELS.has(modelId)) continue;
    const family = modelFamily(modelId);
    const infos = [
      ["quota", model.quotaInfo],
      ["daily", model.dailyQuotaInfo],
      ["weekly", model.weeklyQuotaInfo],
      ["quotas", model.quotaInfos],
      ["daily-quotas", model.dailyQuotaInfos],
      ["weekly-quotas", model.weeklyQuotaInfos],
    ] as const;
    for (const [slot, value] of infos) {
      const entries = Array.isArray(value) ? value : [value];
      for (const infoRaw of entries) {
        const info = record(infoRaw);
        if (!info) continue;
        const remaining = number(info.remainingFraction);
        const reset = isoDate(info.resetTime);
        if (remaining === null && reset === null) continue;
        const windowLabel = text(info.windowLabel) ?? text(info.windowId) ?? "Quota";
        const window = percentWindow(`${family.key}:${slot}`, `${family.label} · ${windowLabel}`, remaining === null ? 100 : (1 - Math.min(1, Math.max(0, remaining))) * 100, reset);
        const key = `${family.key}:${slot}:${windowLabel}`;
        const previous = grouped.get(key);
        grouped.set(key, previous === undefined ? window : mergeWindow(previous, window));
      }
    }
  }
  return { source: "antigravity", plan: text(payload.tier) ?? text(payload.plan) ?? "Antigravity", windows: [...grouped.values()], error: null };
}

export async function fetchAntigravityQuota(credential: string, token: OAuthQuotaToken, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(token?.accessToken) ?? text(fields.accessToken) ?? credential;
  return parseAntigravityQuota(await getJson("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", { authorization: `Bearer ${access}`, "user-agent": "antigravity/hub/2.1.4", "x-client-name": "antigravity", "x-client-version": "1.0.0" }, fetcher, { project: fields.projectId ?? fields.providerAccountId }));
}

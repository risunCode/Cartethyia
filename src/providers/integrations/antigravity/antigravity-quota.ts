import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  authCredential,
  getJson,
  percentWindow,
  quotaRecord,
  record,
  text,
  number,
  isoDate,
} from "../../quota/quota-contracts";
import { getAntigravityUserAgent } from "./antigravity-protocol";

interface AntigravityQuotaFamily {
  readonly key: string;
  readonly label: string;
}

const IMPORTANT_MODELS = new Set([
  "gemini-3-flash-agent",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-extra-low",
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-high",
  "gemini-3.7-flash-low",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-high",
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

function isQuotaModel(modelId: string): boolean {
  return (
    IMPORTANT_MODELS.has(modelId) ||
    /^(?:gemini-\d+(?:\.\d+)?-[a-z0-9-]+|claude-[a-z0-9-]+|gpt-oss-[a-z0-9-]+)$/i.test(modelId)
  );
}

function earlierReset(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function mergeWindow(left: ProviderQuotaWindow, right: ProviderQuotaWindow): ProviderQuotaWindow {
  const remaining =
    left.remainingPercent === null
      ? right.remainingPercent
      : right.remainingPercent === null
        ? left.remainingPercent
        : Math.min(left.remainingPercent, right.remainingPercent);
  return {
    ...left,
    usedPercent: remaining === null ? null : 100 - remaining,
    remainingPercent: remaining,
    resetsAt: earlierReset(left.resetsAt, right.resetsAt),
  };
}

function parseAntigravityQuota(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body);
  const models =
    record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota) ?? {};
  const grouped = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, raw] of Object.entries(models)) {
    const model = record(raw);
    if (!model || model.isInternal === true || !isQuotaModel(modelId)) continue;
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
        const window = percentWindow(
          `${family.key}:${slot}`,
          `${family.label} · ${windowLabel}`,
          remaining === null ? 100 : (1 - Math.min(1, Math.max(0, remaining))) * 100,
          reset,
        );
        const key = `${family.key}:${slot}:${windowLabel}`;
        const previous = grouped.get(key);
        grouped.set(key, previous === undefined ? window : mergeWindow(previous, window));
      }
    }
  }
  return {
    source: "antigravity",
    plan: text(payload.tier) ?? text(payload.plan) ?? "Antigravity",
    windows: [...grouped.values()],
    error: null,
  };
}

export async function fetchAntigravityQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(fields.accessToken) ?? credential;
  const headers = {
    authorization: `Bearer ${access}`,
    // Discovered client UA, never a stale pinned version or invented
    // x-client-* headers the reference client does not send.
    "user-agent": getAntigravityUserAgent(),
  };
  // Primary: quota summary on the production host, then sandbox (reference
  // order); the models endpoint below is only the legacy fallback. An
  // unrecognized (empty) primary shape falls through rather than reporting
  // a phantom empty quota.
  for (const host of [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
  ]) {
    try {
      const result = parseAntigravityQuota(
        await getJson(
          `${host}/v1internal:retrieveUserQuotaSummary`,
          headers,
          fetcher,
          { project: fields.projectId ?? fields.providerAccountId },
        ),
      );
      if (result.windows.length > 0) return result;
    } catch {
      // Fall through to the next host, then the legacy endpoint.
    }
  }
  return parseAntigravityQuota(
    await getJson(
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      headers,
      fetcher,
      { project: fields.projectId ?? fields.providerAccountId },
    ),
  );
}

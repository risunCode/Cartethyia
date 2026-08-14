import type { FetchLike, OAuthQuotaToken, ProviderQuotaResult, ProviderQuotaWindow } from "./types";
import { authCredential, codexJwtAccountId, getJson, isoDate, number, percentWindow, quotaRecord, text } from "./shared";

function parseCodexQuota(body: unknown, fetchedAt: string): ProviderQuotaResult {
  const payload = quotaRecord(body);
  const rate = quotaRecord(payload.rate_limit);
  const windows: ProviderQuotaWindow[] = [];
  const add = (raw: unknown, fallback: string): void => {
    const value = quotaRecord(raw);
    const used = number(value.used_percent);
    const duration = number(value.limit_window_seconds);
    const afterSeconds = number(value.reset_after_seconds);
    const reset = isoDate(value.reset_at) ?? (afterSeconds !== null ? new Date(Date.parse(fetchedAt) + afterSeconds * 1000).toISOString() : null);
    if (used !== null || reset !== null) {
      const kind = duration !== null && duration <= 21_600 ? "session" : duration !== null && duration <= 86_400 ? "daily" : "weekly";
      const label = duration !== null ? `${Math.max(1, Math.round(duration / 3600))} Hour` : fallback;
      windows.push(percentWindow(kind, label, used, reset));
    }
  };
  add(rate.primary_window, "Primary");
  add(rate.secondary_window, "Secondary");
  return { source: "codex", plan: text(payload.plan_type), windows, error: null };
}

export async function fetchCodexQuota(credential: string, token: OAuthQuotaToken, fetcher: FetchLike, fetchedAt: string): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(token?.accessToken) ?? text(fields.accessToken) ?? credential;
  const accountId = text(fields.providerAccountId) ?? text(fields.accountId) ?? text(fields.account_id) ?? codexJwtAccountId(access);
  const body = await getJson("https://chatgpt.com/backend-api/wham/usage", { authorization: `Bearer ${access}`, ...(accountId === null ? {} : { "chatgpt-account-id": accountId }) }, fetcher);
  return parseCodexQuota(body, fetchedAt);
}

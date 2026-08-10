import type { FetchLike, OAuthQuotaToken, ProviderQuotaResult, ProviderQuotaWindow } from "./types";
import { authCredential, getJson, isoDate, number, percentWindow, quotaRecord, text } from "./shared";

function parseKiroQuota(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body);
  const list = Array.isArray(payload.usageBreakdownList) ? payload.usageBreakdownList : [];
  const reset = isoDate(payload.nextDateReset ?? payload.resetDate);
  const windows: ProviderQuotaWindow[] = [];
  for (const raw of list) {
    const value = quotaRecord(raw);
    const used = number(value.currentUsageWithPrecision);
    const limit = number(value.usageLimitWithPrecision);
    if (limit !== null && limit > 0) windows.push(percentWindow("monthly", text(value.resourceType) ?? "Kiro usage", used === null ? null : used / limit * 100, reset, used, limit));
  }
  const subscription = quotaRecord(payload.subscriptionInfo);
  return { source: "kiro", plan: text(subscription.subscriptionTitle) ?? "Kiro", windows, error: windows.length === 0 ? "Kiro quota payload contained no usage windows." : null };
}

export async function fetchKiroQuota(credential: string, token: OAuthQuotaToken, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(token?.accessToken) ?? text(fields.accessToken) ?? credential;
  const region = text(fields.region) ?? "us-east-1";
  const body = await getJson(`https://codewhisperer.${region}.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST`, { authorization: `Bearer ${access}`, "user-agent": "aws-sdk-js/1.0.0 KiroIDE" }, fetcher);
  return parseKiroQuota(body);
}

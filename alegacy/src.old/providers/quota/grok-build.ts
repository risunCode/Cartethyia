import type { FetchLike, ProviderQuotaResult } from "./types";
import { authCredential, getJson, isoDate, number, percentWindow, quotaRecord, text } from "./shared";

function parseGrokBuildQuota(body: unknown, userBody: unknown): ProviderQuotaResult {
  const billing = quotaRecord(body);
  const user = quotaRecord(userBody);
  const plan = text(billing.plan) ?? text(billing.subscriptionAccess) ?? text(user.subscriptionType) ?? "Grok Build";
  const total = number(billing.onDemandCap) ?? number(billing.totalCredits) ?? number(billing.creditLimit);
  const used = number(billing.onDemandUsed) ?? number(billing.usedCredits) ?? number(billing.creditUsed);
  const remaining = number(billing.remainingCredits) ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
  const reset = isoDate(billing.currentPeriodEnd) ?? isoDate(billing.periodEnd) ?? isoDate(billing.resetAt);
  const windows = remaining !== null || reset !== null ? [percentWindow("credit", "Grok Build credits", used !== null && total !== null && total > 0 ? used / total * 100 : null, reset, used, total)] : [];
  return { source: "grok-build", plan, windows, error: null };
}

export async function fetchGrokBuildQuota(credential: string, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(fields.accessToken) ?? credential;
  const headers = { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "grok-shell/0.2.120", "x-xai-token-auth": "grok-cli", "x-grok-client-identifier": "grok-shell" };
  const [billing, user] = await Promise.all([
    getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, fetcher),
    getJson("https://cli-chat-proxy.grok.com/v1/user?include=subscription", headers, fetcher),
  ]);
  return parseGrokBuildQuota(billing, user);
}

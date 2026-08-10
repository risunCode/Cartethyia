import { claudeCodeOAuthBetas } from "../../providers/claude-code";
import type { FetchLike, OAuthQuotaToken, ProviderQuotaResult, ProviderQuotaWindow } from "./types";
import { authCredential, getJson, isoDate, number, percentWindow, record, text } from "./shared";

function parseClaudeQuota(body: unknown): ProviderQuotaResult {
  const payload = record(body) ?? {};
  const windows: ProviderQuotaWindow[] = [];
  const add = (key: string, label: string, kind: string): void => {
    const value = record(payload[key]);
    if (value) windows.push(percentWindow(kind, label, number(value.utilization), isoDate(value.resets_at)));
  };
  add("five_hour", "5 Hour", "session");
  add("seven_day", "7 Day", "weekly");
  return { source: "claude", plan: text(payload.plan_type) ?? text(payload.plan), windows, error: null };
}

export async function fetchClaudeQuota(credential: string, token: OAuthQuotaToken, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(token?.accessToken) ?? text(fields.accessToken) ?? credential;
  const body = await getJson("https://api.anthropic.com/api/oauth/usage", {
    authorization: `Bearer ${access}`,
    "anthropic-beta": claudeCodeOAuthBetas.join(","),
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "x-client-request-id": crypto.randomUUID(),
    "accept-encoding": "gzip, deflate, br",
    connection: "keep-alive",
  }, fetcher);
  return parseClaudeQuota(body);
}

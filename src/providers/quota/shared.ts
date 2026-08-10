import type { FetchLike, ProviderQuotaWindow } from "./types";

const TIMEOUT_MS = 15_000;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function isoDate(value: unknown): string | null {
  const numeric = number(value);
  if (numeric !== null) return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000).toISOString();
  const stringValue = text(value);
  return stringValue !== null && Number.isFinite(Date.parse(stringValue)) ? new Date(stringValue).toISOString() : null;
}

export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Quota request failed — provider did not return a valid response";
  return message.replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]").replace(/\s+/g, " ").slice(0, 240);
}

export function quotaRecord(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? record(root.result) ?? record(root.usage) ?? root;
}

export function percentWindow(kind: string, label: string, used: number | null, resetsAt: string | null, usedValue?: number | null, limit?: number | null): ProviderQuotaWindow {
  const usedPercent = used === null ? null : Math.min(100, Math.max(0, used));
  return { kind, label, usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent), resetsAt, used: usedValue ?? null, limit: limit ?? null };
}

export function authCredential(credential: string): Record<string, unknown> {
  const parsed = record(credential.startsWith("{") ? (() => { try { return JSON.parse(credential); } catch { return null; } })() : null);
  return parsed ?? { accessToken: credential };
}

export function codexJwtAccountId(accessToken: string): string | null {
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

export async function getJson(url: string, headers: Record<string, string>, fetcher: FetchLike, body?: unknown): Promise<unknown> {
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

export function unsupportedQuota(providerId: string): { source: string; plan: null; windows: []; error: string } {
  return { source: providerId, plan: null, windows: [], error: "Quota endpoint is not available for this provider." };
}

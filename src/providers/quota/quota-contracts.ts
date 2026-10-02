import { decodeJwtPayload } from "../authentication/oauth-flow-store";

export interface ProviderQuotaWindow {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
  /** Absolute remaining credits/value when the upstream reports it. */
  readonly remaining?: number | null;
  /** False means the timestamp is a hard expiry rather than a recurring reset. */
  readonly recurring?: boolean;
}

export interface ProviderQuotaResult {
  readonly source: string;
  readonly plan: string | null;
  readonly windows: readonly ProviderQuotaWindow[];
  readonly error: string | null;
  /** Display identity the billing surface reported, when it reported one. */
  readonly accountLabel?: string;
}

export type FetchLike = typeof fetch;

/**
 * The account's total remaining credit across its credit windows, or `null`
 * when the provider reports no credit (a rate-limit-only surface).
 *
 * A "credit window" is one that carries a positive `limit` — a rate limit is
 * not a credit. Per window, `remaining` is preferred when the upstream states
 * it; otherwise it is derived from `used`/`usedPercent` against the window's own
 * limit, and clamped to `[0, limit]`. The figures are then **summed**, because a
 * provider's credit windows are one spendable pool, not independent budgets: the
 * buddy family reports a recurring monthly allowance plus several bonus packs,
 * and a spent bonus pack is not the account running out while the others still
 * hold credit.
 *
 * Summing also keeps this figure identical to the dashboard's Credit Pool card,
 * which sums the same windows — so the reserve an operator sets and the number
 * the card shows cannot disagree about how much the account has left. A per-window
 * minimum did exactly that: it read a spent sub-bucket as "0 remaining" and
 * parked an account holding hundreds of credits.
 */
export function totalRemainingCredit(
  windows: readonly ProviderQuotaWindow[],
): number | null {
  let total: number | null = null;
  for (const window of windows) {
    const limit =
      typeof window.limit === "number" && Number.isFinite(window.limit) && window.limit > 0
        ? window.limit
        : null;
    if (limit === null) continue;
    let remaining: number | null = null;
    if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
      remaining = window.remaining;
    } else if (typeof window.used === "number" && Number.isFinite(window.used)) {
      remaining = limit - window.used;
    } else if (
      typeof window.usedPercent === "number" &&
      Number.isFinite(window.usedPercent)
    ) {
      remaining = (limit * (100 - window.usedPercent)) / 100;
    }
    if (remaining === null) continue;
    const clamped = Math.min(limit, Math.max(0, remaining));
    total = (total ?? 0) + clamped;
  }
  return total;
}

const TIMEOUT_MS = 15_000;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

export function isoDate(value: unknown): string | null {
  const numeric = number(value);
  if (numeric !== null)
    return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000).toISOString();
  const stringValue = text(value);
  return stringValue !== null && Number.isFinite(Date.parse(stringValue))
    ? new Date(stringValue).toISOString()
    : null;
}

export function cleanError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "Quota request failed — provider did not return a valid response";
  return message
    .replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function quotaRecord(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? record(root.result) ?? record(root.usage) ?? root;
}

export function percentWindow(
  kind: string,
  label: string,
  used: number | null,
  resetsAt: string | null,
  usedValue?: number | null,
  limit?: number | null,
): ProviderQuotaWindow {
  const usedPercent = used === null ? null : Math.min(100, Math.max(0, used));
  return {
    kind,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt,
    used: usedValue ?? null,
    limit: limit ?? null,
  };
}

export function authCredential(credential: string): Record<string, unknown> {
  const parsed = record(
    credential.startsWith("{")
      ? (() => {
          try {
            return JSON.parse(credential);
          } catch {
            return null;
          }
        })()
      : null,
  );
  return parsed ?? { accessToken: credential };
}

/**
 * The ChatGPT account id carried by a Codex access token, or `null`.
 *
 * Reads the claims through the shared `decodeJwtPayload` rather than a local
 * `atob(…replace(/-/g,"+")…)`. The two decoders agreed on every ASCII payload,
 * but `atob` decodes base64 to a Latin-1 string, so a claim containing
 * multi-byte UTF-8 came back mojibake — `Buffer.from(segment, "base64url")`
 * is byte-correct. The three fields read here are ASCII either way, so this is
 * a correctness fix for the decoder, not a behaviour change for Codex.
 */
export function codexJwtAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const auth = record(payload["https://api.openai.com/auth"]);
  return (
    text(auth?.chatgpt_account_id) ??
    text(payload["chatgpt_account_id"]) ??
    text(payload["account_id"])
  );
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  fetcher: FetchLike,
  body?: unknown,
): Promise<unknown> {
  const response = await fetcher(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      accept: "application/json",
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const textBody = await response.text();
  let parsed: unknown = null;
  try {
    parsed = textBody.length > 0 ? JSON.parse(textBody) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const envelope = record(parsed);
    const detail = text(envelope?.error) ?? text(envelope?.message) ?? `HTTP ${response.status}`;
    throw new Error(`Quota endpoint rejected request: ${detail}`);
  }
  const envelope = record(parsed);
  if (envelope?.success === false)
    throw new Error(text(envelope.error) ?? "Quota endpoint rejected the request.");
  return envelope?.success === true && "data" in envelope ? envelope.data : parsed;
}

export function unsupportedQuota(providerId: string): {
  source: string;
  plan: null;
  windows: [];
  error: string;
} {
  return {
    source: providerId,
    plan: null,
    windows: [],
    error: "Quota endpoint is not available for this provider.",
  };
}

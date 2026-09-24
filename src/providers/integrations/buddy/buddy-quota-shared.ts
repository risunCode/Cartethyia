/**
 * Shared Tencent billing-meter parsing for the CodeBuddy family
 * (`cb`, `cbcn`, `workbuddy`).
 *
 * All three read the same endpoint shape — POST
 * `{base}/v2/billing/meter/get-user-resource` answering
 * `{ code, data: { Response: { Data: { Accounts: [...] } } } }` — and derive
 * the same windows from it: refill vs bonus is split by
 * `DeductionEndTime - CycleEndTime > 2d`, cadence labels are
 * Daily/Weekly/Monthly with dedup, and bonuses are `Bonus Pack N` sorted by
 * expiry. Only the endpoint, the identity headers, and the display name differ,
 * so those stay in each provider module and the envelope arithmetic lives here.
 */
import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import { cleanError, percentWindow, record as asRecord, text as asText } from "../../quota/quota-contracts";

/**
 * One `Accounts[]` entry of the Tencent billing envelope.
 *
 * The `*Precise` string fields are exact and preferred; the plain numeric
 * fields are the lossy fallback. Extra fields are tolerated rather than
 * rejected, matching the upstream payload's open shape.
 */
export interface TencentBillingAccount {
  readonly PackageName?: string | null;
  readonly SubProductName?: string | null;
  // Refill cycle live numbers.
  readonly CycleCapacityUsedPrecise?: string | number | null;
  readonly CycleCapacityUsed?: number | null;
  readonly CycleCapacitySizePrecise?: string | number | null;
  readonly CycleCapacitySize?: number | null;
  // Bonus lifetime numbers.
  readonly CapacityUsedPrecise?: string | number | null;
  readonly CapacityUsed?: number | null;
  readonly CapacitySizePrecise?: string | number | null;
  readonly CapacitySize?: number | null;
  // Cadence + expiry.
  readonly CycleStartTime?: string | number | null;
  readonly CycleEndTime?: string | number | null;
  readonly DeductionEndTime?: string | number | null;
  readonly [key: string]: unknown;
}

/** A bonus window whose expiry trails the cycle end by more than this is a refill. */
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

/**
 * Handles Date | seconds/ms | numeric string | ISO → ISO string.
 *
 * Values below 1e12 are read as seconds; the upstream mixes both units across
 * accounts, so the magnitude decides rather than the field.
 */
export function parseBillingResetTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (/^\d+$/.test(trimmed)) {
        const timestamp = Number(trimmed);
        if (!Number.isFinite(timestamp)) return null;
        return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString();
      }
      const d = new Date(trimmed);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Prefer the `*Precise` string field (exact), fall back to the numeric one. */
export function billingNum(precise: unknown, plain: unknown): number {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

/** Cadence label derived from the refill cycle's own span. */
function refillCadence(acc: TencentBillingAccount): string {
  const start = parseBillingResetTime(acc.CycleStartTime);
  const end = parseBillingResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

/**
 * Resolves the bearer secret from a stored credential.
 *
 * The same account can be stored as a bare API key or as the OAuth envelope
 * JSON (`{accessToken, apiKey, token, ...}`), so both shapes resolve here and a
 * non-JSON credential passes through unchanged.
 */
function resolveBearerToken(credential: string): string | null {
  const trimmed = credential.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rec = asRecord(parsed);
      if (rec) {
        const candidate =
          asText(rec.accessToken) ??
          asText(rec.access_token) ??
          asText(rec.apiKey) ??
          asText(rec.api_key) ??
          asText(rec.token);
        if (candidate) return candidate;
      }
    } catch {
      // fall through to raw credential
    }
  }
  return trimmed;
}

/**
 * Reads `data.Response.Data.Accounts` (the double-wrapped Tencent envelope).
 *
 * The exact path is tried first; the lowercase and single-wrapped variants are
 * accepted because the two regional gateways differ in casing.
 */
function extractBillingAccounts(parsed: unknown): TencentBillingAccount[] {
  const root = asRecord(parsed) ?? {};
  const outerData = asRecord(root.data) ?? root;
  const responseRecord =
    asRecord(outerData["Response"]) ?? asRecord(outerData["response"]) ?? outerData;
  const innerData =
    asRecord(responseRecord["Data"]) ?? asRecord(responseRecord["data"]) ?? responseRecord;
  const rawAccounts = innerData["Accounts"] ?? innerData["accounts"] ?? [];
  if (!Array.isArray(rawAccounts)) return [];
  return rawAccounts
    .map((item) => asRecord(item) as TencentBillingAccount | null)
    .filter((v): v is TencentBillingAccount => v !== null);
}

function usedPercent(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const pct = (used / total) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

function buildBillingWindows(
  accounts: readonly TencentBillingAccount[],
  defaultPlan: string,
): { plan: string; windows: ProviderQuotaWindow[] } {
  const cycleEndMs = (acc: TencentBillingAccount): number => {
    const r = parseBillingResetTime(acc.CycleEndTime);
    return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
  };
  const isRefill = (acc: TencentBillingAccount): boolean => {
    const ce = cycleEndMs(acc);
    const parsedDeductionEnd = parseBillingResetTime(acc.DeductionEndTime);
    const de = parsedDeductionEnd ? new Date(parsedDeductionEnd).getTime() : Number.NaN;
    return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
  };
  const byExpiry = (a: TencentBillingAccount, b: TencentBillingAccount): number =>
    cycleEndMs(a) - cycleEndMs(b);

  const refills = [...accounts].filter(isRefill).sort(byExpiry);
  const bonuses = [...accounts].filter((a) => !isRefill(a)).sort(byExpiry);

  const windows: ProviderQuotaWindow[] = [];
  const seenRefill: Record<string, number> = {};

  for (const acc of refills) {
    const base = refillCadence(acc);
    seenRefill[base] = (seenRefill[base] || 0) + 1;
    const label = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
    const used = billingNum(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed);
    const total = billingNum(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize);
    const resetAt = parseBillingResetTime(acc.CycleEndTime);
    const pct = usedPercent(used, total);
    // Kind encodes recurring semantics + cadence for Contract consumers that
    // do not read the optional `recurring` field. Keep label human-readable.
    const kind = `quota:${base.toLowerCase()}${seenRefill[base] > 1 ? `_${seenRefill[base]}` : ""}`;
    const w = percentWindow(kind, label, pct, resetAt, used, total);
    windows.push({ ...w, kind, label, recurring: true });
  }

  bonuses.forEach((acc, idx) => {
    const label = `Bonus Pack ${idx + 1}`;
    const kind = `bonus:${idx + 1}`;
    const used = billingNum(acc.CapacityUsedPrecise, acc.CapacityUsed);
    const total = billingNum(acc.CapacitySizePrecise, acc.CapacitySize);
    const resetAt = parseBillingResetTime(acc.CycleEndTime);
    const pct = usedPercent(used, total);
    const w = percentWindow(kind, label, pct, resetAt, used, total);
    windows.push({ ...w, kind, label, recurring: false });
  });

  const basePkg = (refills[0] ?? accounts[0] ?? {}) as TencentBillingAccount;
  const plan = asText(basePkg.PackageName) ?? asText(basePkg.SubProductName) ?? defaultPlan;

  return { plan, windows };
}

/** Everything provider-specific about one Tencent billing-meter read. */
export interface TencentBillingFetchOptions {
  /** Canonical source id reported in the result. */
  readonly source: string;
  /** Operator-facing provider name used in every message. */
  readonly display: string;
  /** `{base}/v2/billing/meter/get-user-resource` for this provider. */
  readonly url: string;
  /** Provider transport/identity headers; `Authorization` is added here. */
  readonly headers: Record<string, string>;
  readonly credential: string;
  readonly fetcher: FetchLike;
  /** Plan name used when the payload carries neither package field. */
  readonly defaultPlan: string;
}

/**
 * Fetches one provider's quota from the Tencent billing endpoint.
 *
 * Auth is always `Authorization: Bearer <credential>` — both `api_key` and
 * `oauth` accounts store a secret the caller has already resolved. Recurring
 * semantics ride on the `kind` prefix (`quota:` vs `bonus:`) plus the optional
 * `recurring` boolean, so Contract consumers that ignore `recurring` still see
 * the split.
 */
export async function fetchTencentBillingQuota(
  options: TencentBillingFetchOptions,
): Promise<ProviderQuotaResult> {
  const { source, display, url, headers, credential, fetcher, defaultPlan } = options;
  const bearer = resolveBearerToken(credential);
  if (!bearer) {
    return { source, plan: null, windows: [], error: `${display} credential not available.` };
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        ...headers,
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { source, plan: null, windows: [], error: cleanError(error) };
  }

  if (response.status === 401 || response.status === 403) {
    return { source, plan: null, windows: [], error: `${display} credential invalid or expired.` };
  }
  if (!response.ok) {
    return {
      source,
      plan: null,
      windows: [],
      error: `${display} quota API error (${response.status}).`,
    };
  }

  let textBody: string;
  try {
    textBody = await response.text();
  } catch (error) {
    return { source, plan: null, windows: [], error: cleanError(error) };
  }

  let json: unknown = null;
  try {
    json = textBody.length > 0 ? JSON.parse(textBody) : null;
  } catch {
    return {
      source,
      plan: null,
      windows: [],
      error: cleanError(new Error(`${display} quota response returned invalid JSON`)),
    };
  }

  const envelope = asRecord(json);
  // A non-zero `code` is a provider-side error even on HTTP 200.
  if (envelope !== null && "code" in envelope) {
    const code = Number(envelope["code"]);
    if (Number.isFinite(code) && code !== 0) {
      const msgText = asText(envelope["msg"]) ?? "unknown";
      return { source, plan: null, windows: [], error: `${display} quota error: ${msgText}` };
    }
  }

  const accounts = extractBillingAccounts(json);
  if (accounts.length === 0) {
    return { source, plan: null, windows: [], error: `${display} connected. No credit package found.` };
  }

  try {
    const { plan, windows } = buildBillingWindows(accounts, defaultPlan);
    return { source, plan, windows, error: null };
  } catch (error) {
    return {
      source,
      plan: null,
      windows: [],
      error: cleanError(error) || `${display} error: ${String(error)}`,
    };
  }
}

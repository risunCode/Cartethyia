import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";
import { getJson, number, percentWindow, record, text } from "../../quota/quota-contracts";

const ZAI_QUOTA_URL = "https://api.z.ai/api/paas/v4/quota";
const ZAI_BILLING_URL = "https://api.z.ai/api/coding/paas/v4/billing";
const ZAI_SOURCE = "zai";
const ZAI_NO_DATA_ERROR = "No ZAI plan";
/** ZAI answers 404 when the account has no coding plan; word-bounded so longer
 * digit runs (e.g. `14040`) fall through to the billing endpoint instead. */
const ZAI_MISSING_PLAN_PATTERN = /\b404\b/;

/**
 * Parses ZAI's fraction/absolute quota shape: unwrap `data`, resolve a used
 * percent from remaining/used/limit/percent keys, synthesize one window.
 */
function parseZaiQuota(body: unknown): ProviderQuotaResult {
  const root = record(body) ?? {};
  const data = record(root.data) ?? root;
  const nested = record(data["quota"]);
  const plan = text(data["plan"]) ?? text(data["tier"]);
  const remaining =
    number(data["remainingFraction"]) ??
    number(data["remaining"]) ??
    number(nested?.["remainingFraction"]);
  const used = number(data["used"]);
  const limit = number(data["limit"]);
  const percent = number(data["percentUsed"]) ?? number(nested?.["percentUsed"]);
  const fractionUsed =
    remaining !== null && limit !== null && limit > 0 && remaining > 1
      ? ((limit - remaining) / limit) * 100
      : remaining !== null
        ? (1 - Math.min(1, Math.max(0, remaining))) * 100
        : null;
  const ratioUsed = used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null;
  const usedPercent = fractionUsed ?? ratioUsed ?? percent;
  if (usedPercent === null)
    return { source: ZAI_SOURCE, plan: null, windows: [], error: ZAI_NO_DATA_ERROR };
  return {
    source: ZAI_SOURCE,
    plan: plan ?? "Z.AI",
    windows: [percentWindow("quota", "Quota", usedPercent, null, used, limit)],
    error: null,
  };
}

/**
 * Fetches the ZAI coding plan: quota endpoint first, billing as fallback, with
 * a 404 short-circuiting to the no-plan result.
 */
export async function fetchZaiQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const token = credential.trim();
  if (!token) throw new Error("ZAI credential is empty.");
  const headers = { authorization: `Bearer ${token}` };
  let lastError: unknown;
  for (const endpoint of [ZAI_QUOTA_URL, ZAI_BILLING_URL]) {
    try {
      const body = await getJson(endpoint, headers, fetcher);
      return parseZaiQuota(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ZAI_MISSING_PLAN_PATTERN.test(message))
        return { source: ZAI_SOURCE, plan: null, windows: [], error: ZAI_NO_DATA_ERROR };
      lastError = error;
    }
  }
  throw lastError;
}

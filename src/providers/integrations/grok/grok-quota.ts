import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { isoDate, number, percentWindow, record, text } from "../../quota/quota-contracts";
import { getGrokVersion, buildGrokAuthUserAgent, refreshGrokVersion } from "../../operations/client-versions";
import { decodeGrokCreditsFrame } from "./grok-quota-frame";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const BILLING_SOURCE = "cli-chat-proxy.grok.com/v1/billing";
const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const GRPC_CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GRPC_EMPTY_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

/**
 * Auth headers shared by every xAI billing/userinfo call: bearer token plus
 * the CLI client identity the gateway gates on.
 */
function xaiHeaders(accessToken: string): Record<string, string> {
  const version = getGrokVersion();
  return {
    authorization: `Bearer ${accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": version,
    "user-agent": buildGrokAuthUserAgent(version),
  };
}
interface XaiBillingPayload {
  currentPeriod?: unknown;
  creditUsagePercent?: unknown;
  productUsage?: unknown;
  onDemandCap?: unknown;
  onDemandUsed?: unknown;
  billingPeriodStart?: unknown;
  billingPeriodEnd?: unknown;
  monthlyLimit?: unknown;
  used?: unknown;
  subscriptionTier?: unknown;
  user?: unknown;
}

function parsePayload(value: string): XaiBillingPayload {
  const payload: unknown = JSON.parse(value);
  // Live billing wraps usage in a `config` envelope (free-tier shape);
  // paid shapes may carry the fields top-level — read the envelope first.
  const parsed = record(payload);
  return ((parsed && record(parsed.config)) ?? parsed ?? {}) as XaiBillingPayload;
}

function billingNumber(value: unknown): number | null {
  const nested = record(value);
  return number(nested?.val ?? value);
}

function period(raw: unknown): { start: string; end: string } | undefined {
  const value = record(raw);
  const type = text(value?.type);
  if (type !== null && !type.toUpperCase().includes("WEEK")) return undefined;
  const start = isoDate(value?.start);
  const end = isoDate(value?.end);
  return start && end && Date.parse(end) > Date.parse(start) ? { start, end } : undefined;
}

function buildWeeklyWindows(payload: XaiBillingPayload): ProviderQuotaWindow[] {
  const current = period(payload.currentPeriod);
  const creditPercent = billingNumber(payload.creditUsagePercent);
  if (!current) return [];
  if (creditPercent === null || creditPercent < 0 || creditPercent > 100) {
    // Free-tier billing states the period but no usage percent: emit the
    // window with the reset date and null percents (the dashboard renders
    // the countdown without inventing a number) instead of empty windows.
    return [percentWindow("1w", "SuperGrok Weekly Credits", null, current.end)];
  }
  const windows: ProviderQuotaWindow[] = [
    percentWindow("1w", "SuperGrok Weekly Credits", creditPercent, current.end, creditPercent, 100),
  ];
  if (Array.isArray(payload.productUsage)) {
    for (const entry of payload.productUsage) {
      const value = record(entry);
      const product = text(value?.product);
      const percent = billingNumber(value?.usagePercent);
      windows.push(percentWindow(`product:${product}:1w`, `${product} (Weekly)`, percent, current.end, percent, 100));
    }
  }
  return windows;
}

function buildMonthlyWindows(payload: XaiBillingPayload): ProviderQuotaWindow[] {
  const start = isoDate(payload.billingPeriodStart);
  const end = isoDate(payload.billingPeriodEnd);
  const limit = billingNumber(payload.monthlyLimit);
  const used = billingNumber(payload.used);
  if (!start || !end || limit === null || limit <= 0 || used === null || used < 0) return [];
  const usedPercent = Math.min(100, (used / limit) * 100);
  return [percentWindow("1mo", "SuperGrok Monthly Included", usedPercent, end, used, limit)];
}

function addOnDemandWindow(windows: ProviderQuotaWindow[], payload: XaiBillingPayload): void {
  const cap = billingNumber(payload.onDemandCap);
  const used = billingNumber(payload.onDemandUsed);
  if (cap === null || cap <= 0 || used === null || used < 0) return;
  windows.push(percentWindow("on-demand", "On-demand", Math.min(100, (used / cap) * 100), null, used, cap));
}

async function fetchGrpcCredits(
  accessToken: string,
  fetcher: FetchLike,
): Promise<{ percentUsed: number; resetAt: string | null } | null> {
  try {
    const response = await fetcher(GRPC_CREDITS_URL, {
      method: "POST",
      headers: {
        ...xaiHeaders(accessToken),
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
      },
      body: GRPC_EMPTY_FRAME,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return decodeGrokCreditsFrame(new Uint8Array(arrayBuffer));
  } catch {
    return null;
  }
}

async function fetchUser(
  accessToken: string,
  fetcher: FetchLike,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(USER_URL, {
      headers: { ...xaiHeaders(accessToken), accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return record((await response.json()) as unknown);
  } catch {
    return null;
  }
}

/** Fetches Grok Build subscription billing, including weekly and unified-monthly fallbacks. */
export async function fetchGrokQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const accessToken = credential.trim();
  if (!accessToken) throw new Error("grok quota requires an OAuth access token");
  refreshGrokVersion();
  const response = await fetcher(BILLING_URL, {
    headers: { ...xaiHeaders(accessToken), accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Grok Build billing request failed (${response.status}): ${raw.slice(0, 500)}`);
  const payload = parsePayload(raw);
  const windows = buildWeeklyWindows(payload);
  if (windows.length === 0 || windows.every((w) => w.usedPercent === null)) {
    const grpc = await fetchGrpcCredits(accessToken, fetcher);
    if (grpc) {
      const idx = windows.findIndex((w) => w.label.includes("Weekly"));
      const grpcWindow = percentWindow("1w", "SuperGrok Weekly Credits", grpc.percentUsed, grpc.resetAt, grpc.percentUsed, 100);
      if (idx >= 0) windows[idx] = grpcWindow;
      else windows.unshift(grpcWindow);
    }
  }
  if (windows.length === 0) windows.push(...buildMonthlyWindows(payload));
  addOnDemandWindow(windows, payload);
  const user = await fetchUser(accessToken, fetcher);
  const userRecord = record(user?.user);
  const plan =
    text(user?.subscriptionTier) ??
    text(payload.subscriptionTier) ??
    text(userRecord?.subscriptionTier) ??
    "SuperGrok";
  return { source: "grok", plan, windows, error: null };
}

export { BILLING_SOURCE as GROK_BILLING_SOURCE };

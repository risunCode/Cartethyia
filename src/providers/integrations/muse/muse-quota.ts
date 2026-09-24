import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import { getJson, isoDate, number, percentWindow, record } from "../../quota/quota-contracts";
import {
  MUSE_CODE_API_VERSION,
  MUSE_CODE_KEY_URL,
} from "./muse-oauth";
import { parseMuseCodeCredential } from "./muse";

const SOURCE = "api.meta.ai/muse-code/key";

interface MuseSubscriptionWindow {
  used_percent?: unknown;
  usedPercent?: unknown;
  resets_at?: unknown;
  resetsAt?: unknown;
  window_duration_mins?: unknown;
}

interface MuseSubscriptionUsage {
  window?: unknown;
  weekly?: unknown;
}

interface MuseKeyQuotaResponse {
  subs_usage?: unknown;
  subs_tier_id?: unknown;
  subs_tier_name?: unknown;
  is_subs_active?: unknown;
}

function parseWindow(value: unknown): MuseSubscriptionWindow | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  return raw as MuseSubscriptionWindow;
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "Hour" : "Hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "Minute" : "Minutes"}`;
}

function windowId(minutes: number | null, fallback: string): string {
  return minutes !== null && minutes > 0 ? `${minutes}m` : fallback;
}

function usedPercent(window: MuseSubscriptionWindow): number | null {
  return number(window.used_percent ?? window.usedPercent);
}

function buildWindows(
  usage: MuseSubscriptionUsage,
): readonly ProviderQuotaWindow[] {
  const windows: ProviderQuotaWindow[] = [];
  const rolling = parseWindow(usage.window);
  if (rolling) {
    const minutesValue = number(rolling.window_duration_mins);
    const minutes =
      minutesValue !== null && minutesValue > 0 ? Math.round(minutesValue) : null;
    const used = usedPercent(rolling);
    if (used !== null) {
      windows.push(
        percentWindow(
          windowId(minutes, "rolling"),
          windowLabel(minutes, "Rolling Window"),
          used,
          isoDate(rolling.resets_at ?? rolling.resetsAt),
          used,
          100,
        ),
      );
    }
  }
  const weekly = parseWindow(usage.weekly);
  if (weekly) {
    const used = usedPercent(weekly);
    if (used !== null) {
      windows.push(
        percentWindow("1w", "Weekly", used, isoDate(weekly.resets_at ?? weekly.resetsAt), used, 100),
      );
    }
  }
  return windows;
}

/**
 * Fetches Muse's subscription windows from the same key endpoint used by the
 * post-device-code exchange. The API key is intentionally never sent: the
 * endpoint authenticates the quota read with the OAuth access token embedded
 * in the encrypted credential envelope.
 */
export async function fetchMuseQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const parsed = parseMuseCodeCredential(credential);
  const payload = (await getJson(
    MUSE_CODE_KEY_URL,
    {
      "x-api-version": MUSE_CODE_API_VERSION,
      authorization: `Bearer ${parsed.oauthAccessToken}`,
    },
    fetcher,
    {},
  )) as MuseKeyQuotaResponse;
  if (payload.is_subs_active === false) {
    return {
      source: "muse",
      plan: null,
      windows: [],
      error: "Muse Code subscription is inactive",
    };
  }
  const rawUsage = record(payload.subs_usage) as MuseSubscriptionUsage | undefined;
  const windows = rawUsage ? buildWindows(rawUsage) : [];
  const tier =
    (typeof payload.subs_tier_name === "string" && payload.subs_tier_name.trim()) ||
    (typeof payload.subs_tier_id === "string" && payload.subs_tier_id.trim()) ||
    "Muse Code";
  return {
    source: "muse",
    plan: tier,
    windows,
    error: null,
  };
}

export { SOURCE as MUSE_QUOTA_SOURCE };

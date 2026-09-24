import { createHash } from "node:crypto";
import { TtlCache } from "../../../runtime/ttl-cache";
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { authCredential, getJson, percentWindow, record, text, number, isoDate } from "../../quota/quota-contracts";
import { parseQuotaWindows } from "../../quota/quota-window-parser";
import { CLAUDE_CODE_USER_AGENT } from "./claude-fingerprint";

export const claudeCodeOAuthBetas = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
];

/** Fixed per-key windows Claude reports alongside the dynamic `limits` array. */
const CLAUDE_FIXED_WINDOWS: readonly {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
}[] = [
  { key: "five_hour", kind: "session", label: "5 Hour" },
  { key: "seven_day", kind: "weekly", label: "7 Day" },
  { key: "seven_day_opus", kind: "weekly_opus", label: "7 Day (Opus)" },
  { key: "seven_day_sonnet", kind: "weekly_sonnet", label: "7 Day (Sonnet)" },
];

/** Display-kind fallback for generic limit scopes the API may report. */
const LIMIT_SCOPE_LABELS: Readonly<Record<string, string>> = {
  session: "5 Hour",
  weekly_all: "7 Day",
};

/** Parses the dynamic `limits` array (per-model weekly windows). */
function limitsWindows(payload: unknown): readonly ProviderQuotaWindow[] {
  const limits = record(payload)?.limits;
  if (!Array.isArray(limits)) return [];
  const windows: ProviderQuotaWindow[] = [];
  for (const rawLimit of limits) {
    const limit = record(rawLimit);
    const kind = text(limit?.kind);
    if (!limit || !kind) continue;
    const displayName = text(record(record(limit.scope)?.model)?.display_name);
    const scoped = LIMIT_SCOPE_LABELS[kind];
    const label =
      scoped !== undefined
        ? displayName
          ? `${scoped} (${displayName})`
          : scoped
        : displayName
          ? `7 Day (${displayName})`
          : kind.replace(/_/g, " ");
    const utilization = number(limit.percent) ?? number(limit.utilization);
    if (utilization === null && isoDate(limit.resets_at) === null) continue;
    windows.push(percentWindow(kind, label, utilization, isoDate(limit.resets_at)));
  }
  // Usage spend in absolute dollars, when the API reports it alongside (or
  // instead of) percentage windows.
  const spend = number(record(payload)?.spend) ?? number(record(payload)?.extra_usage);
  const spendLimit =
    number(record(payload)?.spend_limit) ?? number(record(payload)?.extra_usage_limit);
  if (spend !== null) {
    windows.push(
      percentWindow(
        "spend",
        "Spend (USD)",
        spendLimit !== null && spendLimit > 0 ? (spend / spendLimit) * 100 : null,
        null,
        spend,
        spendLimit,
      ),
    );
  }
  return windows;
}

function parseClaudeQuota(body: unknown): ProviderQuotaResult {
  return parseQuotaWindows(
    body,
    CLAUDE_FIXED_WINDOWS.map(({ key, kind, label }) => ({
      kind,
      label,
      usedPercentPaths: [
        [key, "utilization"],
        [key, "percent"],
      ],
      resetPaths: [[key, "resets_at"]],
      emitWithoutPercent: true,
    })),
    {
      source: "claude",
      planPaths: [["plan_type"], ["plan"]],
      transform: (value) => record(value) ?? {},
      extraWindows: limitsWindows,
    },
  );
}

export async function fetchClaudeQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const key = createHash("sha256").update(credential).digest("hex");
  const cached = quotaCache.get(key);
  if (cached !== undefined) return cached;
  if (quotaCooldown.get(key) !== undefined) {
    throw new Error("Quota endpoint rejected request: rate limited (cooled down)");
  }
  const access = text(authCredential(credential).accessToken) ?? credential;
  let lastStatus = 0;
  const observing: FetchLike = (async (url, init) => {
    const response = await fetcher(url, init);
    lastStatus = response.status;
    return response;
  }) as FetchLike;
  try {
    const body = await getJson(
      "https://api.anthropic.com/api/oauth/usage",
      {
        authorization: `Bearer ${access}`,
        "anthropic-beta": claudeCodeOAuthBetas.join(","),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "user-agent": CLAUDE_CODE_USER_AGENT,
        accept: "application/json, text/plain, */*",
        "accept-encoding": "gzip, compress, deflate, br",
        connection: "keep-alive",
      },
      observing,
    );
    const result = parseClaudeQuota(body);
    quotaCache.set(key, result);
    return result;
  } catch (error: unknown) {
    // Hammering the usage endpoint on every call is its own rate-limit
    // risk: back off briefly after a 429 instead of retrying into it.
    if (lastStatus === 429) quotaCooldown.set(key, true);
    throw error;
  }
}

/**
 * Bounded per-credential quota cache (5 min) plus a short 429 cooldown
 * (3 min). Keys are credential hashes, never raw secrets; both caches are
 * capped so credential fan-out cannot pin memory.
 */
const QUOTA_CACHE_TTL_MS = 5 * 60_000;
const QUOTA_COOLDOWN_MS = 3 * 60_000;
const QUOTA_CACHE_MAX_ENTRIES = 256;
const quotaCache = new TtlCache<ProviderQuotaResult>({
  ttlMs: QUOTA_CACHE_TTL_MS,
  maxEntries: QUOTA_CACHE_MAX_ENTRIES,
});
// The cooldown is an absolute window (`until = now + QUOTA_COOLDOWN_MS`), not a
// TTL from read time, so it is a sentinel whose own TTL *is* that window: the
// entry lives for exactly the cooldown and is gone the moment it closes.
const quotaCooldown = new TtlCache<true>({
  ttlMs: QUOTA_COOLDOWN_MS,
  maxEntries: QUOTA_CACHE_MAX_ENTRIES,
});

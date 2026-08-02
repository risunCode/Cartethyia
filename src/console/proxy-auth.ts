/**
 * Proxy API key enforcement (PROXY_AUTH_MODE=api_key) — validates the
 * x-api-key header (or Authorization: Bearer), enforces per-key rpm /
 * daily + monthly token limits, concurrent caps, and provider/model ACL.
 * In "open" mode every request is anonymous. Also enforces IP + CIDR ACL
 * for the proxy scope (REQ-15).
 */

import { openAIClientError } from "../http/errors";
import { identifyClient } from "../http/traffic";
import { config } from "../config";
import { findApiKeyBySecret, sumOneTimeTokensForKey, touchApiKey, type ApiKeyPublic } from "./db/repos/api-keys";
import { purgeKeyTokenAccumulator, sumDailyTokensForKey, sumMonthlyTokensForKey } from "./db/repos/usage";
import { getRuntimeSettings } from "./runtime";
import { checkAccess } from "./db/repos/access";
import { extractPresentedApiKey, isModelAllowedForKey } from "./key-acl";
import { purgeKeyInFlightState, reserveTokensForKey, getReservedTokensForKey } from "./tracking/key-in-flight";

export { extractPresentedApiKey, isModelAllowedForKey, filterModelsForKey } from "./key-acl";

/** Conservative per-request token estimate reserved against a key's daily/monthly limit for the request's lifetime - matches the `max_tokens` default used elsewhere in this codebase (openai-anthropic.ts, model-studio.ts). */
const RESERVED_TOKENS_ESTIMATE = 4096;

export interface ProxyAuthOutcome {
  error: { status: number; body: unknown } | null;
  key: ApiKeyPublic | null;
  /** Non-zero when a token budget was checked and reserved against. */
  tokensReserved: number;
  /** Keeps the reservation until measured usage is available for a one-time budget. */
  holdTokenReservation?: boolean;
}

const RPM_WINDOW_SECONDS = 60;
const MAX_RPM_BUCKETS = 10_000;

interface RpmSlot {
  second: number;
  count: number;
}

interface RpmBucket {
  slots: RpmSlot[];
  total: number;
}

const rpmBuckets = new Map<string, RpmBucket>();

function createRpmBucket(): RpmBucket {
  return {
    slots: Array.from({ length: RPM_WINDOW_SECONDS }, () => ({ second: -1, count: 0 })),
    total: 0,
  };
}

function getRpmBucket(keyId: string): RpmBucket {
  const existing = rpmBuckets.get(keyId);
  if (existing) {
    rpmBuckets.delete(keyId);
    rpmBuckets.set(keyId, existing);
    return existing;
  }

  const bucket = createRpmBucket();
  rpmBuckets.set(keyId, bucket);
  while (rpmBuckets.size > MAX_RPM_BUCKETS) {
    const oldest = rpmBuckets.keys().next();
    if (oldest.done) break;
    rpmBuckets.delete(oldest.value);
  }
  return bucket;
}

function pruneRpmBucket(bucket: RpmBucket, nowSecond: number): void {
  const cutoff = nowSecond - RPM_WINDOW_SECONDS;
  for (const slot of bucket.slots) {
    if (slot.second <= cutoff) {
      bucket.total -= slot.count;
      slot.second = -1;
      slot.count = 0;
    }
  }
}

/** Removes a deleted API key's rate-limit history immediately. */
export function purgeRateLimitState(keyId: string): void {
  rpmBuckets.delete(keyId);
  purgeKeyTokenAccumulator(keyId);
  purgeKeyInFlightState(keyId);
}

/** Test-only current RPM bucket count. */
export function proxyRateLimitStateSizeForTests(): number {
  return rpmBuckets.size;
}

function checkRpm(key: ApiKeyPublic, nowMs: number): boolean {
  if (!key.rateLimitRpm) return true;
  const nowSecond = Math.floor(nowMs / 1_000);
  const bucket = getRpmBucket(key.id);
  pruneRpmBucket(bucket, nowSecond);

  const slot = bucket.slots[nowSecond % RPM_WINDOW_SECONDS]!;
  if (slot.second !== nowSecond) {
    bucket.total -= slot.count;
    slot.second = nowSecond;
    slot.count = 0;
  }
  if (bucket.total >= key.rateLimitRpm) return false;

  slot.count += 1;
  bucket.total += 1;
  return true;
}

function checkAllowlists(key: ApiKeyPublic, model: string | undefined): { ok: boolean; reason?: string } {
  if (!model) return { ok: true };
  if (!isModelAllowedForKey(key, model)) {
    const parsed = model.includes("/") ? model.split("/").pop() ?? model : model;
    return { ok: false, reason: `model "${parsed}" is not allowed for this key` };
  }
  return { ok: true };
}

export function enforceProxyAuth(model: string | undefined, request: Request, directIp?: string): ProxyAuthOutcome {
  // ACL gate (REQ-15) — before any key validation.
  const client = identifyClient(request.headers, directIp, config.traffic.trustProxy);
  if (!checkAccess("proxy", client.ip === "unknown" ? undefined : client.ip)) {
    return {
      error: {
        status: 403,
        body: openAIClientError(403, "authentication_error", "Your IP is not allowed to use this proxy."),
      },
      key: null,
      tokensReserved: 0,
    };
  }

  const runtime = getRuntimeSettings();
  if (runtime.proxyAuthMode === "open") return { error: null, key: null, tokensReserved: 0 };

  const presented = extractPresentedApiKey(request);
  const key = presented ? findApiKeyBySecret(presented) : null;
  if (!key || !key.active) {
    return {
      error: {
        status: 401,
        body: openAIClientError(401, "authentication_error", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy."),
      },
      key: null,
      tokensReserved: 0,
    };
  }

  if (!checkRpm(key, Date.now())) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key exceeded its per-minute request limit.") },
      key: null,
      tokensReserved: 0,
    };
  }

  // Reservation closes the TOCTOU window: `sumDailyTokensForKey` only sees
  // usage already committed after a response finishes, so N concurrent
  // requests on the same key would otherwise all read the same committed
  // sum and all pass. Adding the in-flight reservation to that sum before
  // comparing means the 2nd, 3rd, ... concurrent request sees the 1st's
  // reservation immediately - and since nothing here awaits, this whole
  // check+reserve sequence is atomic with respect to other requests.
  const reservedTokens = getReservedTokensForKey(key.id);
  const dailyUsed = key.dailyTokenLimit ? sumDailyTokensForKey(key.id) : 0;
  const monthlyUsed = key.monthlyTokenLimit ? sumMonthlyTokensForKey(key.id) : 0;
  const oneTimeUsed = key.oneTimeTokenLimit ? sumOneTimeTokensForKey(key.id) : 0;
  if (key.dailyTokenLimit && dailyUsed + reservedTokens >= key.dailyTokenLimit) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key reached its daily token limit.") },
      key: null,
      tokensReserved: 0,
    };
  }

  if (key.monthlyTokenLimit && monthlyUsed + reservedTokens >= key.monthlyTokenLimit) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key reached its monthly token limit.") },
      key: null,
      tokensReserved: 0,
    };
  }

  if (key.oneTimeTokenLimit && oneTimeUsed + reservedTokens >= key.oneTimeTokenLimit) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key has used its one-time token budget.") },
      key: null,
      tokensReserved: 0,
    };
  }

  const allow = checkAllowlists(key, model);
  if (!allow.ok) {
    return { error: { status: 403, body: openAIClientError(403, "authentication_error", allow.reason ?? "not allowed for this key") }, key: null, tokensReserved: 0 };
  }

  touchApiKey(key.id);
  const remainingBudgets = [
    key.dailyTokenLimit ? key.dailyTokenLimit - dailyUsed - reservedTokens : null,
    key.monthlyTokenLimit ? key.monthlyTokenLimit - monthlyUsed - reservedTokens : null,
    key.oneTimeTokenLimit ? key.oneTimeTokenLimit - oneTimeUsed - reservedTokens : null,
  ].filter((value): value is number => value !== null);
  const tokensReserved = remainingBudgets.length > 0 ? Math.min(RESERVED_TOKENS_ESTIMATE, ...remainingBudgets) : 0;
  if (tokensReserved > 0) reserveTokensForKey(key.id, tokensReserved);
  return { error: null, key, tokensReserved, holdTokenReservation: key.oneTimeTokenLimit !== null };
}

/**
 * Resolves an optional API key for read-only discovery endpoints.
 * In api_key mode a valid active key is required; in open mode the key is optional.
 */
export function resolveModelsApiKey(request: Request): ProxyAuthOutcome {
  const runtime = getRuntimeSettings();
  const presented = extractPresentedApiKey(request);
  if (!presented) {
    if (runtime.proxyAuthMode === "api_key") {
      return {
        error: {
          status: 401,
          body: openAIClientError(401, "authentication_error", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy."),
        },
        key: null,
        tokensReserved: 0,
      };
    }
    return { error: null, key: null, tokensReserved: 0 };
  }

  const key = findApiKeyBySecret(presented);
  if (!key || !key.active) {
    return {
      error: {
        status: 401,
        body: openAIClientError(401, "authentication_error", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy."),
      },
      key: null,
      tokensReserved: 0,
    };
  }

  touchApiKey(key.id);
  return { error: null, key, tokensReserved: 0 };
}

/** Test-only: clear rpm buckets. */
export function resetProxyAuthForTests(): void {
  rpmBuckets.clear();
}

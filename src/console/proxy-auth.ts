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
import { findApiKeyBySecret, touchApiKey, type ApiKeyPublic } from "./db/repos/api-keys";
import { sumDailyTokensForKey, sumMonthlyTokensForKey } from "./db/repos/usage";
import { getRuntimeSettings } from "./runtime";
import { checkAccess } from "./db/repos/access";
import { extractPresentedApiKey, isModelAllowedForKey } from "./key-acl";
import { purgeKeyInFlightState } from "./tracking/key-in-flight";

export { extractPresentedApiKey, isModelAllowedForKey, filterModelsForKey } from "./key-acl";

export interface ProxyAuthOutcome {
  error: { status: number; body: unknown } | null;
  key: ApiKeyPublic | null;
}

const rpmBuckets = new Map<string, number[]>();
const MAX_RPM_BUCKETS = 10_000;

function setRpmBucket(keyId: string, hits: number[]): void {
  rpmBuckets.delete(keyId);
  rpmBuckets.set(keyId, hits);
  if (rpmBuckets.size > MAX_RPM_BUCKETS) rpmBuckets.delete(rpmBuckets.keys().next().value!);
}

/** Removes a deleted API key's rate-limit history immediately. */
export function purgeRateLimitState(keyId: string): void {
  rpmBuckets.delete(keyId);
  purgeKeyInFlightState(keyId);
}

/** Test-only current RPM bucket count. */
export function proxyRateLimitStateSizeForTests(): number {
  return rpmBuckets.size;
}

function checkRpm(key: ApiKeyPublic, nowMs: number): boolean {
  if (!key.rateLimitRpm) return true;
  const windowStart = nowMs - 60_000;
  const hits = (rpmBuckets.get(key.id) ?? []).filter((t) => t > windowStart);
  if (hits.length >= key.rateLimitRpm) {
    setRpmBucket(key.id, hits);
    return false;
  }
  hits.push(nowMs);
  setRpmBucket(key.id, hits);
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
    };
  }

  const runtime = getRuntimeSettings();
  if (runtime.proxyAuthMode === "open") return { error: null, key: null };

  const presented = extractPresentedApiKey(request);
  const key = presented ? findApiKeyBySecret(presented) : null;
  if (!key || !key.active) {
    return {
      error: {
        status: 401,
        body: openAIClientError(401, "authentication_error", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy."),
      },
      key: null,
    };
  }

  if (!checkRpm(key, Date.now())) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key exceeded its per-minute request limit.") },
      key: null,
    };
  }

  if (key.dailyTokenLimit && sumDailyTokensForKey(key.id) >= key.dailyTokenLimit) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key reached its daily token limit.") },
      key: null,
    };
  }

  if (key.monthlyTokenLimit && sumMonthlyTokensForKey(key.id) >= key.monthlyTokenLimit) {
    return {
      error: { status: 429, body: openAIClientError(429, "rate_limit_error", "This key reached its monthly token limit.") },
      key: null,
    };
  }

  const allow = checkAllowlists(key, model);
  if (!allow.ok) {
    return { error: { status: 403, body: openAIClientError(403, "authentication_error", allow.reason ?? "not allowed for this key") }, key: null };
  }

  touchApiKey(key.id);
  return { error: null, key };
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
      };
    }
    return { error: null, key: null };
  }

  const key = findApiKeyBySecret(presented);
  if (!key || !key.active) {
    return {
      error: {
        status: 401,
        body: openAIClientError(401, "authentication_error", "A valid x-api-key header (or Authorization: Bearer token) is required to use this proxy."),
      },
      key: null,
    };
  }

  touchApiKey(key.id);
  return { error: null, key };
}

/** Test-only: clear rpm buckets. */
export function resetProxyAuthForTests(): void {
  rpmBuckets.clear();
}

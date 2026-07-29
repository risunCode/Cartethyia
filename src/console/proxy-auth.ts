/**
 * Proxy API key enforcement (PROXY_AUTH_MODE=api_key) — validates the
 * x-api-key header (or Authorization: Bearer), enforces per-key rpm /
 * daily token limits and provider/model allowlists. In "open" mode every
 * request is anonymous. Also enforces IP + CIDR ACL for the proxy scope
 * (REQ-15).
 */

import { openAIClientError } from "../http/errors";
import { identifyClient } from "../http/traffic";
import { config } from "../config";
import { parseQualifiedModel } from "../routing/resolve";
import { findApiKeyBySecret, touchApiKey, type ApiKeyPublic } from "./db/repos/api-keys";
import { sumDailyTokensForKey } from "./db/repos/usage";
import { getRuntimeSettings } from "./runtime";
import { checkAccess } from "./db/repos/access";

export interface ProxyAuthOutcome {
  error: { status: number; body: unknown } | null;
  key: ApiKeyPublic | null;
}

const rpmBuckets = new Map<string, number[]>();

function checkRpm(key: ApiKeyPublic, nowMs: number): boolean {
  if (!key.rateLimitRpm) return true;
  const windowStart = nowMs - 60_000;
  const hits = (rpmBuckets.get(key.id) ?? []).filter((t) => t > windowStart);
  if (hits.length >= key.rateLimitRpm) {
    rpmBuckets.set(key.id, hits);
    return false;
  }
  hits.push(nowMs);
  rpmBuckets.set(key.id, hits);
  return true;
}

function checkAllowlists(key: ApiKeyPublic, model: string | undefined): { ok: boolean; reason?: string } {
  if (!model) return { ok: true };
  const parsed = parseQualifiedModel(model);
  const providerId = parsed.kind === "qualified" ? parsed.model.provider : null;
  const modelId = parsed.kind === "qualified" ? parsed.model.modelId : model;
  if (key.providerAllowlist && providerId && !key.providerAllowlist.includes(providerId)) {
    return { ok: false, reason: `provider "${providerId}" is not allowed for this key` };
  }
  if (key.modelAllowlist && !key.modelAllowlist.includes(modelId) && !key.modelAllowlist.includes(model)) {
    return { ok: false, reason: `model "${modelId}" is not allowed for this key` };
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

  const presented = request.headers.get("x-api-key") ??
    (request.headers.get("authorization")?.startsWith("Bearer ")
      ? request.headers.get("authorization")!.slice(7)
      : "");
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

  const allow = checkAllowlists(key, model);
  if (!allow.ok) {
    return { error: { status: 403, body: openAIClientError(403, "authentication_error", allow.reason ?? "not allowed for this key") }, key: null };
  }

  touchApiKey(key.id);
  return { error: null, key };
}

/** Test-only: clear rpm buckets. */
export function resetProxyAuthForTests(): void {
  rpmBuckets.clear();
}

import { describe, expect, test } from "bun:test";
import type { AffinityKey, NormalizedMessage, ProxyRequest } from "../src/application/contracts";
import { applyCachePlan, buildCachePlan, looksStableText, markCacheSections, type CachePlan } from "../src/application/cache";
import {
  expandCombo,
  MAX_MODEL_CHAIN_DEPTH,
  orderByRendezvous,
  parseModelReference,
  resolveAlias,
  resolveModelChain,
  rendezvousScore,
  type ComboDefinition,
  type ModelReferenceConfig,
} from "../src/application/routing";
import {
  calculateRateLimitBackoffMs,
  isOpaqueStatusBody,
  isUsageLimitOutcome,
  isUsageLimitStatus,
  matchesUsageLimitText,
  parseRateLimitReason,
} from "../src/application/rate-limit";
import { isIpLiteral, isPrivateUseName, isUnsafeIp, narrowNumber, normalizeHostname, normalizeStream } from "../src/application/protocols";
import { applyFilterRules, type FilterRuleConfig } from "../src/application/filter-rules";
import {
  MAX_REDIRECTS,
  RedirectPolicyError,
  fetchWithRedirectPolicy,
  resolveRedirectTarget,
} from "../src/security/redirect-policy";
import { isRouteAllowed } from "../src/security/access";
import {
  MAX_SSRF_URL_LENGTH,
  SsrfGuardError,
  assertPublicUrl,
  assertPublicUrlAtDispatch,
  isBlockedIp,
  validatePublicUrl,
} from "../src/security/ssrf-guard";
import { ApiKeyAdmission, estimateRequestTokens } from "../src/traffic/admission";
import {
  decrementInFlight,
  getInFlightCount,
  incrementInFlight,
  resetInFlightForTests,
  subscribeInFlight,
} from "../src/traffic/in-flight";
import { cancelScheduledGc, scheduleGlobalGc } from "../src/traffic/memory";
import { PerIpFlightTracker } from "../src/traffic/per-ip";
import { SlidingWindowRateLimiter } from "../src/traffic/rate-limiter";
import type { ApiKeyPublic, ApiKeyRepository } from "../src/storage";

const defaultLimits = {
  maxBodyBytes: 10_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};

function makeProxyRequest(overrides: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    model: "test-model",
    messages: [],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits: defaultLimits,
    ...overrides,
  };
}

function makeMessage(role: NormalizedMessage["role"], text: string): NormalizedMessage {
  return { role, content: [{ type: "text", text }] };
}

function makeApiKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test-key",
    keyPrefix: "sk-test",
    active: true,
    rateLimitRpm: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    oneTimeTokenLimit: null,
    oneTimeTokensUsed: 0,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    lastUsedAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function makeApiKeyRepo(spy: { consumed: number } = { consumed: 0 }): ApiKeyRepository {
  return {
    list: () => [],
    getById: () => null,
    getBySecret: () => null,
    credential: () => null,
    create: () => makeApiKey(),
    update: () => null,
    revoke: () => false,
    delete: () => false,
    touch: () => {},
    flushTouches: () => {},
    sumOneTimeTokensUsed: () => 0,
    consumeOneTimeTokens: (_id, tokens) => { spy.consumed += tokens; },
  };
}

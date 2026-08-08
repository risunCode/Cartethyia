/**
 * Outbound proxy pool configuration.
 *
 * Environment-backed for Wave A; Wave B persistence swaps in a repository-
 * backed ProxyPoolConfigStore behind the same interface.
 *
 * Environment format (ids use `[a-zA-Z0-9-]`; `-` maps to `_` in env suffixes):
 *   CARTETHYIA_PROXY_POOL_ENABLED=true|false          (default true)
 *   CARTETHYIA_PROXY_<ID>_URL=http://host:port        (required per proxy)
 *   CARTETHYIA_PROXY_<ID>_ENABLED=true|false          (default true)
 *   CARTETHYIA_PROXY_<ID>_MAX_CONCURRENCY=8           (default 8)
 *   CARTETHYIA_PROXY_<ID>_PRIORITY=0                  (default 0, higher first)
 *   CARTETHYIA_PROXY_<ID>_EXCLUDED_PROVIDERS=a,b      (comma-separated)
 */

export interface ProxyConfig {
  readonly id: string;
  readonly url: string;
  readonly isRelay?: boolean;
  readonly enabled: boolean;
  readonly maxConcurrency: number;
  readonly priority: number;
  readonly weight: number;
  readonly excludedProviderIds: readonly string[];
}

export interface ProxyPoolConfigStore {
  getProxy(id: string): Promise<ProxyConfig | undefined>;
  listProxies(): Promise<readonly ProxyConfig[]>;
}

export function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
}

export function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function proxyEnvSuffix(proxyId: string): string {
  return proxyId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function proxyIdFromSuffix(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, "-");
}

import { sanitizeMessage, deriveErrorSource, type ApplicationErrorKind, type NetworkSelection, type ProviderCallError, type RouteHealth, type RouteScope, type RouteStatus, type RoutingPreset } from "../application/contracts";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "../application/rate-limit";

export interface ProxyHealthOptions {
  readonly nowMs?: () => number;
}

export interface ProxyHealthRecord {
  readonly proxyId: string;
  readonly status: RouteStatus;
  readonly statusCode: number | null;
  readonly failureKind: ApplicationErrorKind | null;
  readonly sanitizedMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
  readonly disabledUntilMs: number | null;
  readonly failureCount: number;
  readonly generation: number;
}

export interface ProxyHealthStore {
  get(proxyId: string): Promise<ProxyHealthRecord | undefined>;
  set(record: ProxyHealthRecord): Promise<void>;
  list(): Promise<readonly ProxyHealthRecord[]>;
}

/**
 * Bounded proxy health state keyed by proxy id, independent from account
 * health: one broken proxy never disables every account route. Cooldown
 * follows the shared policy: 1 hour for proxy rate limits, 2s exponential
 * backoff capped at 5 minutes for connection/auth/upstream failures, with a
 * bounded Retry-After override allowed per family cap. T2 transient errors
 * (5xx, network, protocol) produce no cooldown — the proxy enters "error"
 * status but stays usable. Records carry only bounded, sanitized messages
 * — never secrets.
 */
export class ProxyHealthManager {
  private readonly nowMs: () => number;

  constructor(
    private readonly store: ProxyHealthStore,
    options: ProxyHealthOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async recordFailure(proxyId: string, error: ProviderCallError): Promise<ProxyHealthRecord | null> {
    if (!error.retryable) return null;
    const now = this.nowMs();
    const previous = await this.store.get(proxyId);
    const failureCount = Math.min(255, (previous?.failureCount ?? 0) + 1);
    const delayMs = cooldownDelayMs(error, proxyCooldownPolicyFor(error.kind), failureCount, now);
    const disabledUntilMs = delayMs > 0 ? now + delayMs : null;
    const record: ProxyHealthRecord = {
      proxyId,
      status: disabledUntilMs !== null ? "cooling_down" : "error",
      statusCode: error.statusCode,
      failureKind: error.kind,
      sanitizedMessage: sanitizeMessage(error.sanitizedMessage),
      occurredAt: new Date(now).toISOString(),
      retryAt: disabledUntilMs !== null ? new Date(disabledUntilMs).toISOString() : null,
      disabledUntilMs,
      failureCount,
      generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    return record;
  }

  async recordSuccess(proxyId: string): Promise<ProxyHealthRecord> {
    const previous = await this.store.get(proxyId);
    const record: ProxyHealthRecord = {
      proxyId,
      status: "healthy",
      statusCode: null,
      failureKind: null,
      sanitizedMessage: null,
      occurredAt: null,
      retryAt: null,
      disabledUntilMs: null,
      failureCount: 0,
      generation: (previous?.generation ?? 0) + 1,
    };
    await this.store.set(record);
    return record;
  }

  async getHealth(proxyId: string): Promise<RouteHealth | null> {
    const record = await this.store.get(proxyId);
    return record === undefined ? null : deriveRouteHealth(record, "proxy", this.nowMs());
  }

  async isUsable(proxyId: string, nowMs: number = this.nowMs()): Promise<boolean> {
    const record = await this.store.get(proxyId);
    return record === undefined || isRecordUsable(record, nowMs);
  }

  async list(): Promise<readonly ProxyHealthRecord[]> {
    return this.store.list();
  }
}

export type NetworkMode = "direct" | "proxy";

export interface NetworkRoutingPolicy {
  readonly preset: RoutingPreset;
  /** Per-proxy in-flight cap override; zero preserves each proxy's configured cap. */
  readonly targetConcurrent: number;
}

export type NetworkSelectionReason =
  | "direct_forced"
  | "proxy"
  | "proxy_busy_direct"
  | "proxy_unhealthy_direct"
  | "proxy_disabled_direct";

export interface NetworkSelectionResult {
  readonly selection: NetworkSelection;
  readonly mode: NetworkMode;
  readonly proxyId: string | null;
  readonly reason: NetworkSelectionReason;
}

export interface SelectNetworkInput {
  readonly providerId: string;
  /** Prefer the direct network path (e.g. provider-excluded direct route). */
  readonly preferDirect?: boolean;
  /** Allow falling back to the direct path when the pool cannot serve. Default true. */
  readonly allowDirectFallback?: boolean;
  readonly preferredProxyId?: string | null;
  /** Stable caller identity used only by the target-user preset. */
  readonly affinityKey?: string | null;
  readonly nowMs?: number;
}

/**
 * Direct/proxy network selection with per-proxy concurrency release.
 *
 * The chosen path is observable through the typed NetworkSelectionResult:
 * mode "direct" (proxyId null) or "proxy" (proxyId + url). A proxy is only
 * selected when it is enabled for the provider, not cooling down, and has a
 * free concurrency slot; the acquired slot is released exactly once through
 * `selection.release()` (idempotent). Returns null only when a pool-required
 * path cannot be served and direct fallback is disallowed — the caller maps
 * that to networkUnavailableError.
 */
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class NetworkSelector {
  constructor(
    private readonly pool: ProxyPool,
    private readonly health: ProxyHealthManager,
    private readonly readPolicy: () => NetworkRoutingPolicy = () => ({ preset: "auto", targetConcurrent: 0 }),
  ) {}

  async select(input: SelectNetworkInput): Promise<NetworkSelectionResult | null> {
    const now = input.nowMs ?? Date.now();
    if (input.preferDirect === true) return this.directResult("direct_forced");

    const proxies = await this.pool.enabledFor(input.providerId);
    if (proxies.length === 0) {
      return input.allowDirectFallback === false ? null : this.directResult("proxy_disabled_direct");
    }

    const preferred = input.preferredProxyId ?? null;
    const policy = this.readPolicy();
    const healthRecords = await this.health.list();
    const healthByProxyId = new Map(healthRecords.map((record) => [record.proxyId, record]));
    const candidates = proxies.filter((proxy) => {
      const health = healthByProxyId.get(proxy.id);
      return health === undefined || isRecordUsable(health, now);
    });
    const ordered = [...candidates].sort((a, b) => {
      const preferredDiff = Number(b.id === preferred) - Number(a.id === preferred);
      if (preferredDiff !== 0) return preferredDiff;
      if (policy.preset === "target-user" && input.affinityKey) {
        const seed = stableHash(`${input.affinityKey}:${input.providerId}`);
        const offset = (seed % candidates.length);
        const aIndex = candidates.findIndex((candidate) => candidate.id === a.id);
        const bIndex = candidates.findIndex((candidate) => candidate.id === b.id);
        return ((aIndex - offset + candidates.length) % candidates.length) - ((bIndex - offset + candidates.length) % candidates.length);
      }
      const aBaseCapacity = policy.preset === "target-concurrent" && policy.targetConcurrent > 0 ? Math.min(a.maxConcurrency, policy.targetConcurrent) : a.maxConcurrency;
      const bBaseCapacity = policy.preset === "target-concurrent" && policy.targetConcurrent > 0 ? Math.min(b.maxConcurrency, policy.targetConcurrent) : b.maxConcurrency;
      const aCapacity = aBaseCapacity * Math.max(1, a.weight) / 100;
      const bCapacity = bBaseCapacity * Math.max(1, b.weight) / 100;
      const loadDiff = (this.pool.activeCount(a.id) / Math.max(1, aCapacity)) - (this.pool.activeCount(b.id) / Math.max(1, bCapacity));
      if (loadDiff !== 0) return loadDiff;
      return b.priority - a.priority || a.id.localeCompare(b.id);
    });

    const maxOverride = policy.preset === "target-concurrent" && policy.targetConcurrent > 0 ? policy.targetConcurrent : undefined;
    for (const proxy of ordered) {
      const handle = await this.pool.acquireSlot(proxy.id, maxOverride);
      if (handle !== null) {
        const selection: NetworkSelection = { proxyId: proxy.id, url: proxy.url, isRelay: proxy.isRelay, release: handle.release };
        return { selection, mode: "proxy", proxyId: proxy.id, reason: "proxy" };
      }
    }

    if (input.allowDirectFallback === false) return null;
    return this.directResult(candidates.length > 0 ? "proxy_busy_direct" : "proxy_unhealthy_direct");
  }

  private directResult(reason: NetworkSelectionReason): NetworkSelectionResult {
    const selection: NetworkSelection = { proxyId: null, url: null, release: async () => {} };
    return { selection, mode: "direct", proxyId: null, reason };
  }
}

export function networkUnavailableError(providerId: string, retryAt: string | null = null): ProviderCallError {
  return makeProviderError("network_unavailable", `No outbound network path available for provider ${providerId}`, {
    retryable: true,
    routeScope: "proxy",
    retryAt,
  });
}

/**
 * Retry/cooldown policy shared by auth account health and traffic proxy health.
 *
 * Only a structured, bounded `Retry-After` (ProviderCallError.retryAt) may
 * override the documented default cooldowns, and only within the failure
 * family's absolute cap. Timestamps embedded inside error messages never
 * influence cooldown.
 */

export interface CooldownPolicy {
  /** Fixed cooldown used when the failure kind has a documented default. */
  readonly defaultMs: number;
  /** Exponential backoff base for failure kinds without a fixed default. */
  readonly baseMs: number;
  /** Absolute ceiling for any cooldown or accepted Retry-After override. */
  readonly capMs: number;
}

export const ACCOUNT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
export const ACCOUNT_QUOTA_COOLDOWN_MS = 5 * 60_000;
export const ACCOUNT_AUTH_BACKOFF_BASE_MS = 2_000;
export const ACCOUNT_AUTH_BACKOFF_CAP_MS = 5 * 60_000;
export const PROXY_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
export const PROXY_AUTH_BACKOFF_BASE_MS = 2_000;
export const PROXY_AUTH_BACKOFF_CAP_MS = 5 * 60_000;

/**
 * Short graduated base for rate-limited kinds whose message did not match a
 * known quota/rate-limit pattern (UNKNOWN/SERVER_ERROR). Instead of jumping
 * straight to the 5-min policy default on the FIRST failure, we start at this
 * base and grow exponentially with failureCount, capped by the policy default.
 * Repeated failures still escalate to the full cooldown — a single transient
 * opaque 429 no longer takes the account offline for 5 minutes.
 */
export const RATE_LIMIT_GRADUATED_BASE_MS = 30_000;
/** Failures within this window before the full policy default applies. */
export const RATE_LIMIT_GRADUATED_THRESHOLD = 3;

const ACCOUNT_RATE_LIMIT_POLICY: CooldownPolicy = {
  defaultMs: ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
  capMs: ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
};
const ACCOUNT_QUOTA_POLICY: CooldownPolicy = {
  defaultMs: ACCOUNT_QUOTA_COOLDOWN_MS,
  baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
  capMs: ACCOUNT_QUOTA_COOLDOWN_MS,
};
const ACCOUNT_BACKOFF_POLICY: CooldownPolicy = {
  defaultMs: 0,
  baseMs: ACCOUNT_AUTH_BACKOFF_BASE_MS,
  capMs: ACCOUNT_AUTH_BACKOFF_CAP_MS,
};
const PROXY_RATE_LIMIT_POLICY: CooldownPolicy = {
  defaultMs: PROXY_RATE_LIMIT_COOLDOWN_MS,
  baseMs: PROXY_AUTH_BACKOFF_BASE_MS,
  capMs: PROXY_RATE_LIMIT_COOLDOWN_MS,
};
const PROXY_BACKOFF_POLICY: CooldownPolicy = {
  defaultMs: 0,
  baseMs: PROXY_AUTH_BACKOFF_BASE_MS,
  capMs: PROXY_AUTH_BACKOFF_CAP_MS,
};

const RATE_LIMITED_KINDS: Readonly<Record<string, boolean>> = { provider_rate_limited: true };
const QUOTA_EXHAUSTED_KINDS: Readonly<Record<string, boolean>> = { quota_exceeded: true };

/**
 * T2 transient error kinds — these never trigger cooldown. The account
 * stays in `error` status (still eligible) so subsequent requests can
 * retry it immediately. Only T1 (known rate-limit/quota/capacity) and
 * auth failures produce a `cooling_down` period.
 *
 * Rationale (etteum-pool `markTransientFailure`, 9router 30s default):
 * one transient 5xx or network blip should not take an account offline
 * for 20+ seconds when it is likely still functional.
 */
const TRANSIENT_ERROR_KINDS: Readonly<Record<string, boolean>> = {
  provider_unavailable: true,
  provider_protocol_error: true,
  stream_timeout: true,
  stream_truncated: true,
  network_unavailable: true,
  internal_error: true,
};

export function isTransientErrorKind(kind: ApplicationErrorKind): boolean {
  return TRANSIENT_ERROR_KINDS[kind] === true;
}

export function accountCooldownPolicyFor(kind: ApplicationErrorKind): CooldownPolicy {
  if (RATE_LIMITED_KINDS[kind] === true) return ACCOUNT_RATE_LIMIT_POLICY;
  if (QUOTA_EXHAUSTED_KINDS[kind] === true) return ACCOUNT_QUOTA_POLICY;
  return ACCOUNT_BACKOFF_POLICY;
}

export function proxyCooldownPolicyFor(kind: ApplicationErrorKind): CooldownPolicy {
  if (RATE_LIMITED_KINDS[kind] === true) return PROXY_RATE_LIMIT_POLICY;
  if (QUOTA_EXHAUSTED_KINDS[kind] === true) return PROXY_RATE_LIMIT_POLICY;
  return PROXY_BACKOFF_POLICY;
}

export function exponentialBackoffMs(baseMs: number, attempt: number, capMs: number): number {
  if (attempt <= 1) return Math.min(capMs, baseMs);
  const factor = 2 ** (attempt - 1);
  const raw = Math.min(capMs, Number.isFinite(factor) ? baseMs * factor : capMs);
  // ±25% jitter to prevent thundering herd on synchronized retry storms.
  const jitter = raw * 0.25 * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.min(capMs, Math.round(raw + jitter)));
}

/** Parses an ISO `Retry-After` (ProviderCallError.retryAt) into a bounded delay in ms, or null when absent/invalid/out of range. */
export function boundedRetryDelayMs(retryAt: string | null, nowMs: number, capMs: number): number | null {
  if (retryAt === null) return null;
  const at = Date.parse(retryAt);
  if (!Number.isFinite(at)) return null;
  const delay = at - nowMs;
  if (delay < 0 || delay > capMs) return null;
  return delay;
}

export function cooldownDelayMs(error: ProviderCallError, policy: CooldownPolicy, failureCount: number, nowMs: number): number {
  if (!error.retryable) return 0;
  // T2 transient errors (5xx, network, stream, protocol) — no cooldown.
  // The account enters "error" status (still eligible) instead of
  // "cooling_down". The recovery loop still retries with the next
  // candidate; we just don't poison the account for a transient blip.
  if (isTransientErrorKind(error.kind)) return 0;
  const retryAfter = boundedRetryDelayMs(error.retryAt, nowMs, policy.capMs);
  if (retryAfter !== null) return retryAfter;
  // T1 known rate-limit/quota kinds: use fine-grained per-reason backoff
  // when the message matches, otherwise apply a graduated backoff that
  // starts short and escalates with failure count — instead of jumping to
  // the full policy default on the FIRST failure.
  if (policy.defaultMs > 0) {
    const reason = parseRateLimitReason(error.sanitizedMessage);
    // Positively identified quota exhaustion — full cooldown immediately.
    // This is the authoritative signal that the account's quota is spent.
    if (reason === "QUOTA_EXHAUSTED") {
      return Math.min(calculateRateLimitBackoffMs(reason), policy.defaultMs);
    }
    // MODEL_CAPACITY gets its jittered backoff, capped by policy default.
    if (reason === "MODEL_CAPACITY_EXHAUSTED") {
      return Math.min(calculateRateLimitBackoffMs(reason), policy.defaultMs);
    }
    // RATE_LIMIT_EXCEEDED (per-minute throttle) — short fixed backoff,
    // capped by policy default. These clear in seconds, not minutes.
    if (reason === "RATE_LIMIT_EXCEEDED") {
      return Math.min(calculateRateLimitBackoffMs(reason), policy.defaultMs);
    }
    // UNKNOWN / SERVER_ERROR: the message didn't match a known pattern.
    // Use a short graduated base that grows exponentially with failureCount,
    // capped by the policy default. The first 1-2 failures get a short
    // cooldown (30s, 60s); only repeated failures (>= threshold) escalate
    // to the full policy default. This fixes "one small error → offline
    // for 5 minutes" while still protecting against sustained abuse.
    if (failureCount >= RATE_LIMIT_GRADUATED_THRESHOLD) {
      return policy.defaultMs;
    }
    return Math.min(policy.defaultMs, exponentialBackoffMs(RATE_LIMIT_GRADUATED_BASE_MS, failureCount, policy.defaultMs));
  }
  return exponentialBackoffMs(policy.baseMs, failureCount, policy.capMs);
}

export interface ProviderErrorOptions {
  readonly statusCode?: number | null;
  readonly retryable?: boolean;
  readonly routeScope?: RouteScope | "provider" | null;
  readonly retryAt?: string | null;
}

/** Builds an application-typed ProviderCallError with a sanitized message (no secrets). */
export function makeProviderError(kind: ApplicationErrorKind, message: string, options: ProviderErrorOptions = {}): ProviderCallError {
  return {
    statusCode: options.statusCode ?? null,
    kind,
    retryable: options.retryable ?? false,
    routeScope: options.routeScope ?? null,
    source: deriveErrorSource(kind, options.routeScope ?? null),
    sanitizedMessage: sanitizeMessage(message),
    retryAt: options.retryAt ?? null,
  };
}

/** Health-view shape shared by account and proxy health records. */
export interface HealthRecordView {
  readonly status: RouteStatus;
  readonly statusCode: number | null;
  readonly failureKind: ApplicationErrorKind | null;
  readonly sanitizedMessage: string | null;
  readonly occurredAt: string | null;
  readonly retryAt: string | null;
  readonly disabledUntilMs: number | null;
}

export function isRecordUsable(record: HealthRecordView, nowMs: number): boolean {
  if (record.status === "healthy") return true;
  if (record.status === "disabled") return false;
  // "error" accounts are usable — they may have failed transiently and
  // should be retried. "cooling_down" is usable once the cooldown expires.
  if (record.status === "error") return true;
  if (record.status === "cooling_down") return record.disabledUntilMs === null || nowMs >= record.disabledUntilMs;
  return true;
}

export function deriveRouteHealth(record: HealthRecordView, scope: RouteScope, nowMs: number): RouteHealth {
  const cooling = record.disabledUntilMs !== null && nowMs < record.disabledUntilMs;
  let status: RouteStatus;
  if (cooling) status = "cooling_down";
  else if (record.status === "disabled") status = "disabled";
  else if (record.status === "error") status = "error";
  else status = "healthy";
  const active = cooling || status !== "healthy";
  return {
    scope,
    status,
    statusCode: active ? record.statusCode : null,
    failureKind: active ? record.failureKind : null,
    sanitizedMessage: active ? record.sanitizedMessage : null,
    occurredAt: active ? record.occurredAt : null,
    retryAt: cooling ? record.retryAt : null,
  };
}

import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { SocksProxyAgent } from "socks-proxy-agent";

/** Cache SocksProxyAgent per URL — avoids re-parsing URL + rebuilding connection pool per request. */
const socksAgentCache = new Map<string, SocksProxyAgent>();

function socksAgentFor(agentUrl: string): SocksProxyAgent {
  let agent = socksAgentCache.get(agentUrl);
  if (agent === undefined) {
    agent = new SocksProxyAgent(agentUrl);
    socksAgentCache.set(agentUrl, agent);
  }
  return agent;
}

export interface ProxyTarget {
  readonly url: string;
  readonly isRelay?: boolean;
}

export type ProxyFetcher = (url: string, init: RequestInit) => Promise<Response>;

function proxyUrlOf(proxy: ProxyTarget): string {
  const parsed = new URL(proxy.url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks5:") {
    throw new Error(`Unsupported outbound proxy protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeBody(body: RequestInit["body"]): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error(`Unsupported request body type for proxied dispatch: ${Object.prototype.toString.call(body)}`);
}

function headersToObject(headers: RequestInit["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function socks5Fetcher(proxy: ProxyTarget): ProxyFetcher {
  const agentUrl = proxyUrlOf(proxy);
  return async (url, init) => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        agent: socksAgentFor(agentUrl),
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: headersToObject(init.headers),
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) responseHeaders.append(key, entry);
          } else if (value !== undefined) {
            responseHeaders.set(key, value);
          }
        }
        // IncomingMessage extends Readable; Readable.toWeb converts it to a
        // web ReadableStream at runtime. The cast bypasses a @types/node
        // AsyncIterator/AsyncIterableIterator variance mismatch.
        resolve(new Response(Readable.toWeb(response as never) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 502, headers: responseHeaders }));
      },
    );
    req.on("error", reject);
    const signal = init.signal;
    const abort = () => req.destroy(new Error("aborted"));
    if (signal) {
      if (signal.aborted) {
        abort();
        return promise;
      }
      signal.addEventListener("abort", abort, { once: true });
      req.once("close", () => signal.removeEventListener("abort", abort));
    }
    const body = normalizeBody(init.body);
    if (body === undefined) req.end();
    else req.end(body);
    return promise;
  };
}

function relayFetcher(proxy: ProxyTarget): ProxyFetcher {
  const relayUrl = proxyUrlOf(proxy);
  return async (url, init) => {
    const target = new URL(url);
    const headers = new Headers(init.headers ?? {});
    headers.delete("host");
    headers.set("x-relay-target", target.origin);
    headers.set("x-relay-path", `${target.pathname}${target.search}`);
    const relay = new URL(relayUrl);
    if (relay.username) {
      const credentials = `${decodeURIComponent(relay.username)}:${decodeURIComponent(relay.password)}`;
      headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
      relay.username = "";
      relay.password = "";
    }
    return fetch(relay.toString(), { ...init, headers });
  };
}

function httpProxyFetcher(proxy: ProxyTarget): ProxyFetcher {
  const proxyUrl = proxyUrlOf(proxy);
  return async (url, init) => {
    return fetch(url, { ...init, proxy: proxyUrl } as RequestInit & { proxy: string });
  };
}

export function buildProxyFetcher(proxy: ProxyTarget): ProxyFetcher {
  if (proxy.isRelay) return relayFetcher(proxy);
  return new URL(proxy.url).protocol === "socks5:" ? socks5Fetcher(proxy) : httpProxyFetcher(proxy);
}

export interface ProxySlotHandle {
  readonly proxyId: string;
  /** Releases the acquired slot exactly once; repeated calls are no-ops. */
  release(): Promise<void>;
}

/** Per-proxy concurrency accounting: slots are bounded by each proxy's maxConcurrency. */
export class ProxySlotManager {
  private readonly active = new Map<string, number>();

  activeCount(proxyId: string): number {
    return this.active.get(proxyId) ?? 0;
  }

  tryAcquire(proxyId: string, maxConcurrency: number): ProxySlotHandle | null {
    if (maxConcurrency < 1) return null;
    const current = this.active.get(proxyId) ?? 0;
    if (current >= maxConcurrency) return null;
    this.active.set(proxyId, current + 1);
    let released = false;
    return {
      proxyId,
      release: async () => {
        if (released) return;
        released = true;
        const remaining = (this.active.get(proxyId) ?? 1) - 1;
        if (remaining <= 0) this.active.delete(proxyId);
        else this.active.set(proxyId, remaining);
      },
    };
  }
}

/** Config-backed proxy pool; health and network-path decisions live in NetworkSelector. */
export class ProxyPool {
  private readonly slots: ProxySlotManager;
  private cached: readonly ProxyConfig[] | null = null;
  private loadPromise: Promise<readonly ProxyConfig[]> | null = null;
  private cacheGeneration = 0;
  /** Per-provider enabled-proxy cache keyed by providerId, invalidated with the main cache. */
  private readonly enabledForCache = new Map<string, readonly ProxyConfig[]>();

  constructor(
    private readonly config: ProxyPoolConfigStore,
    slots?: ProxySlotManager,
  ) {
    this.slots = slots ?? new ProxySlotManager();
  }

  /** Invalidates the in-memory config snapshot after a console mutation. */
  invalidate(): void {
    this.cached = null;
    this.loadPromise = null;
    this.enabledForCache.clear();
    this.cacheGeneration += 1;
  }

  async list(): Promise<readonly ProxyConfig[]> {
    if (this.cached !== null) return this.cached;
    if (this.loadPromise !== null) return this.loadPromise;
    const generation = this.cacheGeneration;
    const promise: Promise<readonly ProxyConfig[]> = this.config.listProxies()
      .then((proxies) => {
        const sorted = Object.freeze([...proxies].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)));
        if (generation === this.cacheGeneration) this.cached = sorted;
        if (this.loadPromise === promise) this.loadPromise = null;
        return sorted;
      })
      .catch((error) => {
        if (this.loadPromise === promise) this.loadPromise = null;
        throw error;
      });
    this.loadPromise = promise;
    return promise;
  }

  async get(proxyId: string): Promise<ProxyConfig | undefined> {
    return (await this.list()).find((proxy) => proxy.id === proxyId);
  }

  async enabledFor(providerId: string): Promise<readonly ProxyConfig[]> {
    const cachedForProvider = this.enabledForCache.get(providerId);
    if (cachedForProvider !== undefined) return cachedForProvider;
    const proxies = await this.list();
    const filtered = Object.freeze(proxies.filter((proxy) => proxy.enabled && !proxy.excludedProviderIds.includes(providerId)));
    this.enabledForCache.set(providerId, filtered);
    return filtered;
  }

  activeCount(proxyId: string): number {
    return this.slots.activeCount(proxyId);
  }

  async acquireSlot(proxyId: string, maxConcurrencyOverride?: number): Promise<ProxySlotHandle | null> {
    const proxy = (await this.list()).find((candidate) => candidate.id === proxyId);
    if (proxy === undefined || !proxy.enabled) return null;
    const maxConcurrency = maxConcurrencyOverride === undefined ? proxy.maxConcurrency : Math.min(proxy.maxConcurrency, maxConcurrencyOverride);
    return this.slots.tryAcquire(proxyId, maxConcurrency);
  }
}

// OAuth client contracts, registries, PKCE state, and ephemeral flow storage.

import { createHash, randomBytes } from "node:crypto";
import type { RedisClient } from "../../persistence/redis";

// Shared OAuth client-protocol kit: the provider-agnostic `OAuthLoginClient`
// generic token-response parsing helpers, and tenant-scoped device-flow correlation.
// Every provider OAuth client imports from this module.

export interface OAuthAuthorizeRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface OAuthExchangeResult {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
  /** Resolved display label (account email/org name) when the provider exposes one. */
  readonly accountLabel?: string;
}

export interface OAuthDeviceStartResult {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
  /**
   * Provider-private state needed to finish the device flow. Console routes
   * persist this in Redis but never return it to the dashboard/browser.
   */
  readonly providerState?: string;
}

export interface OAuthDeviceFlowContext {
  readonly providerId: string;
  readonly tenantId: string | null;
  readonly accountLabel: string;
  /** Provider-private state persisted by the console route. */
  readonly providerState?: string | undefined;
}

export type OAuthDevicePollResult =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly result: OAuthExchangeResult }
  | { readonly status: "failed"; readonly reason: string };

export interface OAuthLoginClient {
  readonly supportsDeviceCode: boolean;
  /** False for device-only clients; omitted clients that omit this flag default to browser support. */
  readonly supportsBrowserCode?: boolean;
  /** Browser-code clients only; device-only clients omit both. */
  buildAuthorizeUrl?(request: OAuthAuthorizeRequest): string;
  exchangeCode?(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthExchangeResult>;
  startDeviceAuth?(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult>;
  pollDeviceAuth?(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult>;
}

/** Provider-agnostic device-authorization start, normalized across providers. */
interface DeviceAuthStart {
  readonly deviceCode: string;
  readonly userCode: string;
  /** URI the user should open; falls back to the complete URI when that is all the provider sends. */
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

/** Default device-authorization polling interval and lifetime. */
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRY_SECONDS = 900;

/**
 * Normalizes an RFC 8628 device-authorization response. Returns `undefined`
 * when the provider omitted any field a device flow cannot proceed without,
 * so each caller keeps its own error text. Missing or non-positive
 * `interval`/`expires_in` fall back to the caller's defaults (or the shared
 * ones); present values are floored at one second.
 */
export function parseDeviceAuthStart(
  payload: unknown,
  defaults?: { intervalSeconds?: number; expiresInSeconds?: number },
): DeviceAuthStart | undefined {
  const root = record(payload);
  if (!root) return undefined;
  const deviceCode = nonEmptyTrimmedString(root.device_code);
  const userCode = nonEmptyTrimmedString(root.user_code);
  const complete = nonEmptyTrimmedString(root.verification_uri_complete);
  const verificationUri = nonEmptyTrimmedString(root.verification_uri) ?? complete;
  if (!deviceCode || !userCode || !verificationUri) return undefined;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete === undefined ? {} : { verificationUriComplete: complete }),
    intervalSeconds: positiveSeconds(
      root.interval,
      defaults?.intervalSeconds ?? DEFAULT_DEVICE_INTERVAL_SECONDS,
    ),
    expiresInSeconds: positiveSeconds(
      root.expires_in,
      defaults?.expiresInSeconds ?? DEFAULT_DEVICE_EXPIRY_SECONDS,
    ),
  };
}

/** Floors a device-flow seconds field at 1, falling back when absent/invalid. */
function positiveSeconds(value: unknown, fallbackSeconds: number): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackSeconds;
  return Math.max(1, Math.floor(seconds));
}

/**
 * True when a device-token poll error means "keep polling": the user has not
 * approved yet, or the client is polling faster than the server allows.
 */
export function isDevicePollPending(error: string | undefined): boolean {
  return error === "authorization_pending" || error === "slow_down";
}

/** Trimmed non-empty string, or `undefined` for anything else. */
export function nonEmptyTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Object (non-array) narrowing for untyped upstream JSON. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}


interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generates a fresh PKCE verifier/challenge pair using the S256 transform. */
export function generatePkcePair(): PkcePair {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Generates an opaque CSRF-safe `state` parameter for an authorize-URL round trip. */
export function generateOAuthState(): string {
  return base64UrlEncode(randomBytes(24));
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Caps upstream status text at `maxLength` chars (default 500) so error
 * details stay bounded. Pure length cap — no trimming — so callers that
 * trim keep doing so explicitly.
 */
export function truncateUpstreamText(text: string, maxLength = 500): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const body = truncateUpstreamText(text);
    throw new Error(`${label} request failed (${response.status}): ${body}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
/** Minimal fetch surface accepted by token request helpers. */
type TokenFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
} as const;

const JSON_HEADERS = { "content-type": "application/json" } as const;

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  return composeAbortSignal(signal, timeoutMs);
}

interface FormTokenRequestOptions {
  readonly url: string;
  readonly fetchFn: TokenFetch;
  readonly params: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly label: string;
}

/** POSTs form-encoded params to a token endpoint and returns the parsed JSON body. */
export async function postFormTokenRequest(
  options: FormTokenRequestOptions,
): Promise<unknown> {
  const signal = requestSignal(options.signal, options.timeoutMs);
  const response = await options.fetchFn(options.url, {
    method: "POST",
    headers: { ...FORM_HEADERS, ...(options.headers ?? {}) },
    body: new URLSearchParams(options.params),
    ...(signal === undefined ? {} : { signal }),
  });
  return readJsonResponse(response, options.label);
}

interface JsonTokenRequestOptions {
  readonly url: string;
  readonly fetchFn: TokenFetch;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly label: string;
}

/** POSTs a JSON body to a token endpoint and returns the parsed JSON body. */
export async function postJsonTokenRequest(
  options: JsonTokenRequestOptions,
): Promise<unknown> {
  const signal = requestSignal(options.signal, options.timeoutMs);
  const response = await options.fetchFn(options.url, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...(options.headers ?? {}) },
    body: JSON.stringify(options.body),
    ...(signal === undefined ? {} : { signal }),
  });
  return readJsonResponse(response, options.label);
}


export function expiryFromSeconds(value: unknown, fallbackSec = 3600): Date {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : fallbackSec;
  return new Date(Date.now() + Math.max(0, seconds) * 1000);
}

/**
 * Decodes a JWT payload without verifying (OAuth metadata only — the trust
 * boundary stays at TLS + issuer). Strict 3-part shape with an object
 * (non-array) payload; anything else yields `undefined`.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const value = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JWT `exp` (seconds) as epoch millis minus `skewMs`; tokens without a
 * finite numeric `exp` fall back to `Date.now() + fallbackMs`. A non-finite
 * `exp` (e.g. `Infinity`) yields the fallback instead of an Invalid Date.
 */
export function expiryFromJwt(token: string, fallbackMs: number, skewMs = 0): number {
  try {
    const decoded = decodeJwtPayload(token);
    if (decoded && typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
      return decoded.exp * 1000 - skewMs;
    }
  } catch {
    // Malformed token payloads safely degrade to caller fallback TTL.
  }
  return Date.now() + fallbackMs;
}
/**
 * Builds a PKCE authorization URL with the canonical parameter order
 * (`client_id`, `response_type`, `redirect_uri`, `scope`, `state`,
 * `code_challenge`, `code_challenge_method`, then provider extras).
 * `URLSearchParams` preserves insertion order, so adapters that shared this
 * exact order delegate here with byte-identical URLs.
 */
export function buildPkceAuthorizeUrl(args: {
  clientId: string;
  authorizeUrl: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  extra?: Record<string, string>;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: args.scope,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    ...(args.extra ?? {}),
  });
  return `${args.authorizeUrl}?${params.toString()}`;
}

/**
 * Deadline signal composition (grok/muse proven shape): a bare timeout
 * signal when no outer signal exists, otherwise a composite that aborts on
 * either. Unlike the manual controller blocks this replaces, a pre-aborted
 * outer signal aborts immediately instead of proceeding to the timeout.
 */
export function composeAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
}

// Redis-backed OAuth flow correlation store.
//
// Browser authorization state and device-code correlation share one explicit
// namespace. Browser state is consumed atomically; device state remains until
// the flow completes.
export const DEFAULT_TTL_SECONDS = 900;
const KEY_PREFIX = "cartethyia:oauth:";
const PENDING_PREFIX = `${KEY_PREFIX}pending:`;
const DEVICE_PREFIX = `${KEY_PREFIX}device:`;
const DEVICE_STATE_PREFIX = `${KEY_PREFIX}device-state:`;

const ATOMIC_CONSUME_LUA =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v";

export interface PendingOAuthFlow {
  readonly providerId: string;
  readonly codeVerifier: string;
  readonly accountLabel: string;
  readonly tenantId: string | null;
  readonly redirectUri: string;
}

export interface DeviceFlowCorrelation {
  readonly providerId: string;
  readonly accountLabel: string;
  readonly tenantId: string | null;
  /** Provider-private state that must survive browser/device polling. */
  readonly providerState?: string;
}
export class OAuthFlowStore {
  readonly #redis: RedisClient;
  readonly #ttlSeconds: number;

  constructor(redis: RedisClient, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
  }

  // ------------------------------------------------------------------ Pending

  async savePending(state: string, flow: PendingOAuthFlow): Promise<void> {
    await this.#redis.set(PENDING_PREFIX + state, JSON.stringify(flow), "EX", this.#ttlSeconds);
  }

  /**
   * Atomically reads and deletes the pending flow for `state`.
   * Returns `undefined` if absent/expired/already consumed.
   *
   * Implemented via a Lua `EVAL` (`GET`+`DEL` in one server-side
   * execution) so two concurrent `consumePending` calls for the same
   * `state` cannot both observe a value — only one wins. This is
   * required because Redis 5.0.14.1 (the production version) does not
   * implement `GETDEL` (added in Redis 6.2).
   */
  async consumePending(state: string): Promise<PendingOAuthFlow | undefined> {
    const key = PENDING_PREFIX + state;
    const redisAny = this.#redis as unknown as {
      eval?: (script: string, numKeys: number, ...args: string[]) => Promise<string | null>;
    };
    let raw: string | null;
    if (typeof redisAny.eval === "function") {
      raw = await redisAny.eval(ATOMIC_CONSUME_LUA, 1, key);
    } else {
      // Fallback for minimal test fakes that only implement get/del.
      // Not atomic — real Redis always takes the eval path above.
      raw = await this.#redis.get(key);
      if (raw) await this.#redis.del(key);
    }
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as PendingOAuthFlow;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------- Device correlation

  async saveDevice(deviceAuthId: string, correlation: DeviceFlowCorrelation): Promise<void> {
    await this.#redis.set(
      DEVICE_PREFIX + deviceAuthId,
      JSON.stringify(correlation),
      "EX",
      this.#ttlSeconds,
    );
  }

  async getDevice(deviceAuthId: string): Promise<DeviceFlowCorrelation | undefined> {
    const raw = await this.#redis.get(DEVICE_PREFIX + deviceAuthId);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as DeviceFlowCorrelation;
    } catch {
      return undefined;
    }
  }

  async deleteDevice(deviceAuthId: string): Promise<void> {
    await this.#redis.del(DEVICE_PREFIX + deviceAuthId);
  }

  // ------------------------------------------------------- Device start state
  // Provider-private device-authorization state is stored in Redis so active
  // flows survive process restarts and deployment replacement. The store keeps
  // the payload opaque JSON; each provider validates its own fields on read.

  async saveDeviceState(deviceAuthId: string, state: Record<string, unknown>): Promise<void> {
    await this.#redis.set(
      DEVICE_STATE_PREFIX + deviceAuthId,
      JSON.stringify(state),
      "EX",
      this.#ttlSeconds,
    );
  }

  async getDeviceState(deviceAuthId: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.#redis.get(DEVICE_STATE_PREFIX + deviceAuthId);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async deleteDeviceState(deviceAuthId: string): Promise<void> {
    await this.#redis.del(DEVICE_STATE_PREFIX + deviceAuthId);
  }
}

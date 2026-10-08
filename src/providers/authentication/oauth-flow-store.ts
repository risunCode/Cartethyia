// OAuth client contracts, registries, PKCE state, and ephemeral flow storage.

import { createHash, randomBytes } from "node:crypto";
import type { RedisClient } from "../../persistence/redis";
import { TtlCache } from "../../runtime/ttl-cache";

// Shared OAuth client-protocol kit: the provider-agnostic `OAuthLoginClient`
// generic token-response parsing helpers, and tenant-scoped device-flow correlation.
// Every provider OAuth client imports from this module.

export interface OAuthAuthorizeRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  /**
   * Provider-specific inputs the operator chose before the login started, such
   * as which identity provider to sign in with. Providers that need none ignore
   * it; the console passes whatever the start request carried.
   */
  readonly parameters?: Readonly<Record<string, string>>;
}

export interface OAuthCodeExchangeContext {
  readonly state?: string;
  readonly parameters?: Readonly<Record<string, string>>;
}

export interface OAuthExchangeResult {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
  /** Resolved display label (account email/org name) when the provider exposes one. */
  readonly accountLabel?: string;
  /**
   * Non-secret auth configuration the flow learned on the way in — the upstream
   * profile the account is bound to, the region it was minted in, which method
   * produced it. Persisted beside the tokens because every dispatched request
   * and every later refresh needs it, and the token does not carry it.
   */
  readonly auth_state?: Readonly<Record<string, unknown>>;
  /**
   * Client secret minted by this flow's own client registration and replayed at
   * refresh next to the refresh token. Persisted encrypted, never in
   * `auth_state`.
   */
  readonly client_secret?: string;
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
  /**
   * Provider-specific inputs the operator supplied when starting the flow — an
   * organization URL, a region, which sign-in family to use. A provider that
   * needs none ignores it.
   */
  readonly parameters?: Readonly<Record<string, string>> | undefined;
}

export type OAuthDevicePollResult =
  /**
   * Still waiting on the user. `retryAfterSeconds` carries the server's
   * requested cadence when it sends one (`interval` on a pending answer) —
   * the dashboard adopts it so the next poll does not fire early and draw a
   * rate limit (RFC 8628 §3.5).
   */
  | { readonly status: "pending"; readonly retryAfterSeconds?: number }
  /**
   * The authorization server asked us to back off (`slow_down`, RFC 8628
   * §3.5). GitHub enforces it hard: continuing at the original cadence makes
   * every later poll answer `slow_down` again, so the flow never completes.
   * `retryAfterSeconds` is the server's own minimum when it sends one.
   */
  | { readonly status: "slow_down"; readonly retryAfterSeconds?: number }
  | { readonly status: "complete"; readonly result: OAuthExchangeResult }
  | { readonly status: "failed"; readonly reason: string };

export interface OAuthLoginClient {
  readonly supportsDeviceCode: boolean;
  /** False for device-only clients; omitted clients that omit this flag default to browser support. */
  readonly supportsBrowserCode?: boolean;
  /**
   * Loopback/native redirect URI this client's authorization server has
   * allowlisted, when it differs from the gateway-wide default.
   *
   * Authorization servers allowlist redirect URIs exactly. OpenAI registers
   * only `http://localhost:1455/auth/callback` for the Codex client, and Z.AI
   * rejects every loopback URI for the ZCode client, so a single shared default
   * cannot serve both — advertising the gateway default to OpenAI is answered
   * with `invalid_request` before the user ever sees a consent screen. The same
   * value is reused verbatim at code exchange, because the token endpoint
   * compares it against the one the authorize step sent.
   */
  readonly browserRedirectUri?: string;
  prepareAuthorize?(request: OAuthAuthorizeRequest): Promise<OAuthAuthorizeRequest>;
  /** Browser-code clients only; device-only clients omit both. */
  buildAuthorizeUrl?(request: OAuthAuthorizeRequest): string;
  exchangeCode?(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    state?: string,
    context?: OAuthCodeExchangeContext,
  ): Promise<OAuthExchangeResult>;
  startDeviceAuth?(context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult>;
  pollDeviceAuth?(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult>;
  /**
   * Fields the browser flow must collect from the operator before it starts.
   *
   * Declared by the client rather than by the console, so a provider states its
   * own requirement next to the code that consumes it. A client that declares
   * nothing starts with no operator input.
   */
  readonly browserLoginFields?: readonly OAuthLoginField[];
  /** Fields the device flow must collect before it starts. */
  readonly deviceLoginFields?: readonly OAuthLoginField[];
  /** Fields the import flow needs; only meaningful alongside `importCredential`. */
  readonly importFields?: readonly OAuthLoginField[];
  /**
   * Completes a login from operator-supplied credential material rather than
   * from a redirect or a device code — a pasted refresh token, an exported auth
   * blob, or a raw API key.
   *
   * The console exposes this as one entry point. The client decides which
   * credential family the input describes and validates it against the upstream
   * before it is persisted, so an import cannot store material that never
   * worked. `fields` carries whatever `importFields` declared.
   */
  importCredential?(input: OAuthImportInput): Promise<OAuthExchangeResult>;
}

/** One operator-supplied value a login needs before it can start. */
export interface OAuthLoginField {
  /** Key the value is passed back under, in `OAuthDeviceFlowContext.parameters`. */
  readonly key: string;
  readonly label: string;
  readonly placeholder?: string;
  /** Renders as a secret input and is never echoed back to the browser. */
  readonly secret?: boolean;
  /** Rejects an empty value before the flow starts. */
  readonly required?: boolean;
  /** Allowed values; renders as a select rather than a free-text input. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Default applied when the operator supplies nothing. */
  readonly defaultValue?: string;
}

/** Everything an import flow was given. */
export interface OAuthImportInput {
  /** The pasted credential material: a token, a key, or an exported auth blob. */
  readonly credential: string;
  /** Values for the fields `loginFields` declared. */
  readonly fields: Readonly<Record<string, string>>;
  /** Account label the operator chose, when they chose one. */
  readonly accountLabel?: string;
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
  return error === "authorization_pending";
}

/** RFC 8628 `slow_down`: the client must widen its polling interval. */
export function isDevicePollSlowDown(error: string | undefined): boolean {
  return error === "slow_down";
}

/**
 * Classifies a device-token poll error into a poll verdict, or `undefined`
 * when the error is not a recognized device-flow state (the caller then
 * reports it as a failure with the upstream's reason).
 */
export function devicePollBackoff(
  error: string | undefined,
  interval: unknown,
): { status: "pending"; retryAfterSeconds?: number } | { status: "slow_down"; retryAfterSeconds?: number } | undefined {
  // A pending answer may carry the server's requested cadence (`interval`):
  // honor it the same way as slow_down so the next poll does not fire
  // earlier than the server allows — polling faster than the interval is
  // what gets the client rate-limited (RFC 8628 §3.5).
  const seconds =
    typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined;
  if (isDevicePollPending(error))
    return { status: "pending", ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  if (isDevicePollSlowDown(error)) {
    return { status: "slow_down", ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }) };
  }
  return undefined;
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
const PENDING_PROVIDER_PREFIX = `${KEY_PREFIX}pending-provider:`;
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
  /** Provider-specific start inputs, kept so the callback can rebuild its request. */
  readonly parameters?: Readonly<Record<string, string>>;
  readonly providerState?: string;
}

export interface DeviceFlowCorrelation {
  readonly providerId: string;
  readonly accountLabel: string;
  readonly tenantId: string | null;
  /** Provider-private state that must survive browser/device polling. */
  readonly providerState?: string;
  /** Provider-specific start inputs, kept so a poll can rebuild its context. */
  readonly parameters?: Readonly<Record<string, string>>;
}
/**
 * Ephemeral OAuth flow storage contract: browser pending state, provider
 * pointers, and device-flow correlation. Redis-backed in shared deployments,
 * in-process memory on a single gateway — the console only ever sees this.
 */
export interface OAuthFlowStorage {
  savePending(state: string, flow: PendingOAuthFlow): Promise<void>;
  consumePendingByProvider(providerId: string): Promise<PendingOAuthFlow | undefined>;
  consumePending(state: string): Promise<PendingOAuthFlow | undefined>;
  saveDevice(deviceAuthId: string, correlation: DeviceFlowCorrelation): Promise<void>;
  getDevice(deviceAuthId: string): Promise<DeviceFlowCorrelation | undefined>;
  deleteDevice(deviceAuthId: string): Promise<void>;
  saveDeviceState(deviceAuthId: string, state: Record<string, unknown>): Promise<void>;
  getDeviceState(deviceAuthId: string): Promise<Record<string, unknown> | undefined>;
  deleteDeviceState(deviceAuthId: string): Promise<void>;
}
export class OAuthFlowStore implements OAuthFlowStorage {
  readonly #redis: RedisClient;
  readonly #ttlSeconds: number;

  constructor(redis: RedisClient, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
  }

  // ------------------------------------------------------------------ Pending

  async savePending(state: string, flow: PendingOAuthFlow): Promise<void> {
    await this.#redis.set(PENDING_PREFIX + state, JSON.stringify(flow), "EX", this.#ttlSeconds);
    // Per-provider pointer alongside the state key. An authorization server that
    // does not echo `state` (OpenRouter omits it from the callback entirely)
    // leaves the callback with no correlation key, and the state-keyed entry
    // alone cannot be found. One browser login is in flight per provider at a
    // time — the console dialog is modal — so a single pointer is the correct
    // shape, and it is cleared together with the state key on consume.
    await this.#redis.set(
      PENDING_PROVIDER_PREFIX + flow.providerId,
      state,
      "EX",
      this.#ttlSeconds,
    );
  }

  /**
   * Reads and clears the pending flow for a provider, for callbacks that arrive
   * without `state`. Returns `undefined` when no browser login is in flight.
   *
   * The pointer is last-write-wins: starting a second console login for one
   * provider before the first callback arrives repoints it at the newer state,
   * so the newer callback is the one served and the earlier flow stays
   * unreachable until its TTL expires. That is deliberate — the alternative
   * would be guessing which of two in-flight logins a stateless callback
   * belongs to, and the operator's newest attempt is the one they are watching.
   * The consumed state key is deleted first, so a callback can never inherit a
   * verifier that was already spent.
   */
  async consumePendingByProvider(providerId: string): Promise<PendingOAuthFlow | undefined> {
    const pointer = PENDING_PROVIDER_PREFIX + providerId;
    const state = await this.#redis.get(pointer);
    if (!state) return undefined;
    await this.#redis.del(pointer);
    return this.consumePending(state);
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
      const flow = JSON.parse(raw) as PendingOAuthFlow;
      // Clear the provider pointer so a consumed state cannot be looked up again.
      await this.#redis.del(PENDING_PROVIDER_PREFIX + flow.providerId);
      return flow;
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

/**
 * In-process twin of {@link OAuthFlowStore} for the memory backend: same
 * contract, same TTLs, same last-write-wins provider pointers. Restart clears
 * it by design, and single-threaded get+delete is the atomicity story — no
 * Lua needed on one process.
 */
export class InMemoryOAuthFlowStore implements OAuthFlowStorage {
  private readonly pending: TtlCache<string>;
  private readonly devices: TtlCache<string>;
  private readonly deviceStates: TtlCache<string>;

  constructor(ttlSeconds = DEFAULT_TTL_SECONDS) {
    const opts = { ttlMs: ttlSeconds * 1000, maxEntries: 512 };
    this.pending = new TtlCache<string>(opts);
    this.devices = new TtlCache<string>(opts);
    this.deviceStates = new TtlCache<string>(opts);
  }

  async savePending(state: string, flow: PendingOAuthFlow): Promise<void> {
    const raw = JSON.stringify(flow);
    this.pending.set(PENDING_PREFIX + state, raw);
    this.pending.set(PENDING_PROVIDER_PREFIX + flow.providerId, state);
  }

  async consumePendingByProvider(providerId: string): Promise<PendingOAuthFlow | undefined> {
    const pointer = PENDING_PROVIDER_PREFIX + providerId;
    const state = this.pending.get(pointer);
    if (!state) return undefined;
    this.pending.delete(pointer);
    return this.consumePending(state);
  }

  async consumePending(state: string): Promise<PendingOAuthFlow | undefined> {
    const key = PENDING_PREFIX + state;
    const raw = this.pending.get(key);
    if (!raw) return undefined;
    this.pending.delete(key);
    try {
      const flow = JSON.parse(raw) as PendingOAuthFlow;
      this.pending.delete(PENDING_PROVIDER_PREFIX + flow.providerId);
      return flow;
    } catch {
      return undefined;
    }
  }

  async saveDevice(deviceAuthId: string, correlation: DeviceFlowCorrelation): Promise<void> {
    this.devices.set(DEVICE_PREFIX + deviceAuthId, JSON.stringify(correlation));
  }

  async getDevice(deviceAuthId: string): Promise<DeviceFlowCorrelation | undefined> {
    const raw = this.devices.get(DEVICE_PREFIX + deviceAuthId);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as DeviceFlowCorrelation;
    } catch {
      return undefined;
    }
  }

  async deleteDevice(deviceAuthId: string): Promise<void> {
    this.devices.delete(DEVICE_PREFIX + deviceAuthId);
  }

  async saveDeviceState(deviceAuthId: string, state: Record<string, unknown>): Promise<void> {
    this.deviceStates.set(DEVICE_STATE_PREFIX + deviceAuthId, JSON.stringify(state));
  }

  async getDeviceState(deviceAuthId: string): Promise<Record<string, unknown> | undefined> {
    const raw = this.deviceStates.get(DEVICE_STATE_PREFIX + deviceAuthId);
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
    this.deviceStates.delete(DEVICE_STATE_PREFIX + deviceAuthId);
  }
}

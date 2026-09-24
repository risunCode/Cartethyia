/**
 * JWT inspection and verification for provider-issued OAuth tokens.
 *
 * Cartethyia receives provider access tokens directly from the issuer's token
 * endpoint over TLS, then sends them back to the same provider. That transport
 * path is the primary trust boundary, so signature verification is
 * defense-in-depth: when the provider's manifest declares a JWKS URL
 * (`providerJwtVerification`), signatures are verified; otherwise only
 * structural and registered claim validation runs. Opaque (non-JWT) tokens are
 * passed through untouched — they cannot be locally verified and are validated
 * by the issuer itself.
 *
 * Only asymmetric algorithms are accepted. `none` and HMAC (`HS*`) are
 * rejected so a token cannot downgrade to a shared-secret or unsigned form.
 */
import { constants, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

interface AlgorithmSpec {
  readonly hash: string;
  readonly kty: "RSA" | "EC";
  /** RSA-PSS padding, when the algorithm is PS*; RSA-PKCS1 is the default. */
  readonly padding?: number;
  readonly saltLength?: number;
}

/** Algorithms this module will verify, mapped to their digest and key type. */
const SUPPORTED_ALGORITHMS: Readonly<Record<string, AlgorithmSpec>> = Object.freeze({
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  PS256: {
    hash: "sha256",
    kty: "RSA",
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  },
  PS384: {
    hash: "sha384",
    kty: "RSA",
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  },
  PS512: {
    hash: "sha512",
    kty: "RSA",
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  },
  ES256: { hash: "sha256", kty: "EC" },
  ES384: { hash: "sha384", kty: "EC" },
  ES512: { hash: "sha512", kty: "EC" },
});

interface ParsedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signature: string;
  readonly signedInput: string;
}

function decodeJsonObject(segment: string): Record<string, unknown> | undefined {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strictly parses a compact JWS. Returns `undefined` for anything that is not a
 * three-part token with JSON header/payload objects, a non-empty `alg`, and a
 * non-empty signature — so `alg: none` and structurally broken tokens are never
 * treated as JWTs.
 */
export function parseJwt(token: string): ParsedJwt | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const headerSegment = parts[0] ?? "";
  const payloadSegment = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const header = decodeJsonObject(headerSegment);
  const payload = decodeJsonObject(payloadSegment);
  if (!header || !payload) return undefined;
  if (typeof header.alg !== "string" || header.alg.length === 0) return undefined;
  if (header.alg === "none" || signature.length === 0) return undefined;
  return { header, payload, signature, signedInput: `${headerSegment}.${payloadSegment}` };
}

type JwtClaimFailure =
  | "expired"
  | "not_yet_valid"
  | "issued_in_future"
  | "malformed_claim"
  | "issuer_mismatch"
  | "audience_mismatch";

interface JwtClaimExpectations {
  /** Accepted `iss` value(s); when set, `iss` must match exactly. */
  readonly issuer?: string | readonly string[];
  /** Accepted `aud` value(s); when set, the token audience must intersect. */
  readonly audience?: string | readonly string[];
  /** Current time in epoch milliseconds; defaults to `Date.now()`. */
  readonly now?: number;
  /** Leeway applied to `exp`/`nbf`/`iat` comparisons. Default 60s. */
  readonly clockSkewSeconds?: number;
}

function numericDate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expectedValues(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/**
 * Validates registered JWT claims (`exp`, `nbf`, `iat`, and — when expected —
 * `iss`/`aud`) with clock-skew tolerance. Returns `undefined` when the token is
 * acceptable, otherwise the first failure. Claims that are absent are not
 * required; claims that are present but not finite numbers are rejected as
 * malformed.
 */
export function validateJwtClaims(
  payload: Record<string, unknown>,
  expectations: JwtClaimExpectations = {},
): JwtClaimFailure | undefined {
  const nowSeconds = (expectations.now ?? Date.now()) / 1000;
  const skew = expectations.clockSkewSeconds ?? 60;

  for (const claim of ["exp", "nbf", "iat"] as const) {
    if (payload[claim] === undefined) continue;
    if (numericDate(payload[claim]) === undefined) return "malformed_claim";
  }

  const exp = numericDate(payload["exp"]);
  if (exp !== undefined && nowSeconds > exp + skew) return "expired";
  const nbf = numericDate(payload["nbf"]);
  if (nbf !== undefined && nowSeconds < nbf - skew) return "not_yet_valid";
  const iat = numericDate(payload["iat"]);
  if (iat !== undefined && iat > nowSeconds + skew) return "issued_in_future";

  const expectedIssuers = expectedValues(expectations.issuer);
  if (expectedIssuers.length > 0) {
    const issuer = payload["iss"];
    if (typeof issuer !== "string" || !expectedIssuers.includes(issuer)) return "issuer_mismatch";
  }

  const expectedAudiences = expectedValues(expectations.audience);
  if (expectedAudiences.length > 0) {
    const rawAud = payload["aud"];
    const audiences = typeof rawAud === "string" ? [rawAud] : Array.isArray(rawAud) ? rawAud : [];
    const matches = audiences.some(
      (audience) => typeof audience === "string" && expectedAudiences.includes(audience),
    );
    if (!matches) return "audience_mismatch";
  }

  return undefined;
}

interface Jwk {
  readonly kty?: unknown;
  readonly kid?: unknown;
  readonly use?: unknown;
  readonly alg?: unknown;
  readonly [key: string]: unknown;
}

interface JwksVerifierOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  readonly cacheTtlMs?: number;
  /** Minimum interval between forced refreshes when a `kid` is unknown. */
  readonly minRefreshIntervalMs?: number;
}

const DEFAULT_JWKS_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000;
const MAX_JWKS_KEYS = 64;

interface CachedJwks {
  readonly keys: readonly Jwk[];
  readonly fetchedAt: number;
}

function publicKeyFromJwk(jwk: Jwk): KeyObject | undefined {
  try {
    return createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
  } catch {
    return undefined;
  }
}

/**
 * Verifies compact-JWS signatures against a provider's JWKS endpoint. Keys are
 * cached with a TTL and bounded count; an unknown `kid` triggers at most one
 * rate-limited refresh so key rotation is picked up without hammering the
 * issuer.
 */
export class JwksVerifier {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  readonly #cacheTtlMs: number;
  readonly #minRefreshIntervalMs: number;
  #cache: CachedJwks | undefined;
  #inflight: Promise<readonly Jwk[]> | undefined;
  #lastRefreshAt = 0;

  constructor(options: JwksVerifierOptions) {
    this.#url = options.url;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => Date.now());
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
  }

  async #fetchKeys(): Promise<readonly Jwk[]> {
    const response = await this.#fetch(this.#url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`JWKS request failed (${response.status})`);
    const body = (await response.json()) as unknown;
    const keys = body !== null && typeof body === "object" ? (body as { keys?: unknown }).keys : undefined;
    if (!Array.isArray(keys)) throw new Error("JWKS response missing keys array");
    return keys.slice(0, MAX_JWKS_KEYS).filter(
      (key): key is Jwk => key !== null && typeof key === "object",
    );
  }

  async #getKeys(forceRefresh: boolean): Promise<readonly Jwk[]> {
    const now = this.#clock();
    if (!forceRefresh && this.#cache && now - this.#cache.fetchedAt < this.#cacheTtlMs) {
      return this.#cache.keys;
    }
    if (this.#inflight) return this.#inflight;
    const request = this.#fetchKeys()
      .then((keys) => {
        this.#cache = { keys, fetchedAt: this.#clock() };
        this.#lastRefreshAt = this.#clock();
        return keys;
      })
      .finally(() => {
        this.#inflight = undefined;
      });
    this.#inflight = request;
    return request;
  }

  /** Verifies `token`'s signature and returns the parsed token on success. */
  async verify(token: string): Promise<ParsedJwt | undefined> {
    const parsed = parseJwt(token);
    if (!parsed) return undefined;
    const algorithm = SUPPORTED_ALGORITHMS[parsed.header.alg as string];
    if (!algorithm) return undefined;

    const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : undefined;
    let keys: readonly Jwk[];
    try {
      keys = await this.#getKeys(false);
    } catch {
      return undefined;
    }
    let candidates = selectKeys(keys, kid, algorithm.kty);
    if (candidates.length === 0 && this.#clock() - this.#lastRefreshAt >= this.#minRefreshIntervalMs) {
      try {
        candidates = selectKeys(await this.#getKeys(true), kid, algorithm.kty);
      } catch {
        return undefined;
      }
    }
    if (candidates.length === 0) return undefined;

    const data = Buffer.from(parsed.signedInput, "utf8");
    const signature = Buffer.from(parsed.signature, "base64url");
    for (const jwk of candidates) {
      const key = publicKeyFromJwk(jwk);
      if (!key) continue;
      const verifyOptions =
        algorithm.kty === "EC"
          ? { key, dsaEncoding: "ieee-p1363" as const }
          : algorithm.padding === undefined || algorithm.saltLength === undefined
            ? { key }
            : { key, padding: algorithm.padding, saltLength: algorithm.saltLength };
      try {
        if (cryptoVerify(algorithm.hash, data, verifyOptions, signature)) return parsed;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

function selectKeys(keys: readonly Jwk[], kid: string | undefined, kty: "RSA" | "EC"): readonly Jwk[] {
  return keys.filter((jwk) => {
    if (jwk.kty !== kty) return false;
    if (kid !== undefined && jwk.kid !== kid) return false;
    return true;
  });
}

const jwksVerifiers = new Map<string, JwksVerifier>();

/** Returns a process-wide verifier for `url` so its key cache is shared. */
export function jwksVerifierFor(
  url: string,
  fetchFn: typeof fetch = globalThis.fetch,
): JwksVerifier {
  const existing = jwksVerifiers.get(url);
  if (existing) return existing;
  const verifier = new JwksVerifier({ url, fetch: fetchFn });
  jwksVerifiers.set(url, verifier);
  return verifier;
}

/** Test hook: forgets cached JWKS verifiers. */
export function resetJwksVerifiersForTests(): void {
  jwksVerifiers.clear();
}

interface IssuedTokenValidation {
  readonly jwksUrl?: string;
  readonly issuer?: string | readonly string[];
  readonly audience?: string | readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
}

type IssuedTokenResult =
  | { readonly valid: true; readonly verified: boolean }
  | { readonly valid: false; readonly reason: JwtClaimFailure | "signature_invalid" };

/**
 * Validates a provider-issued access token before it is persisted.
 *
 * Opaque tokens are accepted (the issuer validates them). JWTs are checked for
 * registered claims; when `jwksUrl` is configured, the signature is verified
 * too. This never throws for network failures — a JWKS outage fails closed for
 * JWTs (rejected) rather than silently trusting an unverified token.
 */
export async function validateIssuedAccessToken(
  token: string,
  options: IssuedTokenValidation = {},
): Promise<IssuedTokenResult> {
  const parsed = parseJwt(token);
  if (!parsed) return { valid: true, verified: false };
  const failure = validateJwtClaims(parsed.payload, {
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: options.clockSkewSeconds }),
  });
  if (failure) return { valid: false, reason: failure };
  if (options.jwksUrl === undefined) return { valid: true, verified: false };
  const verified = await jwksVerifierFor(
    options.jwksUrl,
    options.fetch ?? globalThis.fetch,
  ).verify(token);
  return verified ? { valid: true, verified: true } : { valid: false, reason: "signature_invalid" };
}

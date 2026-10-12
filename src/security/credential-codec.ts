/**
 * Credential-envelope codecs: the shared "decode the stored account secret,
 * pick the right field(s)" pattern for providers whose persisted credential is
 * a JSON envelope rather than a bare token.
 *
 * Envelope shapes differ per provider, so this is a family of named decoders
 * over one shared core (`decodeSecretText`, `parseEnvelopeRecord`) rather than
 * one configurable codec: each decoder keeps its provider's exact
 * field-precedence order and its exact failure semantics, because a stored
 * secret that does not match the envelope the gateway itself writes (via the
 * paired encoder in the provider's own OAuth module) means the row was
 * corrupted or written by another tool — and dispatching with a guessed token
 * would send an unusable request upstream. Fail closed, always.
 *
 * The Kimi envelope (`{accessToken, deviceId}`) is deliberately NOT here: its
 * decoder has a legacy fallback (a raw token derives a stable device id) and a
 * quota-side caller, so it stays in `kimi/kimi-oauth.ts` beside its encoder
 * and the device-id derivation it depends on.
 */
import { isRecord } from "../protocol/codecs";

const TEXT_DECODER = new TextDecoder();

/** Decodes a stored secret: UTF-8 bytes or a string, trimmed. */
export function decodeSecretText(secret: Uint8Array | string): string {
  const raw = typeof secret === "string" ? secret : TEXT_DECODER.decode(secret);
  return raw.trim();
}

/**
 * Parses a JSON-object envelope, or `undefined` when the value is not a JSON
 * object (raw legacy token, corrupted row, JSON string).
 */
export function parseEnvelopeRecord(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function fieldString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

/** `{accessToken, orgId?}` — the Kilo Code envelope (org scoping is optional). */
export interface KiloEnvelope {
  readonly accessToken: string;
  /** Organization the gateway scopes requests to; absent when the profile omits one. */
  readonly orgId?: string;
}

/**
 * Strict Kilo decoder. Only `kilo/kilo-oauth.ts` writes this secret, so a
 * value that is not the JSON envelope fails closed rather than guessing a
 * token. Callers that intercept the throw (the adapter's fail-at-upstream
 * path) keep their existing catch.
 */
export function decodeKiloCredential(secret: Uint8Array | string): KiloEnvelope {
  const decoded = decodeSecretText(secret);
  if (!decoded) throw new Error("Kilo Code credential is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("Kilo Code credential is not a JSON envelope");
  }
  const record = isRecord(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const accessToken = record === undefined ? "" : fieldString(record, "accessToken");
  if (record === undefined || !accessToken) {
    throw new Error("Kilo Code credential is missing accessToken");
  }
  const orgId = fieldString(record, "orgId");
  return orgId ? { accessToken, orgId } : { accessToken };
}

/** `{oauthAccessToken, apiKey}` — the Muse Code (Meta) envelope. */
export interface MuseEnvelope {
  readonly oauthAccessToken: string;
  readonly apiKey: string;
}

/**
 * Muse decoder. Throws plain `Error`s with three distinct messages so the
 * adapter wrapper can keep its exact 400/401 semantics:
 * - `"muse: credential is not a valid JSON blob"` — not parseable as JSON;
 * - `"muse: credential must be a JSON object"` — parseable, but not an object;
 * - `"muse: credential is missing oauthAccessToken or apiKey"` — incomplete.
 */
export function decodeMuseCredential(
  secret: Uint8Array | string,
): MuseEnvelope {
  const decoded = decodeSecretText(secret);
  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw new Error("muse: credential is not a valid JSON blob");
  }
  if (!isRecord(payload)) {
    throw new Error("muse: credential must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const oauthAccessToken = fieldString(record, "oauthAccessToken");
  const apiKey = fieldString(record, "apiKey");
  if (!oauthAccessToken || !apiKey) {
    throw new Error("muse: credential is missing oauthAccessToken or apiKey");
  }
  return { oauthAccessToken, apiKey };
}

/**
 * Generic access-token extraction with the Perplexity precedence:
 * `accessToken` → `api_key` → `apiKey` from a JSON envelope, falling back to
 * the trimmed raw secret when it is not a JSON object (which the caller then
 * normalizes as a bearer token).
 *
 * Precedence is nullish (`??`), not truthy, matching the original hand-rolled
 * implementation: an envelope whose first present field is an empty or
 * non-string value falls back to the raw secret, not to the next field.
 */
export function accessTokenFromSecret(secret: Uint8Array | string): string {
  const decoded = decodeSecretText(secret);
  const record = parseEnvelopeRecord(decoded);
  if (record !== undefined) {
    const value = record["accessToken"] ?? record["api_key"] ?? record["apiKey"];
    if (typeof value === "string" && value.length > 0) return value.trim();
  }
  return decoded;
}

/**
 * `{token, accountId, gatewayId}` — the Cloudflare AI Gateway envelope.
 *
 * The gateway cannot be reached without all three: the token authenticates, and
 * the other two are path segments of the base URL, so a stored secret missing
 * either produces a URL that cannot resolve. Decoding fails closed on all three
 * for that reason — a partial envelope would dispatch to a URL built from a
 * guess.
 */
export interface CloudflareAiGatewayEnvelope {
  readonly token: string;
  readonly accountId: string;
  readonly gatewayId: string;
}

/**
 * Strict Cloudflare AI Gateway decoder. Only `cloudflare-ai-gateway-oauth.ts`
 * writes this secret, so a value that is not the envelope fails closed rather
 * than treating a bare token as a complete credential.
 */
export function decodeCloudflareAiGatewayCredential(
  secret: Uint8Array | string,
): CloudflareAiGatewayEnvelope {
  const decoded = decodeSecretText(secret);
  if (!decoded) throw new Error("Cloudflare AI Gateway credential is empty");
  const record = parseEnvelopeRecord(decoded);
  if (record === undefined) throw new Error("Cloudflare AI Gateway credential is not a JSON envelope");
  const token = fieldString(record, "token");
  const accountId = fieldString(record, "accountId");
  const gatewayId = fieldString(record, "gatewayId");
  if (!token) throw new Error("Cloudflare AI Gateway credential is missing token");
  if (!accountId) throw new Error("Cloudflare AI Gateway credential is missing accountId");
  if (!gatewayId) throw new Error("Cloudflare AI Gateway credential is missing gatewayId");
  return { token, accountId, gatewayId };
}

/** Encodes the Cloudflare AI Gateway envelope written to the account secret. */
export function encodeCloudflareAiGatewayCredential(envelope: CloudflareAiGatewayEnvelope): string {
  return JSON.stringify({
    token: envelope.token,
    accountId: envelope.accountId,
    gatewayId: envelope.gatewayId,
  });
}

/**
 * `{token, region}` — the Alibaba Token Plan envelope.
 *
 * The region is not decoration: the two plans are served by different hosts and
 * their keys are not interchangeable, so a stored token dispatched to the wrong
 * region's base URL fails with an upstream auth error that names neither.
 */
export interface AlibabaCodingPlanEnvelope {
  readonly token: string;
  /** Region slug; the adapter resolves it to a base URL. */
  readonly region: string;
}

/**
 * Strict Alibaba Coding Plan decoder. Only `alibaba-coding-plan-oauth.ts` writes
 * this secret, so a non-envelope value fails closed rather than being read as a
 * token with an unknown region.
 */
export function decodeAlibabaCodingPlanCredential(
  secret: Uint8Array | string,
): AlibabaCodingPlanEnvelope {
  const decoded = decodeSecretText(secret);
  if (!decoded) throw new Error("Alibaba Coding Plan credential is empty");
  const record = parseEnvelopeRecord(decoded);
  if (record === undefined) throw new Error("Alibaba Coding Plan credential is not a JSON envelope");
  const token = fieldString(record, "token");
  const region = fieldString(record, "region");
  if (!token) throw new Error("Alibaba Coding Plan credential is missing token");
  if (!region) throw new Error("Alibaba Coding Plan credential is missing region");
  return { token, region };
}

/** Encodes the Alibaba Coding Plan envelope written to the account secret. */
export function encodeAlibabaCodingPlanCredential(envelope: AlibabaCodingPlanEnvelope): string {
  return JSON.stringify({ token: envelope.token, region: envelope.region });
}

/**
 * `{accessToken, orgId}` — the Factory Droid envelope.
 *
 * The org id is a JWT claim (`external_org_id`) that Factory requires as the
 * `X-Factory-Org-Id` header on every call; it cannot be recovered from the
 * bearer at dispatch time without decoding the token, so it travels with it.
 */
export interface FactoryDroidEnvelope {
  readonly accessToken: string;
  /** `external_org_id` claim — the `X-Factory-Org-Id` header value. */
  readonly orgId: string;
}

/**
 * Strict Factory Droid decoder. Only `factory-droid-oauth.ts` writes this
 * secret, so a non-envelope value fails closed: Factory scopes every request to
 * an organization, and a bare bearer with no org claim is an identity the proxy
 * rejects.
 */
export function decodeFactoryDroidCredential(secret: Uint8Array | string): FactoryDroidEnvelope {
  const decoded = decodeSecretText(secret);
  if (!decoded) throw new Error("Factory Droid credential is empty");
  const record = parseEnvelopeRecord(decoded);
  if (record === undefined) throw new Error("Factory Droid credential is not a JSON envelope");
  const accessToken = fieldString(record, "accessToken");
  const orgId = fieldString(record, "orgId");
  if (!accessToken) throw new Error("Factory Droid credential is missing accessToken");
  if (!orgId) throw new Error("Factory Droid credential is missing orgId");
  return { accessToken, orgId };
}

/** Encodes the Factory Droid envelope written to the account secret. */
export function encodeFactoryDroidCredential(envelope: FactoryDroidEnvelope): string {
  return JSON.stringify({ accessToken: envelope.accessToken, orgId: envelope.orgId });
}

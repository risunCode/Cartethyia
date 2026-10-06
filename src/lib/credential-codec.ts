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
import { isRecord } from "../protocol/primitives";

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

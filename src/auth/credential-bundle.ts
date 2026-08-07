/**
 * Shared credential-bundle codec for providers that store an OAuth access
 * token either as a raw string or as a JSON object (`{ accessToken, ... }`).
 *
 * Each provider previously re-implemented this trim/parse/extract dance with
 * subtly different edge-case handling. This module is the single source of
 * truth; provider auth drivers and adapters consume it instead of
 * re-deriving the shape.
 */

/**
 * Extracts the bearer access token from a stored credential.
 *
 * Accepts:
 *  - a raw token string (returned as-is when non-empty)
 *  - a JSON object with a non-empty `accessToken` string field
 *
 * Returns `undefined` when the credential is empty, malformed JSON, or the
 * object lacks a usable access token. Callers that want to fall back to the
 * raw string on parse failure (instead of treating it as an error) should
 * use {@link extractAccessTokenOrRaw}.
 */
export function extractAccessToken(credential: string): string | undefined {
  const trimmed = credential.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).accessToken;
        if (typeof value === "string" && value.length > 0) return value;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  return trimmed;
}

/**
 * Like {@link extractAccessToken}, but falls back to returning the raw
 * credential string when the JSON parse fails or the object lacks an
 * `accessToken` field. Use this for providers that treat malformed JSON
 * as a raw API key so the upstream returns a typed auth error.
 */
export function extractAccessTokenOrRaw(credential: string): string {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const access = (parsed as Record<string, unknown>).accessToken;
      if (typeof access === "string" && access.length > 0) return access;
    }
  } catch {
    // Treat malformed JSON as a raw API key so the upstream returns a typed auth error.
  }
  return trimmed;
}

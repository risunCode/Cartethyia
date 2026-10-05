/**
 * Automatic static-token detection.
 *
 * An OAuth account whose refresh grant is dead is not necessarily unusable: the
 * access token it already holds may still be well inside its own validity, in
 * which case the account keeps serving exactly as issued and the only correct
 * change is to stop trying to refresh it. This module answers that one question
 * from local evidence alone — the stored access token's own `exp` claim — so
 * both the refresh path and a boot-time backfill can tell
 * "the refresh grant died but the token still works" apart from
 * "the credential is dead and the operator must re-login".
 *
 * Structural only: the token is decoded, never verified. The signature's trust
 * boundary is the TLS hop it arrived on, the same reasoning
 * `providers/authentication/jwt-validator.ts` documents for provider-issued
 * tokens; here the token is already stored, so verification would add nothing.
 */
import { decodeJwtPayload } from "./oauth-flow-store";

export type AccessTokenUsability = "usable" | "expired" | "undecodable";

/**
 * Margin (seconds) subtracted from `exp` before a token counts as usable, so a
 * token about to lapse is never adopted as static — it would be parked as
 * "usable" only to be rejected by the very next dispatch.
 */
export const STATIC_TOKEN_EXPIRY_SKEW_SECONDS = 300;

/**
 * Classifies a stored access token by whether it can still be used as issued.
 *
 * `usable` requires a decodable JWT whose `exp` is comfortably in the future.
 * An opaque token has no `exp` to read, so it is `undecodable` — treated like
 * an expired one, because "the issuer validates it" is not evidence the issuer
 * still accepts it. `undecodable` therefore means "cannot be shown to work",
 * not "known bad".
 */
export function classifyAccessTokenUsability(
  token: string | undefined | null,
  nowMs: number = Date.now(),
): AccessTokenUsability {
  if (typeof token !== "string" || token.length === 0) return "undecodable";
  const payload = decodeJwtPayload(token);
  if (!payload) return "undecodable";
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return "undecodable";
  return exp * 1000 - STATIC_TOKEN_EXPIRY_SKEW_SECONDS * 1000 > nowMs ? "usable" : "expired";
}

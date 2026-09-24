/**
 * Retry-policy predicates shared by the canonical proxy routes and the native
 * Responses-compact route.
 *
 * These answer two questions the attempt loop asks on every failure: "is this
 * credential itself dead, so refreshing could help?" and "is this a provider
 * rate limit, so the pool should cool down?". They live beside the loop rather
 * than inside it so the loop stays a policy *consumer* — one place decides
 * retryability (`../failure-policy.ts`), one place decides refresh and
 * cooldown eligibility (here).
 */
import { GatewayError } from "../gateway-error";

/**
 * Returns true only when an upstream failure is evidence that the OAuth
 * credential itself is invalid. A provider 403 is not enough: CodeBuddy uses
 * 403 for deterministic safety/content policy rejection (`code: 11140`), and
 * refreshing the token cannot change that request outcome.
 */
export function isOAuthCredentialInvalidated(error: unknown): error is GatewayError {
  if (!(error instanceof GatewayError)) return false;
  if (error.status !== 403) {
    return error.code === "authentication_failed" && error.details.credentialEvidence === true;
  }
  const providerCode = typeof error.details.providerCode === "string" ? error.details.providerCode : "";
  const message = `${error.message} ${String(error.details.raw ?? "")}`;
  if (providerCode.toLowerCase() === "11140" || /safety review|content.{0,12}pass|request illegal|content blocked/i.test(message)) return false;
  // A hosted-tool failure (web search / x search / web fetch) is a per-request
  // outcome of the provider's own server-side tool, not a credential signal:
  // refreshing the OAuth token cannot fix it.
  if (/web[ _-]?search|web[ _-]?fetch|x[ _-]?search|tool invocation|search backend/i.test(message)) return false;
  return error.details.credentialEvidence === true;
}

/**
 * A provider-scoped 429: the pool this request dialed through is being rate
 * limited *by the upstream provider*, so the pool should cool down for that
 * provider. A bare 429 without provider scope is a request-level limit and
 * must not sideline the whole pool.
 */
export function shouldCooldownPool(error: unknown): error is GatewayError {
  return (
    error instanceof GatewayError &&
    error.origin === "upstream" &&
    error.status === 429 &&
    error.details.rateLimitScope === "provider"
  );
}

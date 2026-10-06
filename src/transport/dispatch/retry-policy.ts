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
import { GatewayError } from "../../protocol/gateway-error";
import { providerRateLimitIsIpScoped } from "../../providers/metadata";

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
 * A provider-scoped 429, on a provider whose limits follow the egress address.
 *
 * Only then is the pool the thing that ran out: the upstream counted requests
 * from this address, so the next attempt must leave by a different one and
 * cooling this pool is the fix. `providerRateLimitIsIpScoped` holds that fact
 * per provider (see the metadata field) rather than inferring it from the
 * response — a 429 states which bucket was exhausted only in the provider's own
 * wording, and every account-keyed provider words it the same way.
 *
 * For an account-keyed provider the 429 belongs to the credential that was
 * dialed. The account health machine already records it and routes the next
 * request to a sibling, so cooling the pool as well only removed healthy
 * accounts from service: every account sharing that egress lost its route for
 * the cooldown window because one of them hit its own limit. A bare 429 with no
 * provider scope stays a request-level limit and never cools the pool.
 *
 * `providerId` is the caller's own candidate, not a field read off the error:
 * the in-stream error frames the protocol modules build carry no `providerId`
 * detail, so reading it from `details` would silently disable the IP-scoped
 * rule on exactly the streaming path it exists for.
 *
 * A type guard on `GatewayError`, so a caller that passes this check can hand
 * the same value to `flagPoolCooldown` without a second narrowing step.
 */
export function shouldCooldownPool(error: unknown, providerId: string): error is GatewayError {
  if (
    !(
      error instanceof GatewayError &&
      error.origin === "upstream" &&
      error.status === 429 &&
      error.details.rateLimitScope === "provider"
    )
  ) {
    return false;
  }
  return providerRateLimitIsIpScoped(providerId);
}

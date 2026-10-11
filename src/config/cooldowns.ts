/**
 * Account/pool health cooldown fallback resolvers.
 */

import { CONFIG_SPEC, readInt } from "./spec";

/** Fallback cooldown for a provider rate limit (default 15m). */
export function resolveAccountRateLimitCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  );
}

/**
 * Fallback cooldown for provider quota exhaustion when the error states no
 * reset window (default 1h). A provider-specific rule (xAI Grok Build's
 * rolling 24-hour free-tier window) overrides it inside the classifier.
 */
export function resolveAccountQuotaCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS,
  );
}

/** Fallback cooldown for model-capacity overload (default 2m). */
export function resolveAccountModelCapacityCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS,
  );
}

/** Backoff for a transient 5xx/network fault, recorded as `cooldown` (default 30s). */
export function resolveAccountTransientCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS,
  );
}

/** Backoff for a failure no rule matched, recorded as `cooldown` (default 1m). */
export function resolveAccountUnclassifiedCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS,
  );
}

/**
 * Ceiling an escalated fallback cooldown may reach (default 1h).
 *
 * A fallback duration is one the provider never stated, so escalating it is our
 * own estimate. The cap keeps that estimate from outliving a short transient
 * window: an account that recovers on its own must not sit parked for a day
 * because a burst of 5xx happened to arrive while it was already cooling.
 */
export function resolveAccountCooldownEscalationMaxMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_COOLDOWN_ESCALATION_MAX_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_COOLDOWN_ESCALATION_MAX_MS,
  );
}

/** How long a proxy pool stays `cooldown` after a transport fault (default 2m). */
export function resolvePoolCooldownMs(): number {
  return readInt("CARTETHYIA_POOL_COOLDOWN_MS", CONFIG_SPEC.CARTETHYIA_POOL_COOLDOWN_MS);
}

/**
 * Backoff for an auth rejection that names no revocation (default 5m).
 *
 * A bare `401`/`403` is weak evidence: it covers clock skew, a key rotated
 * upstream a moment ago, an edge cache, and a load balancer that answers before
 * the credential is loaded. None of those is the credential's death, and this
 * outcome used to be `disabled` — the one state no sweep recovers, so the
 * account left rotation until an operator noticed. A cooldown costs the same
 * requests for five minutes and comes back on its own.
 *
 * Only a *named* revocation (`token revoked`, `invalidated oauth token`) still
 * parks the account: the upstream stated the credential itself is dead, there is
 * no expiry to wait out and no refresh to run, so a cooldown would only return
 * it to rotation to fail again. Set this to `0` to restore the old behavior.
 */
export function resolveAccountAuthRejectedCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_AUTH_REJECTED_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_AUTH_REJECTED_COOLDOWN_MS,
  );
}

/**
 * Base backoff for the buddy policy/channel block (`11140`, `11128`) (default 5m).
 *
 * Deliberately a *base*, not the 24h flat penalty it replaced. `11140` has two
 * documented causes our classifier cannot separate from the response alone: the
 * user's prompt failed a safety review, **and** sending the wrong desktop
 * `User-Agent` brand (`workbuddy-shared.ts`). A flat 24h meant that after we
 * fixed a header regression every buddy account stayed dead for up to a further
 * day, and one unsafe prompt cost a whole account a day.
 *
 * As a base it escalates through the consecutive-failure ladder instead, which
 * distinguishes the two causes by what they do next: a genuinely blocked account
 * is refused again on its very next request and parks itself within minutes,
 * while a single bad prompt costs five minutes.
 */
export function resolveAccountPolicyBlockCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_POLICY_BLOCK_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_POLICY_BLOCK_COOLDOWN_MS,
  );
}

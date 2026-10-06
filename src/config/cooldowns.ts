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

/** How long a proxy pool stays `cooldown` after a transport fault (default 2m). */
export function resolvePoolCooldownMs(): number {
  return readInt("CARTETHYIA_POOL_COOLDOWN_MS", CONFIG_SPEC.CARTETHYIA_POOL_COOLDOWN_MS);
}

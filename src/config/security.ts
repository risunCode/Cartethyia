/**
 * Security resolvers: the application encryption key, the abuse-protection
 * ceiling, and model-abuse strike/ban windows.
 */

import { CONFIG_SPEC, readInt, readRequired } from "./spec";

const ENCRYPTION_KEY_LENGTH = 32;

/**
 * Per-IP request ceiling for the unauthenticated abuse-protection layer.
 * Defaults to 240 requests per window so an unset env does not mean unlimited;
 * operators tune it via `IP_RATE_MAX_PER_WINDOW`.
 */
export function resolveIpRateLimit(): number {
  return readInt("IP_RATE_MAX_PER_WINDOW", CONFIG_SPEC.IP_RATE_MAX_PER_WINDOW);
}

/** Invalid-model attempts inside the window that ban a client address. */
export function resolveModelStrikeThreshold(): number {
  return readInt(
    "CARTETHYIA_MODEL_STRIKE_THRESHOLD",
    CONFIG_SPEC.CARTETHYIA_MODEL_STRIKE_THRESHOLD,
  );
}

/** Sliding window (ms) that keeps an invalid-model attempt countable. */
export function resolveModelStrikeWindowMs(): number {
  return readInt(
    "CARTETHYIA_MODEL_STRIKE_WINDOW_MS",
    CONFIG_SPEC.CARTETHYIA_MODEL_STRIKE_WINDOW_MS,
  );
}

/** How long (ms) a model-abuse ban lasts before it lapses on its own. */
export function resolveModelBanTtlMs(): number {
  return readInt("CARTETHYIA_MODEL_BAN_TTL_MS", CONFIG_SPEC.CARTETHYIA_MODEL_BAN_TTL_MS);
}

/** Reads the application encryption key without caching it. */
export function requireEncryptionKeyEnv(): string {
  return readRequired("CARTETHYIA_ENCRYPTION_KEY", CONFIG_SPEC.CARTETHYIA_ENCRYPTION_KEY);
}

/** Decodes and validates a base64 or hexadecimal 256-bit encryption key. */
export function decodeEncryptionKey(raw: string): Buffer {
  const candidate = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(candidate)
    ? Buffer.from(candidate, "hex")
    : Buffer.from(candidate, "base64");
  if (buf.length !== ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `CARTETHYIA_ENCRYPTION_KEY must decode to exactly ${ENCRYPTION_KEY_LENGTH} bytes (got ${buf.length}); ` +
        "provide a base64 or hex encoded 256-bit key",
    );
  }
  return buf;
}

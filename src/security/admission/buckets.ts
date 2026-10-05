import type { UsageRecord } from "../../transport/canonical-model";

/**
 * Bucket-qualified counter key. Daily and monthly budgets must roll over on
 * the calendar boundary rather than accumulating forever, so the bucket is
 * part of the key — exactly as the Redis store builds
 * `admission:daily:<apiKeyId>:<YYYY-MM-DD>`.
 */
export function bucketKey(apiKeyId: string, bucket: string): string {
  return `${apiKeyId}:${bucket}`;
}

export function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

export function knownTokens(value: number | "unavailable" | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Token total charged to a key's counters.
 *
 * `normalizeUsage` already folds cache writes into `input_tokens` (the
 * Anthropic cache shape adds read + written to the fresh count) and reasoning
 * tokens are a breakdown *of* `output_tokens` on both wire families — the
 * pricing path in `providers/usage.ts` subtracts reasoning from output for the
 * same reason. Adding them again here charged the same tokens twice, so a key
 * hit its budget while it still had real headroom.
 */
export function usageTokens(usage: UsageRecord): number {
  return knownTokens(usage.input_tokens) + knownTokens(usage.output_tokens);
}

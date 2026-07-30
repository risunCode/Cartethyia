/**
 * Per-key concurrent in-flight counters — separate from the global
 * in-flight gauge used by the console live dashboard.
 */

const keyCounts = new Map<string, number>();

export function getKeyInFlightCount(keyId: string): number {
  return keyCounts.get(keyId) ?? 0;
}

/** Returns false when the key is already at its concurrent request cap. */
export function tryAcquireKeySlot(keyId: string, maxConcurrent: number): boolean {
  const current = keyCounts.get(keyId) ?? 0;
  if (current >= maxConcurrent) return false;
  keyCounts.set(keyId, current + 1);
  return true;
}

export function releaseKeySlot(keyId: string): void {
  const current = keyCounts.get(keyId) ?? 0;
  if (current <= 1) keyCounts.delete(keyId);
  else keyCounts.set(keyId, current - 1);
}

/** Clears a deleted key's slot counter immediately. */
export function purgeKeyInFlightState(keyId: string): void {
  keyCounts.delete(keyId);
}

/** Test-only: reset all per-key counters. */
export function resetKeyInFlightForTests(): void {
  keyCounts.clear();
}

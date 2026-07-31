/**
 * Per-key concurrent in-flight counters — separate from the global
 * in-flight gauge used by the console live dashboard.
 */

const keyCounts = new Map<string, number>();

/**
 * Per-key token reservation for in-flight requests. `sumDailyTokensForKey`/
 * `sumMonthlyTokensForKey` only reflect USAGE ALREADY COMMITTED to SQLite
 * after a response finishes; N concurrent requests on the same key all read
 * the same committed sum before any of them finish, so all N pass the limit
 * check and the key can overshoot its cap by up to N times the per-request
 * cost. Reserving a conservative token estimate here the instant the check
 * passes (synchronously, before any `await`, so no other request can
 * interleave) makes every subsequent concurrent check on that key see the
 * reservation immediately, closing the race for the common case.
 */
const reservedTokensByKey = new Map<string, number>();

export function getReservedTokensForKey(keyId: string): number {
  return reservedTokensByKey.get(keyId) ?? 0;
}

export function reserveTokensForKey(keyId: string, amount: number): void {
  reservedTokensByKey.set(keyId, (reservedTokensByKey.get(keyId) ?? 0) + amount);
}

export function releaseTokenReservationForKey(keyId: string, amount: number): void {
  const current = reservedTokensByKey.get(keyId) ?? 0;
  if (current <= amount) reservedTokensByKey.delete(keyId);
  else reservedTokensByKey.set(keyId, current - amount);
}

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
  reservedTokensByKey.delete(keyId);
}

/** Test-only: reset all per-key counters. */
export function resetKeyInFlightForTests(): void {
  keyCounts.clear();
  reservedTokensByKey.clear();
}

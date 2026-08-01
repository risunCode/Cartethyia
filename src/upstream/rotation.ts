/**
 * Shared stateful round-robin primitive (REQ-6): a sticky, `Map`-backed
 * index used by provider-account round-robin selection
 * (`console/db/repos/accounts.ts`), advanced via `nextRotationIndex()`.
 */

export interface RotationState {
  index: number;
  usesLeft: number;
}

/**
 * Advances (or holds) `state.index` and returns it. `stickyLimit` is how
 * many consecutive picks stay on the same index before moving to the next
 * one; pass `1` for plain round-robin (advance every call).
 */
export function nextRotationIndex(state: RotationState, length: number, stickyLimit: number): number {
  const limit = stickyLimit > 0 ? stickyLimit : 1;
  if (state.index >= length) state.index = 0;
  if (state.usesLeft <= 0) {
    state.index = (state.index + 1) % length;
    state.usesLeft = limit;
  }
  state.usesLeft -= 1;
  return state.index;
}

export function createRotationStore<K>(): Map<K, RotationState> {
  return new Map<K, RotationState>();
}

/** Reads (or lazily creates) the rotation state for `key`, advances it, and returns the picked index. */
export function pickRotationIndex<K>(store: Map<K, RotationState>, key: K, length: number, stickyLimit: number): number {
  const limit = stickyLimit > 0 ? stickyLimit : 1;
  const state = store.get(key) ?? { index: 0, usesLeft: limit };
  const index = nextRotationIndex(state, length, stickyLimit);
  store.set(key, state);
  return index;
}

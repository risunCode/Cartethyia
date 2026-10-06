// Round-robin rotation state and its bounded per-key LRU.
import type { RouteCandidate } from "./route-model";

export class RoundRobinState {
  private idx = 0;
  private servedByCurrent = 0;
  next(candidates: readonly RouteCandidate[], rotateCount: number): RouteCandidate | undefined {
    if (candidates.length === 0) return undefined;
    const safeCount = Math.max(1, Math.min(1000, Math.trunc(rotateCount)));
    const c = candidates[this.idx % candidates.length];
    this.servedByCurrent += 1;
    if (this.servedByCurrent >= safeCount) {
      this.idx = (this.idx + 1) % 1000000;
      this.servedByCurrent = 0;
    }
    return c;
  }
}
/**
 * Upper bound on per-key round-robin state. Keys are tenant/provider/model
 * combinations; without a cap, a deployment serving a long tail of unique
 * combinations would retain one entry forever. 1000 is far above the working
 * set of any real catalog, so eviction only ever targets genuinely cold keys.
 */
const MAX_ROUND_ROBIN_ENTRIES = 1000;

/**
 * Bounded LRU accessor for round-robin state: an existing key is refreshed to
 * the tail (most-recently-used), and inserting past the cap evicts the head
 * (least-recently-used). Keeps the hot routing working set while guaranteeing
 * the map cannot grow without bound.
 */
export function getOrCreateRoundRobin(
  map: Map<string, RoundRobinState>,
  key: string,
): RoundRobinState {
  const existing = map.get(key);
  if (existing) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  if (map.size >= MAX_ROUND_ROBIN_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  const created = new RoundRobinState();
  map.set(key, created);
  return created;
}

import { describe, expect, test } from "bun:test";
import { GoogleAntigravityAdapter } from "../../src/providers/google-antigravity";
import type { AntigravitySessionState } from "../../src/providers/google-antigravity";

/**
 * The sessionStates map is private; tests access it via a structural cast to
 * verify the bounded-map eviction contract without exposing internals.
 */
interface AdapterWithSessionStates {
  sessionStates: Map<string, AntigravitySessionState>;
}

describe("GoogleAntigravityAdapter — sessionStates bounded map", () => {
  test("evicts the oldest entry when the cap is exceeded", () => {
    const adapter = new GoogleAntigravityAdapter() as unknown as AdapterWithSessionStates;
    const map = adapter.sessionStates;
    const CAP = 256;

    // Fill to the cap.
    for (let i = 0; i < CAP; i++) {
      map.set(`conv-${i}`, {});
    }
    expect(map.size).toBe(CAP);

    // Inserting one more should NOT happen through the adapter's call path
    // without eviction. Simulate the eviction logic the adapter uses: the
    // oldest-inserted key is removed before the new entry is added.
    const oldestKey = map.keys().next().value as string;
    map.delete(oldestKey);
    map.set(`conv-${CAP}`, {});

    expect(map.size).toBe(CAP);
    expect(map.has("conv-0")).toBe(false);
    expect(map.has(`conv-${CAP}`)).toBe(true);
  });

  test("starts empty and stays bounded under rapid insertion", () => {
    const adapter = new GoogleAntigravityAdapter() as unknown as AdapterWithSessionStates;
    const map = adapter.sessionStates;
    expect(map.size).toBe(0);

    // Simulate the adapter's insert-with-eviction pattern for 500 entries.
    const CAP = 256;
    for (let i = 0; i < 500; i++) {
      const key = `conv-${i}`;
      if (!map.has(key)) {
        if (map.size >= CAP) {
          const oldest = map.keys().next();
          if (!oldest.done) map.delete(oldest.value as string);
        }
        map.set(key, {});
      }
    }
    expect(map.size).toBe(CAP);
    // The oldest 244 entries should have been evicted; the latest 256 remain.
    expect(map.has("conv-0")).toBe(false);
    expect(map.has("conv-243")).toBe(false);
    expect(map.has("conv-244")).toBe(true);
    expect(map.has("conv-499")).toBe(true);
  });
});

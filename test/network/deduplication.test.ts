import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dedupeRequest, inFlightRequestCount, resetDeduplicationForTesting } from "../../src/network/deduplication";

// `deduplication.ts` holds one process-wide in-flight map, so a key left over
// from another suite (the version cache uses the same `dedupeRequest` space)
// would make a test here read a stale promise instead of running its own
// loader. Reset on both sides so each test starts from a known-empty map.
beforeEach(() => {
  resetDeduplicationForTesting();
});

afterEach(() => {
  resetDeduplicationForTesting();
});

describe("dedupeRequest", () => {
  test("shares one in-flight promise across concurrent callers", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = async (): Promise<string> => {
      calls += 1;
      await gate;
      return "value";
    };

    const first = dedupeRequest("k", fn);
    const second = dedupeRequest("k", fn);
    expect(calls).toBe(1);
    expect(inFlightRequestCount()).toBe(1);

    release();
    expect(await first).toBe("value");
    expect(await second).toBe("value");
  });

  test("forgets the key once settled so a later call runs fresh", async () => {
    let calls = 0;
    const fn = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    expect(await dedupeRequest("k", fn)).toBe(1);
    expect(inFlightRequestCount()).toBe(0);
    expect(await dedupeRequest("k", fn)).toBe(2);
  });

  test("keeps distinct keys independent", async () => {
    const a = dedupeRequest("a", async () => "a");
    const b = dedupeRequest("b", async () => "b");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });

  test("propagates failures to every waiter without memoizing them", async () => {
    let calls = 0;
    const failing = async (): Promise<never> => {
      calls += 1;
      throw new Error("boom");
    };
    const first = dedupeRequest("k", failing);
    const second = dedupeRequest("k", failing);
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(calls).toBe(1);

    // A subsequent call retries instead of replaying the cached rejection.
    await expect(dedupeRequest("k", failing)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});

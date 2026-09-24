import { afterEach, describe, expect, test } from "bun:test";
import { getCachedVersion, resetVersionCacheForTesting } from "../../../src/providers/operations/provider-version-cache";
import { resetDeduplicationForTesting } from "../../../src/network/deduplication";

afterEach(() => {
  resetVersionCacheForTesting();
  resetDeduplicationForTesting();
});

describe("getCachedVersion", () => {
  test("loads once and serves the cached value within the TTL", async () => {
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      return `1.2.${calls}`;
    };
    expect(await getCachedVersion("k", loader)).toBe("1.2.1");
    expect(await getCachedVersion("k", loader)).toBe("1.2.1");
    expect(calls).toBe(1);
  });

  test("reloads once the TTL expires", async () => {
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      return `v${calls}`;
    };
    expect(await getCachedVersion("k", loader, { ttlMs: 0 })).toBe("v1");
    expect(await getCachedVersion("k", loader, { ttlMs: 0 })).toBe("v2");
    expect(calls).toBe(2);
  });

  test("does not cache a null result so a later call retries", async () => {
    let calls = 0;
    const loader = async (): Promise<string | null> => {
      calls += 1;
      return calls === 1 ? null : "1.0.0";
    };
    expect(await getCachedVersion("k", loader)).toBeNull();
    expect(await getCachedVersion("k", loader)).toBe("1.0.0");
    expect(calls).toBe(2);
  });

  test("retries a failing loader and rethrows when exhausted", async () => {
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      throw new Error("registry down");
    };
    await expect(getCachedVersion("k", loader, { maxRetries: 1 })).rejects.toThrow("registry down");
    // 1 initial attempt + 1 retry.
    expect(calls).toBe(2);
  });

  test("shares one in-flight load across concurrent misses", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async (): Promise<string> => {
      calls += 1;
      await gate;
      return "9.9.9";
    };
    const first = getCachedVersion("k", loader);
    const second = getCachedVersion("k", loader);
    release();
    expect(await first).toBe("9.9.9");
    expect(await second).toBe("9.9.9");
    expect(calls).toBe(1);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  closeRedis,
  getRedis,
  getRedisOrUndefined,
  redisEvalNumber,
  setRedisForTesting,
} from "../../src/persistence/redis";

afterEach(() => {
  globalThis.__cartethyiaRedis = undefined;
  delete process.env.REDIS_URL;
});

describe("requireRedisUrl (via getRedis)", () => {
  test("throws without REDIS_URL", () => {
    // The repo .env sets REDIS_URL for the operator; the unit boundary is
    // "no URL configured", so clear it explicitly instead of assuming it.
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      expect(() => getRedis()).toThrow("REDIS_URL is required");
      expect(getRedisOrUndefined()).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
    }
  });

  test("throws on a malformed REDIS_URL", () => {
    process.env.REDIS_URL = "not-a-url";
    expect(() => getRedis()).toThrow("REDIS_URL is not a valid URL");
  });

  test("throws without explicit host and port", () => {
    process.env.REDIS_URL = "redis://localhost";
    expect(() => getRedis()).toThrow("must include explicit host and port");
  });
});

describe("closeRedis", () => {
  test("no-ops with no shared connection", async () => {
    await closeRedis();
  });

  test("quits and clears the shared client", async () => {
    let quitCalls = 0;
    const fake = { quit: async () => { quitCalls += 1; }, disconnect: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRedisForTesting(fake as any);
    await closeRedis();
    expect(quitCalls).toBe(1);
    expect(globalThis.__cartethyiaRedis).toBeUndefined();
  });

  test("falls back to disconnect when quit times out", async () => {
    let disconnectCalls = 0;
    const fake = {
      quit: async () => {
        await Bun.sleep(500);
      },
      disconnect: () => { disconnectCalls += 1; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRedisForTesting(fake as any);
    await closeRedis({ quitTimeoutMs: 10 });
    expect(disconnectCalls).toBe(1);
  });
});

describe("redisEvalNumber", () => {
  test("returns a finite numeric result", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { eval: async () => 7 } as any;
    expect(await redisEvalNumber(fake, "script", 1, "k")).toBe(7);
  });

  test("coerces numeric strings", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { eval: async () => "42" } as any;
    expect(await redisEvalNumber(fake, "script", 1, "k")).toBe(42);
  });

  test("throws on NaN or garbled results", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nan = { eval: async () => "garbage" } as any;
    await expect(redisEvalNumber(nan, "script", 1, "k")).rejects.toThrow("non-finite");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const undef = { eval: async () => undefined } as any;
    await expect(redisEvalNumber(undef, "script", 1, "k")).rejects.toThrow("non-finite");
  });
});

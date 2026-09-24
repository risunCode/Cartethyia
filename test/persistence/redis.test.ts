import { describe, expect, test } from "bun:test";
import { redisEvalNumber, type RedisClient } from "../../src/persistence/redis";

function stubRedis(result: unknown): RedisClient {
  return { eval: async () => result } as unknown as RedisClient;
}

describe("redisEvalNumber", () => {
  test("returns finite numeric results as numbers", async () => {
    await expect(redisEvalNumber(stubRedis(1), "return 1", 0)).resolves.toBe(1);
    await expect(redisEvalNumber(stubRedis("2"), "return 2", 1, "key")).resolves.toBe(2);
  });

  test("rejects garbled results instead of propagating NaN to counters", async () => {
    await expect(redisEvalNumber(stubRedis("garbage"), "return 1", 0)).rejects.toThrow(
      /non-finite/,
    );
    await expect(redisEvalNumber(stubRedis(undefined), "return 1", 0)).rejects.toThrow(
      /non-finite/,
    );
  });
});

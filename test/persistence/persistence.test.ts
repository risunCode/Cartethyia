import { describe, expect, test } from "bun:test";
import { closeRedis, setRedisForTesting, type RedisClient } from "../../src/persistence/redis";
import { PgDialect } from "drizzle-orm/pg-core";
import { providers } from "../../src/persistence/schema";
import { globalOrOwnedBy, ownedByOnly } from "../../src/persistence/tenant-scope";

describe("redis.test.ts", () => {
interface FakeRedisState {
  quitCalls: number;
  disconnectCalls: number;
  evalCalls: Array<{ scriptArgs: unknown[] }>;
  hashes: Map<string, Map<string, string>>;
  quitBehavior: "ok" | "hang" | "throw";
}

function makeFakeRedis(state: FakeRedisState): RedisClient {
  return {
    scan: async (_cursor: string) => {
      void _cursor;
      return ["0", [...state.hashes.keys()].filter((k) => k.startsWith("admission:lease:"))];
    },
    hget: async (key: string, field: string) => {
      const value = state.hashes.get(key)?.get(field);
      return value ?? null;
    },
    eval: async (...args: unknown[]) => {
      state.evalCalls.push({ scriptArgs: args });
      return 0;
    },
    quit: async () => {
      state.quitCalls += 1;
      if (state.quitBehavior === "hang") await new Promise<never>(() => {});
      if (state.quitBehavior === "throw") throw new Error("connection lost");
      return "OK";
    },
    disconnect: () => {
      state.disconnectCalls += 1;
    },
  } as unknown as RedisClient;
}

function makeState(overrides?: Partial<FakeRedisState>): FakeRedisState {
  return {
    quitCalls: 0,
    disconnectCalls: 0,
    evalCalls: [],
    hashes: new Map(),
    quitBehavior: "ok",
    ...overrides,
  };
}

describe("closeRedis", () => {
  test("quits gracefully without disconnecting when QUIT resolves", async () => {
    const state = makeState();
    setRedisForTesting(makeFakeRedis(state));
    await closeRedis({ quitTimeoutMs: 50 });
    expect(state.quitCalls).toBe(1);
    expect(state.disconnectCalls).toBe(0);
    // Client cleared: a second close is a no-op.
    await closeRedis({ quitTimeoutMs: 50 });
    expect(state.quitCalls).toBe(1);
  });

  test("falls back to disconnect when QUIT does not resolve in time", async () => {
    const state = makeState({ quitBehavior: "hang" });
    setRedisForTesting(makeFakeRedis(state));
    await closeRedis({ quitTimeoutMs: 10 });
    expect(state.quitCalls).toBe(1);
    expect(state.disconnectCalls).toBe(1);
  });

  test("falls back to disconnect when QUIT rejects", async () => {
    const state = makeState({ quitBehavior: "throw" });
    setRedisForTesting(makeFakeRedis(state));
    await closeRedis({ quitTimeoutMs: 50 });
    expect(state.quitCalls).toBe(1);
    expect(state.disconnectCalls).toBe(1);
  });
});
});

describe("tenant-scope.test.ts", () => {
const dialect = new PgDialect();

describe("tenant ownership scope", () => {
  test("tenant requester matches global rows plus its own", () => {
    const query = dialect.sqlToQuery(
      globalOrOwnedBy(providers.tenantId, "11111111-1111-4111-8111-111111111111") as never,
    );
    expect(query.params).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(query.sql).toMatch(/is null/i);
  });

  test("platform requester (null) matches global rows only — never `= NULL`", () => {
    const query = dialect.sqlToQuery(globalOrOwnedBy(providers.tenantId, null) as never);
    expect(query.params).toEqual([]);
    expect(query.sql).toMatch(/is null/i);
    expect(query.sql).not.toMatch(/=\s*\$/);
  });

  test("ownedByOnly never matches global rows", () => {
    const query = dialect.sqlToQuery(
      ownedByOnly(providers.tenantId, "11111111-1111-4111-8111-111111111111") as never,
    );
    expect(query.sql).not.toMatch(/is null/i);
  });
});
});

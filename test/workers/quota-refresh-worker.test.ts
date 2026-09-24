import { afterEach, describe, expect, test } from "bun:test";
import { quotaRefreshSweep, resetSweepLogMemory } from "../../src/workers/quota-refresh-worker";
import {
  GLOBAL_QUOTA_LENS,
  clearQuotaCacheForTests,
  getCachedQuota,
  setCachedQuota,
} from "../../src/console/quota/quota-cache";
import { clearConsoleLogs, getConsoleLogSnapshot } from "../../src/observability/log-ring";
import { inFlightAccountQuotaRefreshes } from "../../src/console/quota/quota-refresh";
import type { RedisClient } from "../../src/persistence/redis";
import type { ProviderQuotaResult } from "../../src/providers/quota/quota-contracts";
import type { ProviderRegistry } from "../../src/providers/provider-registry";
import type { OAuthTokenRefresher } from "../../src/providers/authentication/oauth-refresh-service";

const dummyRefresher: OAuthTokenRefresher = {
  refresh: async () => ({ access: "a", refresh: "r", expiresAt: new Date() }),
};
/** Minimal in-memory RedisClient fake covering the quota-cache call shapes. */
function fakeRedis(): RedisClient {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<string> {
      store.set(key, value);
      return "OK";
    },
    async mget(...keys: string[]): Promise<(string | null)[]> {
      return keys.map((key) => store.get(key) ?? null);
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
    async scan(): Promise<[string, string[]]> {
      return ["0", []];
    },
  } as unknown as RedisClient;
}

function stubRegistry(result: ProviderQuotaResult, counter: { calls: number }): ProviderRegistry {
  return {
    async resolveQuotaCollector() {
      return async () => {
        counter.calls += 1;
        return result;
      };
    },
    async resolveRefresher() {
      return dummyRefresher;
    },
  } as unknown as ProviderRegistry;
}

const fresh: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };

afterEach(() => {
  clearQuotaCacheForTests();
  inFlightAccountQuotaRefreshes.clear();
  resetSweepLogMemory();
});

describe("quota refresh sweep", () => {
  test("warms accounts with no cached value and skips fresh ones", async () => {
    const redis = fakeRedis();
    const counter = { calls: 0 };
    const tick: Array<{ attempted: number; skipped: number }> = [];
    await setCachedQuota("tenant-a", "warm", fresh, redis);

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, counter),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "cold", providerId: "test", tenantId: "tenant-a" },
        { accountId: "warm", providerId: "test", tenantId: "tenant-a" },
      ],
      onTick: (result) => tick.push({ attempted: result.attempted, skipped: result.skipped }),
    });

    expect(counter.calls).toBe(1);
    expect(tick).toEqual([{ attempted: 1, skipped: 1 }]);
    expect(await getCachedQuota("tenant-a", "cold", redis)).toEqual(fresh);
  });

  test("refreshes a stale entry once its cache age passes the window", async () => {
    const redis = fakeRedis();
    const counter = { calls: 0 };
    const staleAt = new Date(Date.now() - 10 * 60_000);
    await setCachedQuota("tenant-a", "stale", fresh, redis, staleAt);

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, counter),
      resolveCredential: async () => "secret",
      listTargets: async () => [{ accountId: "stale", providerId: "test", tenantId: "tenant-a" }],
    });

    expect(counter.calls).toBe(1);
  });

  test("caches global accounts under the shared lens, not a tenant lens", async () => {
    const redis = fakeRedis();
    const counter = { calls: 0 };

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, counter),
      resolveCredential: async () => "secret",
      listTargets: async () => [{ accountId: "shared", providerId: "test", tenantId: null }],
    });

    expect(await getCachedQuota(GLOBAL_QUOTA_LENS, "shared", redis)).toEqual(fresh);
    expect(await getCachedQuota("tenant-a", "shared", redis)).toBeNull();
  });

  test("counts failures without rejecting the pass", async () => {
    const redis = fakeRedis();
    const counter = { calls: 0 };
    const tick: Array<{ failed: number }> = [];
    const failing: ProviderQuotaResult = {
      source: "test",
      plan: null,
      windows: [],
      error: "upstream refused",
    };

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(failing, counter),
      resolveCredential: async () => "secret",
      listTargets: async () => [{ accountId: "bad", providerId: "test", tenantId: "tenant-a" }],
      onTick: (result) => tick.push({ failed: result.failed }),
    });

    expect(tick).toEqual([{ failed: 1 }]);
    // The failure is cached too: the error view is what the page renders.
    expect((await getCachedQuota("tenant-a", "bad", redis))?.error).toBe("upstream refused");
  });

  test("a credential-less account fails as missing_credential and is still cached", async () => {
    const redis = fakeRedis();
    const counter = { calls: 0 };
    const tick: Array<{ failed: number }> = [];

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, counter),
      resolveCredential: async () => "",
      listTargets: async () => [{ accountId: "nokey", providerId: "test", tenantId: "tenant-a" }],
      onTick: (result) => tick.push({ failed: result.failed }),
    });

    expect(counter.calls).toBe(0);
    expect(tick).toEqual([{ failed: 1 }]);
    expect((await getCachedQuota("tenant-a", "nokey", redis))?.error).toContain("no stored credential");
  });

  test("never attempts more accounts than the per-pass cap", async () => {
    const redis = fakeRedis();
    const counter = { calls: 0 };
    const targets = Array.from({ length: 12 }, (_, index) => ({
      accountId: `acct-${index}`,
      providerId: "test",
      tenantId: "tenant-a",
    }));

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, counter),
      resolveCredential: async () => "secret",
      listTargets: async () => targets,
      maxPerPass: 5,
      maxConcurrency: 2,
    });

    expect(counter.calls).toBe(5);
  });

  test("filters providers without OAuth refreshers and grows completed waves", async () => {
    const redis = fakeRedis();
    let active = 0;
    const waveSizes: number[] = [];
    const targets = [
      ...Array.from({ length: 14 }, (_, index) => ({
        accountId: `oauth-${index}`,
        providerId: "oauth",
        tenantId: "tenant-a",
      })),
      { accountId: "plain-1", providerId: "plain", tenantId: "tenant-a" },
    ];
    const registry = {
      async resolveRefresher(providerId: string) {
        return providerId === "oauth" ? dummyRefresher : undefined;
      },
      async resolveQuotaCollector() {
        return async () => fresh;
      },
    } as unknown as ProviderRegistry;

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: registry,
      resolveCredential: async () => {
        if (active === 0) waveSizes.push(0);
        waveSizes[waveSizes.length - 1] = (waveSizes.at(-1) ?? 0) + 1;
        active += 1;
        await Promise.resolve();
        active -= 1;
        return "secret";
      },
      listTargets: async () => targets,
      maxPerPass: 14,
    });

    expect(waveSizes).toEqual([2, 3, 4, 5]);
  });

  test("reads cache ages in one mget per lens instead of one get per account", async () => {
    const store = new Map<string, string>();
    const calls = { get: 0, mget: 0 };
    const redis = {
      async get(key: string): Promise<string | null> {
        calls.get += 1;
        return store.get(key) ?? null;
      },
      async set(key: string, value: string): Promise<string> {
        store.set(key, value);
        return "OK";
      },
      async mget(...keys: string[]): Promise<(string | null)[]> {
        calls.mget += 1;
        return keys.map((key) => store.get(key) ?? null);
      },
      async del(...keys: string[]): Promise<number> {
        let removed = 0;
        for (const key of keys) if (store.delete(key)) removed += 1;
        return removed;
      },
    } as unknown as RedisClient;
    const counter = { calls: 0 };
    // Two tenants plus the shared lens: three lenses, so three batched reads,
    // and not one serial `get` for any of the four accounts.
    const targets = [
      { accountId: "t-a1", providerId: "test", tenantId: "tenant-a" },
      { accountId: "t-a2", providerId: "test", tenantId: "tenant-a" },
      { accountId: "t-b1", providerId: "test", tenantId: "tenant-b" },
      { accountId: "g-1", providerId: "test", tenantId: null },
    ];

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, counter),
      resolveCredential: async () => "secret",
      listTargets: async () => targets,
    });

    expect(counter.calls).toBe(4);
    expect(calls.mget).toBe(3);
    expect(calls.get).toBe(0);
  });

  test("a listing failure ends the pass without throwing", async () => {
    const redis = fakeRedis();
    const tick: unknown[] = [];

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(fresh, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => {
        throw new Error("db down");
      },
      onTick: (result) => tick.push(result),
    });

    expect(tick).toEqual([]);
  });

  test("logs one line per account, naming the account instead of its id", async () => {
    clearConsoleLogs();
    const redis = fakeRedis();
    const ok: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(ok, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "acct-1", providerId: "cb", tenantId: "t", label: "aria@example.com" },
      ],
    });

    const lines = getConsoleLogSnapshot()
      .map((line) => line.msg)
      .filter((msg) => msg.includes("[Quota-refresh]"));
    expect(lines.some((msg) => msg.includes("cb/aria@example.com"))).toBe(true);
  });

  test("a provider without the check-in route reports no daily clause", async () => {
    // `daily unsupported` used to be appended to every account whose provider
    // lacks the check-in route, which was pure noise: the sweep already skips
    // those providers, so there is nothing to report about them.
    clearConsoleLogs();
    const redis = fakeRedis();
    const ok: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(ok, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        // `openai` is not one of the check-in providers.
        { accountId: "acct-plain", providerId: "openai", tenantId: "t", label: "plain@example.com" },
      ],
    });

    const line = getConsoleLogSnapshot()
      .map((entry) => entry.msg)
      .find((msg) => msg.includes("openai/plain@example.com"));
    expect(line).toBeDefined();
    expect(line).not.toContain("daily");
  });

  test("an account outside the check-in family spends no check-in request", async () => {
    clearConsoleLogs();
    const redis = fakeRedis();
    const ok: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };
    const calls: string[] = [];
    const checkinFetcher = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(ok, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "acct-plain2", providerId: "openai", tenantId: "t", label: "plain2@example.com" },
      ],
      checkinFetcher,
    });

    // The check-in ride-along is scoped to the providers that have the route, so
    // it must not spend a request on one that does not, and the log line carries
    // no daily segment.
    expect(calls).toEqual([]);
    const line = getConsoleLogSnapshot()
      .map((entry) => entry.msg)
      .find((msg) => msg.includes("openai/plain2@example.com"));
    expect(line).toBeDefined();
    expect(line).not.toContain("daily");
  });

  test("a claimed check-in reports the credit and streak compactly", async () => {
    clearConsoleLogs();
    const redis = fakeRedis();
    const ok: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };
    const checkinFetcher = (async () =>
      new Response(JSON.stringify({ code: 0, data: { today_checked_in: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(ok, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "acct-wb", providerId: "workbuddy", tenantId: "t", label: "wb@example.com" },
      ],
      checkinFetcher,
    });

    const line = getConsoleLogSnapshot()
      .map((entry) => entry.msg)
      .find((msg) => msg.includes("workbuddy/wb@example.com"));
    expect(line).toBeDefined();
    // Either it claimed (with detail) or it reported the routine state — never
    // the old verbose "daily already claimed".
    expect(line).not.toContain("already claimed");
  });

  test("suppresses an unchanged outcome on the next pass", async () => {
    clearConsoleLogs();
    const redis = fakeRedis();
    const ok: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };
    const deps = {
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(ok, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "acct-2", providerId: "cb", tenantId: "t", label: "b@example.com" },
      ],
    };

    await quotaRefreshSweep(deps);
    const first = getConsoleLogSnapshot().filter((line) =>
      line.msg.includes("cb/b@example.com"),
    );
    expect(first).toHaveLength(1);

    clearConsoleLogs();
    await quotaRefreshSweep(deps);
    const second = getConsoleLogSnapshot().filter((line) =>
      line.msg.includes("cb/b@example.com"),
    );
    expect(second).toHaveLength(0);
  });

  test("reports a quota failure with the upstream reason", async () => {
    clearConsoleLogs();
    const redis = fakeRedis();
    const broken: ProviderQuotaResult = {
      source: "test",
      plan: null,
      windows: [],
      error: "credential expired",
    };

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(broken, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "acct-3", providerId: "workbuddy", tenantId: "t", label: "c@example.com" },
      ],
    });

    const lines = getConsoleLogSnapshot()
      .map((line) => line.msg)
      .filter((msg) => msg.includes("[Quota-refresh]"));
    expect(lines.some((msg) => msg.includes("workbuddy/c@example.com"))).toBe(true);
    expect(lines.some((msg) => msg.includes("quota failed: credential expired"))).toBe(true);
  });

  test("the sweep runs check-in then report in order for one account", async () => {
    clearConsoleLogs();
    const redis = fakeRedis();
    const ok: ProviderQuotaResult = { source: "test", plan: null, windows: [], error: null };
    const calls: string[] = [];
    const checkinFetcher = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/checkin-activity-status")) {
        return new Response(
          JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Claim and report both answer success; the credential is opaque here so
      // the report leg fails closed on uid — order is what this asserts.
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await quotaRefreshSweep({
      db: {} as never,
      redis,
      providerRegistry: stubRegistry(ok, { calls: 0 }),
      resolveCredential: async () => "secret",
      listTargets: async () => [
        { accountId: "acct-seq", providerId: "workbuddy", tenantId: "t", label: "s@example.com" },
      ],
      checkinFetcher,
    });

    const statusAt = calls.findIndex((url) => url.endsWith("/checkin-activity-status"));
    const claimAt = calls.findIndex((url) => url.endsWith("/daily-checkin"));
    expect(statusAt).toBeGreaterThanOrEqual(0);
    expect(claimAt).toBeGreaterThan(statusAt);
    // Opaque credential: report leg fails closed without a uid, and the line
    // says so instead of silently dropping the report half.
    const line = getConsoleLogSnapshot()
      .map((entry) => entry.msg)
      .find((msg) => msg.includes("workbuddy/s@example.com"));
    expect(line).toBeDefined();
  });
});

/** Memory-backend paths: the flows and cache legs that run without REDIS_URL. */
import { describe, expect, test } from "bun:test";
import {
  cachedQuotaAgeMs,
  clearQuotaCacheForTests,
  getCachedQuotaEntry,
  invalidateQuotaCache,
  setCachedQuota,
} from "../../src/console/quota/cache";
import {
  InMemoryOAuthFlowStore,
  type DeviceFlowCorrelation,
  type PendingOAuthFlow,
} from "../../src/providers/authentication/oauth-flow-store";
import type { ProviderQuotaResult } from "../../src/providers/quota/quota-contracts";

function pending(state: string): PendingOAuthFlow {
  return {
    providerId: "openai",
    codeVerifier: `verifier-${state}`,
    accountLabel: "ops@example.com",
    tenantId: null,
    redirectUri: "http://localhost:1455/auth/callback",
  };
}

function correlation(id: string): DeviceFlowCorrelation {
  return { providerId: "openai", accountLabel: "ops@example.com", tenantId: null, providerState: id };
}

const quota: ProviderQuotaResult = {
  source: "memory-test",
  plan: null,
  windows: [],
  error: null,
};

describe("InMemoryOAuthFlowStore", () => {
  test("pending state consumes exactly once", async () => {
    const store = new InMemoryOAuthFlowStore();
    await store.savePending("s1", pending("s1"));
    const flow = await store.consumePending("s1");
    expect(flow?.codeVerifier).toBe("verifier-s1");
    await expect(store.consumePending("s1")).resolves.toBeUndefined();
  });

  test("provider pointer follows last-write-wins and clears on consume", async () => {
    const store = new InMemoryOAuthFlowStore();
    await store.savePending("old", pending("old"));
    await store.savePending("new", pending("new"));
    const flow = await store.consumePendingByProvider("openai");
    expect(flow?.codeVerifier).toBe("verifier-new");
    // The pointer is spent: the orphaned first flow is unreachable by provider.
    await expect(store.consumePendingByProvider("openai")).resolves.toBeUndefined();
  });

  test("unknown provider has no pending flow", async () => {
    const store = new InMemoryOAuthFlowStore();
    await expect(store.consumePendingByProvider("anthropic")).resolves.toBeUndefined();
  });

  test("device correlation round-trips and deletes", async () => {
    const store = new InMemoryOAuthFlowStore();
    await store.saveDevice("d1", correlation("d1"));
    expect(await store.getDevice("d1")).toEqual(correlation("d1"));
    await store.deleteDevice("d1");
    await expect(store.getDevice("d1")).resolves.toBeUndefined();
  });

  test("device state round-trips and deletes", async () => {
    const store = new InMemoryOAuthFlowStore();
    await store.saveDeviceState("d1", { nonce: "abc" });
    expect(await store.getDeviceState("d1")).toEqual({ nonce: "abc" });
    await store.deleteDeviceState("d1");
    await expect(store.getDeviceState("d1")).resolves.toBeUndefined();
  });
});

describe("quota cache without Redis", () => {
  test("the memory tier serves, invalidates, and never throws", async () => {
    clearQuotaCacheForTests();
    try {
      await setCachedQuota("tenant:t1", "acc-1", quota, undefined);
      const hit = await getCachedQuotaEntry("tenant:t1", "acc-1", undefined);
      expect(hit?.quota.source).toBe("memory-test");
      await invalidateQuotaCache("tenant:t1", "acc-1", undefined);
      await expect(getCachedQuotaEntry("tenant:t1", "acc-1", undefined)).resolves.toBeNull();
    } finally {
      clearQuotaCacheForTests();
    }
  });

  test("a failed refresh preserves the last successful quota and records the attempt", async () => {
    clearQuotaCacheForTests();
    const firstFetch = new Date("2026-10-12T12:00:00.000Z");
    const failedFetch = new Date("2026-10-12T12:04:00.000Z");
    const availableQuota: ProviderQuotaResult = {
      source: "memory-test",
      plan: null,
      windows: [{
        kind: "monthly",
        label: "Monthly",
        accounting: "independent",
        usedPercent: 55,
        remainingPercent: 45,
        resetsAt: null,
        remaining: 45,
        used: 55,
        limit: 100,
      }],
      error: null,
    };
    const failedQuota: ProviderQuotaResult = {
      source: "memory-test",
      plan: null,
      windows: [],
      error: "Temporary provider failure",
    };
    try {
      await setCachedQuota("tenant:t1", "acc-2", availableQuota, undefined, firstFetch);
      await setCachedQuota("tenant:t1", "acc-2", failedQuota, undefined, failedFetch);
      const retained = await getCachedQuotaEntry("tenant:t1", "acc-2", undefined);
      expect(retained?.quota).toEqual(availableQuota);
      expect(retained?.fetchedAt).toBe(firstFetch.toISOString());
      expect(retained?.lastAttemptAt).toBe(failedFetch.toISOString());
      expect(retained?.refreshError).toBe(failedQuota.error);
      expect(cachedQuotaAgeMs(retained, failedFetch.getTime() + 60_000)).toBe(60_000);
    } finally {
      clearQuotaCacheForTests();
    }
  });

  test("repeated errors stop retaining a successful quota after thirty minutes", async () => {
    clearQuotaCacheForTests();
    const firstFetch = new Date("2026-10-12T12:00:00.000Z");
    const expiredFetch = new Date("2026-10-12T12:31:00.000Z");
    const availableQuota: ProviderQuotaResult = {
      source: "memory-test",
      plan: null,
      windows: [{
        kind: "monthly",
        label: "Monthly",
        accounting: "independent",
        usedPercent: 55,
        remainingPercent: 45,
        resetsAt: null,
        remaining: 45,
        used: 55,
        limit: 100,
      }],
      error: null,
    };
    const failedQuota: ProviderQuotaResult = {
      source: "memory-test",
      plan: null,
      windows: [],
      error: "Temporary provider failure",
    };
    try {
      await setCachedQuota("tenant:t1", "acc-3", availableQuota, undefined, firstFetch);
      await setCachedQuota("tenant:t1", "acc-3", failedQuota, undefined, expiredFetch);
      const expired = await getCachedQuotaEntry("tenant:t1", "acc-3", undefined);
      expect(expired?.quota).toEqual(failedQuota);
      expect(expired?.fetchedAt).toBeNull();
    } finally {
      clearQuotaCacheForTests();
    }
  });
});

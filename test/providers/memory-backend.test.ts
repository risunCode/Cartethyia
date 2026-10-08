/** Memory-backend paths: the flows and cache legs that run without REDIS_URL. */
import { describe, expect, test } from "bun:test";
import {
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
});

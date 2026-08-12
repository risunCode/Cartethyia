import { describe, expect, test } from "bun:test";
import type { AccountCandidate } from "../contracts";
import { createCachedCredentialConfigStore, CredentialSelector, type AccountUsageSnapshot, type CredentialConfigStore } from "./credentials";
import type { TokenRefreshPool } from "./token-refresh";

const candidates: readonly AccountCandidate[] = [
  { id: "account-a", providerId: "openai", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null },
  { id: "account-b", providerId: "openai", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null },
  { id: "account-c", providerId: "openai", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null },
];

describe("credential cache affinity", () => {
  test("keeps one affinity key on the same account across round-robin selections", async () => {
    const config: CredentialConfigStore = {
      getAccount: async (id) => ({ id, providerId: "openai", kind: "api_key", secret: `${id}-secret`, enabled: true, priority: 0 }),
      listAccounts: async () => [],
    };
    const selector = new CredentialSelector(config, {} as TokenRefreshPool);

    const first = await selector.select({ providerId: "openai", candidates, strategy: "round-robin", affinityKey: "api-key-1", stickyLimit: 2 });
    expect(first).not.toBeNull();
    if (first === null) return;
    await selector.release(first.selection.leaseId);

    const second = await selector.select({ providerId: "openai", candidates, strategy: "round-robin", affinityKey: "api-key-1", stickyLimit: 2 });
    expect(second?.account.id).toBe(first.account.id);
    if (second !== null) await selector.release(second.selection.leaseId);
  });
});

describe("credential configuration cache", () => {
  test("reuses a recent account read and refreshes after TTL expiry", async () => {
    let now = 1_000;
    let reads = 0;
    const account = { id: "account-a", providerId: "openai", kind: "api_key" as const, secret: "secret", enabled: true, priority: 0 };
    const store: CredentialConfigStore = {
      getAccount: async () => {
        reads += 1;
        return account;
      },
      listAccounts: async () => [account],
    };
    const cached = createCachedCredentialConfigStore(store, { nowMs: () => now, ttlMs: 100 });
    expect(await cached.getAccount(account.id)).toEqual(account);
    expect(await cached.getAccount(account.id)).toEqual(account);
    expect(reads).toBe(1);
    now += 101;
    expect(await cached.getAccount(account.id)).toEqual(account);
    expect(reads).toBe(2);
  });
  test("invalidates account views when the routing revision changes", async () => {
    let revision = 1;
    let reads = 0;
    const account = { id: "account-a", providerId: "openai", kind: "api_key" as const, secret: "secret", enabled: true, priority: 0 };
    const store: CredentialConfigStore = {
      getAccount: async () => {
        reads += 1;
        return account;
      },
      listAccounts: async () => [account],
    };
    const cached = createCachedCredentialConfigStore(store, { ttlMs: 1_000, readRevision: () => revision });
    await cached.getAccount(account.id);
    await cached.getAccount(account.id);
    expect(reads).toBe(1);
    revision += 1;
    await cached.getAccount(account.id);
    expect(reads).toBe(2);
  });
});

function usageSnapshot(
  accountId: string,
  remainingFraction: number | null,
  resetAtMs: number | null,
  options: { readonly fetchedAtMs?: number; readonly stale?: boolean } = {},
): AccountUsageSnapshot {
  return {
    accountId,
    providerId: "openai",
    remainingFraction,
    resetAtMs,
    fetchedAtMs: options.fetchedAtMs ?? 1_000,
    stale: options.stale ?? false,
  };
}

function selectorForAccounts(): CredentialSelector {
  const config: CredentialConfigStore = {
    getAccount: async (id) => ({ id, providerId: "openai", kind: "api_key", secret: `${id}-secret`, enabled: true, priority: 0 }),
    listAccounts: async () => [],
  };
  return new CredentialSelector(config, {} as TokenRefreshPool);
}

describe("usage-aware credential ranking", () => {
  test("selects the freshest account with the most usable headroom", async () => {
    const selector = selectorForAccounts();
    const result = await selector.select({
      providerId: "openai",
      candidates: candidates.slice(0, 2),
      nowMs: 1_000,
      usageSnapshots: new Map([
        ["account-a", usageSnapshot("account-a", 0.2, 5_000)],
        ["account-b", usageSnapshot("account-b", 0.8, 5_000)],
      ]),
    });
    expect(result?.account.id).toBe("account-b");
    expect(result?.reason).toBe("usage_headroom");
    if (result !== null && result !== undefined) await selector.release(result.selection.leaseId);
  });

  test("uses the earlier reset when headroom is tied", async () => {
    const selector = selectorForAccounts();
    const result = await selector.select({
      providerId: "openai",
      candidates: candidates.slice(0, 2),
      nowMs: 1_000,
      usageSnapshots: new Map([
        ["account-a", usageSnapshot("account-a", 0.5, 5_000)],
        ["account-b", usageSnapshot("account-b", 0.5, 2_000)],
      ]),
    });
    expect(result?.account.id).toBe("account-b");
    if (result !== null && result !== undefined) await selector.release(result.selection.leaseId);
  });

  test("falls back to deterministic ranking for stale usage", async () => {
    const selector = selectorForAccounts();
    const result = await selector.select({
      providerId: "openai",
      candidates: candidates.slice(0, 2),
      nowMs: 1_000,
      usageSnapshots: new Map([
        ["account-a", usageSnapshot("account-a", 0.1, 5_000, { stale: true })],
        ["account-b", usageSnapshot("account-b", 0.9, 2_000, { stale: true })],
      ]),
    });
    expect(result?.account.id).toBe("account-a");
    expect(result?.reason).toBe("healthy");
    if (result !== null && result !== undefined) await selector.release(result.selection.leaseId);
  });

  test("keeps preferred and sticky precedence over usage ranking", async () => {
    const selector = selectorForAccounts();
    const preferred = await selector.select({
      providerId: "openai",
      candidates: candidates.slice(0, 2),
      preferredAccountId: "account-a",
      nowMs: 1_000,
      usageSnapshots: new Map([
        ["account-a", usageSnapshot("account-a", 0.1, 5_000)],
        ["account-b", usageSnapshot("account-b", 0.9, 2_000)],
      ]),
    });
    expect(preferred?.account.id).toBe("account-a");
    expect(preferred?.reason).toBe("preferred");
    if (preferred !== null && preferred !== undefined) await selector.release(preferred.selection.leaseId);

    const withoutUsage = await selector.select({
      providerId: "openai",
      candidates,
      strategy: "round-robin",
      affinityKey: "sticky-usage",
      stickyLimit: 2,
    });
    expect(withoutUsage).not.toBeNull();
    if (withoutUsage === null) return;
    await selector.release(withoutUsage.selection.leaseId);
    const withUsage = await selector.select({
      providerId: "openai",
      candidates,
      strategy: "round-robin",
      affinityKey: "sticky-usage",
      stickyLimit: 2,
      nowMs: 1_000,
      usageSnapshots: new Map([
        ["account-a", usageSnapshot("account-a", 0.1, 5_000)],
        ["account-b", usageSnapshot("account-b", 0.9, 2_000)],
        ["account-c", usageSnapshot("account-c", 0.9, 2_000)],
      ]),
    });
    expect(withUsage?.account.id).toBe(withoutUsage.account.id);
    if (withUsage !== null && withUsage !== undefined) await selector.release(withUsage.selection.leaseId);
  });

  test("excludes quota-exhausted accounts before usage ranking", async () => {
    const selector = selectorForAccounts();
    const exhausted: AccountCandidate = {
      id: "account-a",
      providerId: "openai",
      credentialKind: "api_key",
      health: null,
      enabled: true,
      quotaAvailable: false,
      modelLocks: null,
    };
    const available = candidates.find((candidate) => candidate.id === "account-b");
    if (available === undefined) return;
    const result = await selector.select({
      providerId: "openai",
      candidates: [exhausted, available],
      nowMs: 1_000,
      usageSnapshots: new Map([
        ["account-a", usageSnapshot("account-a", 1, 1_000)],
        ["account-b", usageSnapshot("account-b", 0.1, 2_000)],
      ]),
    });
    expect(result?.account.id).toBe("account-b");
    if (result !== null && result !== undefined) await selector.release(result.selection.leaseId);
  });

  test("falls back when the usage provider fails", async () => {
    const selector = selectorForAccounts();
    const result = await selector.select({
      providerId: "openai",
      candidates: candidates.slice(0, 2),
      nowMs: 1_000,
      usageSnapshotProvider: async () => {
        throw new Error("usage source unavailable");
      },
    });
    expect(result?.account.id).toBe("account-a");
    expect(result?.reason).toBe("healthy");
    if (result !== null && result !== undefined) await selector.release(result.selection.leaseId);
  });
});

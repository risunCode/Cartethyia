import { describe, expect, test } from "bun:test";
import type { AccountCandidate } from "../contracts";
import { createCachedCredentialConfigStore, CredentialSelector, type CredentialConfigStore } from "./credentials";
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

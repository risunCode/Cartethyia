import { describe, expect, test } from "bun:test";
import { MemoryAccountHealthStore, MemoryOAuthTokenStore, MemoryQuotaStateStore } from "../../src/auth/credentials";
import type { AccountHealthRecord, OAuthTokenRecord } from "../../src/auth/credentials";

const healthRecord: AccountHealthRecord = {
  accountId: "acct-1",
  providerId: "openai",
  status: "cooling_down",
  statusCode: 429,
  failureKind: "provider_rate_limited",
  sanitizedMessage: "rate limited",
  occurredAt: "2026-08-05T00:00:00.000Z",
  retryAt: "2026-08-05T00:01:00.000Z",
  disabledUntilMs: 1_760_000_000_000,
  failureCount: 3,
  generation: 4,
};

const tokenRecord: OAuthTokenRecord = {
  accessToken: "secret-token",
  expiresAtMs: 1_760_000_000_000,
  refreshToken: "refresh-1",
  kind: "oauth",
};

describe("MemoryAccountHealthStore", () => {
  test("returns undefined for a missing account and round-trips set/get", async () => {
    const store = new MemoryAccountHealthStore();
    expect(await store.get("nope")).toBeUndefined();
    await store.set(healthRecord);
    expect(await store.get("acct-1")).toEqual(healthRecord);
  });

  test("overwrites on repeated set and lists all records", async () => {
    const store = new MemoryAccountHealthStore();
    await store.set(healthRecord);
    await store.set({ ...healthRecord, failureCount: 5 });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.failureCount).toBe(5);
  });
});

describe("MemoryQuotaStateStore", () => {
  test("round-trips a quota snapshot and lists records", async () => {
    const store = new MemoryQuotaStateStore();
    await store.set({ accountId: "a", quotaAvailable: true, lastQuotaRefreshAtMs: 100, quota: { source: "codex", status: "ready", plan: "plus", windows: [], fetchedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });
    const record = await store.get("a");
    expect(record?.quotaAvailable).toBe(true);
    expect(record?.quota?.source).toBe("codex");
    expect(await store.list()).toHaveLength(1);
  });
});

describe("MemoryOAuthTokenStore", () => {
  test("round-trips get/set and delete", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("acct-1", tokenRecord);
    const token = await store.get("acct-1");
    expect(token?.accessToken).toBe("secret-token");
    expect(token?.refreshToken).toBe("refresh-1");
    expect(token?.kind).toBe("oauth");
    await store.delete("acct-1");
    expect(await store.get("acct-1")).toBeUndefined();
    // delete on a missing account is a no-op
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });
});

import { AccountHealthManager, OAuthCoordinator, QuotaCoordinator, isAccountEligible, rankAccountCandidates, CredentialSelector, credentialUnavailableError, type CredentialConfigStore, type OAuthRefresher, type QuotaRefresher, type QuotaStateStore } from "../../src/auth/credentials";
import { MemoryModelLockStore } from "../../src/auth/credentials";
import type { AccountCandidate, ModelLockRecord, ProviderCallError } from "../../src/domain/contracts";

const NOW = Date.parse("2026-08-05T00:00:00.000Z");

function pErr(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return { statusCode: 429, kind: "provider_rate_limited", retryable: true, routeScope: "account", source: "upstream", sanitizedMessage: "rate limited", retryAt: null, ...overrides };
}

describe("AccountHealthManager", () => {
  test("ignores non-retryable failures", async () => {
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW });
    expect(await m.recordFailure("a", "p", pErr({ retryable: false }))).toBeNull();
  });

  test("records retryable failures with a cooldown, increments failure count, and blocks usable", async () => {
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW });
    const record = await m.recordFailure("a", "p", pErr());
    expect(record?.status).toBe("cooling_down");
    expect(record?.failureCount).toBe(1);
    expect(record?.retryAt).not.toBeNull();
    expect(await m.isUsable("a", NOW + 1)).toBe(false);
  });

  test("recordSuccess marks the account healthy and restores usability", async () => {
    const store = new MemoryAccountHealthStore();
    const m = new AccountHealthManager(store, { nowMs: () => NOW });
    await m.recordFailure("a", "p", pErr());
    await m.recordSuccess("a", "p");
    expect((await m.getHealth("a"))?.status).toBe("healthy");
    expect(await m.isUsable("a", NOW)).toBe(true);
  });
});

function makeOAuth(refresher: OAuthRefresher, store = new MemoryOAuthTokenStore()): OAuthCoordinator {
  return new OAuthCoordinator(store, refresher, { nowMs: () => NOW });
}

describe("OAuthCoordinator", () => {
  test("returns a cached fresh token without refreshing", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("a", { accessToken: "at", expiresAtMs: NOW + 60_000, refreshToken: "rt", kind: "oauth" });
    const coord = makeOAuth({ refresh: async () => ({ ok: false, error: pErr() }) }, store);
    expect((await coord.ensureFresh("a")).accessToken).toBe("at");
  });

  test("refreshes when near expiry and stores the new token", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("a", { accessToken: "old", expiresAtMs: NOW - 1000, refreshToken: "rt", kind: "oauth" } as OAuthTokenRecord);
    const coord = makeOAuth({ refresh: async () => ({ ok: true as const, token: { accessToken: "new", expiresAtMs: NOW + 3600_000, refreshToken: "rt", kind: "oauth" as const } }) }, store);
    expect((await coord.ensureFresh("a")).accessToken).toBe("new");
    expect((await store.get("a"))?.accessToken).toBe("new");
  });

  test("coalesces concurrent refreshes onto a single in-flight refresh", async () => {
    let calls = 0;
    const coord = makeOAuth({
      refresh: async () => { calls += 1; return { ok: true as const, token: { accessToken: "t", expiresAtMs: NOW + 3600_000, refreshToken: null, kind: "oauth" as const } }; },
    });
    const [a, b] = await Promise.all([coord.ensureFresh("a"), coord.ensureFresh("a")]);
    expect(a.accessToken).toBe("t");
    expect(b.accessToken).toBe("t");
    expect(calls).toBe(1);
  });

  test("surfaces refresh failures as a provider error", async () => {
    const coord = makeOAuth({ refresh: async () => ({ ok: false as const, error: pErr({ kind: "provider_unavailable" }) }) });
    await expect(coord.ensureFresh("a")).rejects.toMatchObject({ kind: "provider_unavailable" });
  });

  test("keeps a browser token without a refresh token as-is (Kimchi-style)", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("a", { accessToken: "bt", expiresAtMs: NOW - 1000, refreshToken: null, kind: "oauth" } as OAuthTokenRecord);
    const coord = makeOAuth({ refresh: async () => ({ ok: false, error: pErr() }) }, store);
    expect((await coord.ensureFresh("a")).accessToken).toBe("bt");
  });

  test("lease/releaseLease refcounts and releases exactly once", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set("a", { accessToken: "t", expiresAtMs: NOW + 3600_000, refreshToken: null, kind: "oauth" });
    const coord = makeOAuth({ refresh: async () => ({ ok: false, error: pErr() }) }, store);
    const lease = await coord.lease("a");
    expect(coord.activeLeaseCount("a")).toBe(1);
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(coord.activeLeaseCount("a")).toBe(0);
    expect(coord.releaseLease("unknown")).toBe(false);
  });
});

describe("QuotaCoordinator", () => {
  test("defaults quota availability to true when no record exists", async () => {
    const coord = new QuotaCoordinator(new MemoryQuotaStateStore() as QuotaStateStore, { nowMs: () => NOW });
    expect(await coord.getQuotaAvailable("a")).toBe(true);
  });

  test("respects the sweep cooldown — a second in-window sweep does not refresh", async () => {
    const store = new MemoryQuotaStateStore();
    let refreshes = 0;
    const coord = new QuotaCoordinator(store, { sweepCooldownMs: 900_000, nowMs: () => NOW });
    const refresher: QuotaRefresher = { refreshQuota: async () => { refreshes += 1; return true; } };
    const first = await coord.refreshQuotaIfDue("a", refresher.refreshQuota);
    expect(first.refreshed).toBe(true);
    const second = await coord.refreshQuotaIfDue("a", refresher.refreshQuota);
    expect(second.refreshed).toBe(false);
    expect(refreshes).toBe(1);
  });
});

function acct(overrides: Partial<AccountCandidate> = {}): AccountCandidate {
  return { id: "acc-1", providerId: "p", credentialKind: "api_key", health: null, enabled: true, quotaAvailable: true, modelLocks: null, ...overrides };
}

describe("account eligibility and ranking", () => {
  test("isAccountEligible gates on enabled, quota, and disabled status", () => {
    expect(isAccountEligible(acct(), NOW)).toBe(true);
    expect(isAccountEligible(acct({ enabled: false }), NOW)).toBe(false);
    expect(isAccountEligible(acct({ quotaAvailable: false }), NOW)).toBe(false);
    expect(isAccountEligible(acct({ health: { scope: "account", status: "disabled", statusCode: null, failureKind: null, sanitizedMessage: null, occurredAt: null, retryAt: null } }), NOW)).toBe(false);
  });

  test("cooling_down is eligible only once its retryAt has passed", () => {
    const cooling = acct({ health: { scope: "account", status: "cooling_down", statusCode: 429, failureKind: "provider_rate_limited", sanitizedMessage: "x", occurredAt: null, retryAt: new Date(NOW + 60_000).toISOString() } });
    expect(isAccountEligible(cooling, NOW)).toBe(false);
    expect(isAccountEligible(cooling, NOW + 120_000)).toBe(true);
  });

  test("rankAccountCandidates orders eligible first, preferred first, then by id", () => {
    const ranked = rankAccountCandidates([acct({ id: "b" }), acct({ id: "a", enabled: false }), acct({ id: "c" })], "c", NOW);
    expect(ranked.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  test("credentialUnavailableError builds a retryable account-scoped error", () => {
    const error = credentialUnavailableError("p");
    expect(error.kind).toBe("credential_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.routeScope).toBe("account");
  });
});

describe("CredentialSelector", () => {
  test("returns null when no candidate is eligible", async () => {
    const config: CredentialConfigStore = { getAccount: async () => undefined, listAccounts: async () => [] };
    const selector = new CredentialSelector(config, makeOAuth({ refresh: async () => ({ ok: false, error: pErr() }) }));
    const result = await selector.select({ providerId: "p", candidates: [acct({ enabled: false })], nowMs: NOW });
    expect(result).toBeNull();
  });
});

describe("MemoryModelLockStore", () => {
  test("round-trips get/set, deletes, lists per account, and lists expired", async () => {
    const store = new MemoryModelLockStore();
    const rec: ModelLockRecord = { accountId: "a", modelId: "sonnet-4", retryAt: new Date(NOW + 60_000).toISOString(), errorKind: "provider_rate_limited", statusCode: 429, sanitizedMessage: "rate limited", failureCount: 1 };
    await store.set(rec);
    expect((await store.get("a", "sonnet-4"))?.modelId).toBe("sonnet-4");
    expect((await store.get("a", "haiku-4"))).toBeUndefined();

    const rec2: ModelLockRecord = { ...rec, modelId: "haiku-4", retryAt: new Date(NOW + 120_000).toISOString() };
    await store.set(rec2);
    const forAccount = await store.listForAccount("a");
    expect(forAccount).toHaveLength(2);

    const expired = await store.listExpired(NOW + 70_000);
    expect(expired.map((r) => r.modelId)).toEqual(["sonnet-4"]);

    await store.delete("a", "sonnet-4");
    expect(await store.get("a", "sonnet-4")).toBeUndefined();
    expect((await store.listForAccount("a"))).toHaveLength(1);
  });
});

describe("AccountHealthManager per-model lock", () => {
  test("recordModelLock stores a lock for a rate-limit error and blocks isModelAvailable", async () => {
    const modelLocks = new MemoryModelLockStore();
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW }, modelLocks);
    const record = await m.recordModelLock("a", "sonnet-4", pErr());
    expect(record).not.toBeNull();
    expect(record?.modelId).toBe("sonnet-4");
    expect(record?.failureCount).toBe(1);
    // Lock is active — model is NOT available.
    expect(await m.isModelAvailable("a", "sonnet-4", NOW)).toBe(false);
    // A different model on the same account IS available.
    expect(await m.isModelAvailable("a", "haiku-4", NOW)).toBe(true);
    // After the retry window, the model becomes available again.
    expect(await m.isModelAvailable("a", "sonnet-4", NOW + 10 * 60_000)).toBe(true);
  });

  test("recordModelLock skips non-retryable errors", async () => {
    const modelLocks = new MemoryModelLockStore();
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW }, modelLocks);
    const record = await m.recordModelLock("a", "sonnet-4", pErr({ retryable: false, kind: "invalid_request" }));
    expect(record).toBeNull();
    expect(await m.isModelAvailable("a", "sonnet-4", NOW)).toBe(true);
  });

  test("recordModelLock skips T2 transient errors (no cooldown)", async () => {
    const modelLocks = new MemoryModelLockStore();
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW }, modelLocks);
    // provider_unavailable is a T2 transient kind — cooldownDelayMs returns 0.
    const record = await m.recordModelLock("a", "sonnet-4", pErr({ kind: "provider_unavailable", statusCode: 503 }));
    expect(record).toBeNull();
    expect(await m.isModelAvailable("a", "sonnet-4", NOW)).toBe(true);
  });

  test("clearModelLock removes the lock on success", async () => {
    const modelLocks = new MemoryModelLockStore();
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW }, modelLocks);
    await m.recordModelLock("a", "sonnet-4", pErr());
    expect(await m.isModelAvailable("a", "sonnet-4", NOW)).toBe(false);
    await m.clearModelLock("a", "sonnet-4");
    expect(await m.isModelAvailable("a", "sonnet-4", NOW)).toBe(true);
  });

  test("incrementing failure count does not overflow past 255", async () => {
    const modelLocks = new MemoryModelLockStore();
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW }, modelLocks);
    for (let i = 0; i < 300; i++) await m.recordModelLock("a", "sonnet-4", pErr());
    const record = await modelLocks.get("a", "sonnet-4");
    expect(record?.failureCount).toBe(255);
  });

  test("listModelLocksForAccount returns all active locks", async () => {
    const modelLocks = new MemoryModelLockStore();
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW }, modelLocks);
    await m.recordModelLock("a", "sonnet-4", pErr());
    await m.recordModelLock("a", "haiku-4", pErr({ statusCode: 401, kind: "authentication_failed" }));
    const locks = await m.listModelLocksForAccount("a");
    expect(locks).toHaveLength(2);
    expect(locks.map((l) => l.modelId).sort()).toEqual(["haiku-4", "sonnet-4"]);
  });

  test("without a model lock store, recordModelLock/isModelAvailable are no-ops", async () => {
    const m = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => NOW });
    expect(await m.recordModelLock("a", "sonnet-4", pErr())).toBeNull();
    expect(await m.isModelAvailable("a", "sonnet-4", NOW)).toBe(true);
    expect((await m.listModelLocksForAccount("a"))).toHaveLength(0);
  });
});

describe("isAccountEligible per-model lock", () => {
  const lock: ModelLockRecord = { accountId: "acc-1", modelId: "sonnet-4", retryAt: new Date(NOW + 60_000).toISOString(), errorKind: "provider_rate_limited", statusCode: 429, sanitizedMessage: "x", failureCount: 1 };
  const locks = new Map([["sonnet-4", lock]]);

  test("blocks the locked model but allows a different model", () => {
    const candidate = acct({ modelLocks: locks });
    expect(isAccountEligible(candidate, NOW, "sonnet-4")).toBe(false);
    expect(isAccountEligible(candidate, NOW, "haiku-4")).toBe(true);
  });

  test("allows the locked model once retry_at has passed", () => {
    const candidate = acct({ modelLocks: locks });
    expect(isAccountEligible(candidate, NOW + 120_000, "sonnet-4")).toBe(true);
  });

  test("ignores model locks when no modelId is provided (backward compatible)", () => {
    const candidate = acct({ modelLocks: locks });
    expect(isAccountEligible(candidate, NOW)).toBe(true);
  });

  test("rankAccountCandidates with modelId skips locked model", () => {
    const locked = acct({ id: "locked", modelLocks: locks });
    const free = acct({ id: "free", modelLocks: null });
    const ranked = rankAccountCandidates([locked, free], null, NOW, "sonnet-4");
    // "free" should rank first (eligible), "locked" second (ineligible for sonnet-4).
    expect(ranked.map((r) => r.id)).toEqual(["free", "locked"]);
  });
});



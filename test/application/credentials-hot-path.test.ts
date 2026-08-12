import { describe, expect, test } from "bun:test";
import type {
  AccountCandidate,
  ModelLockRecord,
  ProviderCallError,
  RouteHealth,
} from "../../src/application/contracts";
import { createProviderError } from "../../src/traffic";
import type { TokenRefreshPool } from "../../src/application/auth/token-refresh";
import {
  AccountHealthManager,
  CredentialSelector,
  MemoryAccountHealthStore,
  MemoryModelLockStore,
  MemoryQuotaStateStore,
  QuotaCoordinator,
  createCachedCredentialConfigStore,
  credentialUnavailableError,
  fingerprintOAuthToken,
  isAccountEligible,
  rankAccountCandidates,
  type AccountConfig,
  type AccountHealthRecord,
  type AccountHealthStore,
  type AccountUsageSnapshot,
  type CredentialConfigStore,
  type OAuthTokenRecord,
  type QuotaSnapshotState,
  type QuotaStateRecord,
} from "../../src/application/auth/credentials";

const NOW_MS = 1_700_000_000_000;

function candidate(id: string, overrides: Partial<AccountCandidate> = {}): AccountCandidate {
  return {
    id,
    providerId: "provider-1",
    credentialKind: "api_key",
    health: null,
    enabled: true,
    quotaAvailable: true,
    modelLocks: null,
    ...overrides,
  };
}

function account(id: string, overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id,
    providerId: "provider-1",
    kind: "api_key",
    secret: `fixture-secret-${id}`,
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function configStore(accounts: readonly AccountConfig[]): CredentialConfigStore {
  return {
    getAccount: async (id) => accounts.find((item) => item.id === id),
    listAccounts: async () => accounts,
  };
}

function fakeOAuthPool(options: {
  readonly token?: OAuthTokenRecord;
  readonly forceRefresh?: (accountId: string) => Promise<OAuthTokenRecord>;
} = {}): {
  readonly pool: TokenRefreshPool;
  readonly activeLeaseIds: Set<string>;
  readonly releaseCalls: string[];
  readonly forceRefreshCalls: string[];
} {
  const token = options.token ?? { accessToken: "fixture-access-token", expiresAtMs: NOW_MS + 60_000, refreshToken: "fixture-refresh-token", kind: "oauth" };
  const activeLeaseIds = new Set<string>();
  const releaseCalls: string[] = [];
  const forceRefreshCalls: string[] = [];
  let leaseNumber = 0;
  const pool = {
    lease: async (_accountId: string) => {
      const leaseId = `fixture-token-lease-${leaseNumber += 1}`;
      activeLeaseIds.add(leaseId);
      return { leaseId, token, release: () => releaseLease(leaseId) };
    },
    releaseLease,
    forceRefresh: async (accountId: string) => {
      forceRefreshCalls.push(accountId);
      return options.forceRefresh === undefined ? token : options.forceRefresh(accountId);
    },
  } as unknown as TokenRefreshPool;

  function releaseLease(leaseId: string): boolean {
    releaseCalls.push(leaseId);
    return activeLeaseIds.delete(leaseId);
  }

  return { pool, activeLeaseIds, releaseCalls, forceRefreshCalls };
}

function health(status: RouteHealth["status"], retryAt: string | null = null, disabledUntilMs: number | null = null): RouteHealth {
  return {
    scope: "account",
    status,
    statusCode: status === "healthy" ? null : 503,
    failureKind: status === "healthy" ? null : "provider_unavailable",
    sanitizedMessage: status === "healthy" ? null : "fixture failure",
    occurredAt: status === "healthy" ? null : new Date(NOW_MS).toISOString(),
    retryAt,
    ...(disabledUntilMs === null ? {} : { disabledUntilMs }),
  } as RouteHealth;
}

function providerError(
  kind: Parameters<typeof createProviderError>[0],
  message: string,
  options: Parameters<typeof createProviderError>[2] = {},
): ProviderCallError {
  return createProviderError(kind, message, { routeScope: "account", ...options });
}

describe("credential persistence and health hot paths", () => {
  test("memory stores support point, list, batch, expiration, and deletion operations", async () => {
    const healthStore: AccountHealthStore = new MemoryAccountHealthStore();
    const healthRecord: AccountHealthRecord = {
      accountId: "a",
      providerId: "provider-1",
      status: "healthy",
      statusCode: null,
      failureKind: null,
      sanitizedMessage: null,
      occurredAt: null,
      retryAt: null,
      disabledUntilMs: null,
      failureCount: 0,
      generation: 1,
    };
    await healthStore.set(healthRecord);
    await healthStore.set({ ...healthRecord, accountId: "b", generation: 2 });
    expect(await healthStore.get("a")).toEqual(healthRecord);
    expect((await healthStore.list()).map((item) => item.accountId)).toEqual(["a", "b"]);
    expect((await healthStore.listForAccountIds(["b", "missing"])).map((item) => item.accountId)).toEqual(["b"]);
    expect(await healthStore.listForAccountIds([])).toEqual([]);

    const lockStore = new MemoryModelLockStore();
    const lock: ModelLockRecord = {
      accountId: "a",
      modelId: "model-a",
      retryAt: new Date(NOW_MS + 100).toISOString(),
      errorKind: "provider_rate_limited",
      statusCode: 429,
      sanitizedMessage: "fixture limit",
      failureCount: 1,
    };
    await lockStore.set(lock);
    await lockStore.set({ ...lock, accountId: "b", modelId: "model-b", retryAt: new Date(NOW_MS - 1).toISOString() });
    expect(await lockStore.get("a", "model-a")).toEqual(lock);
    expect((await lockStore.listForAccount("a")).map((item) => item.modelId)).toEqual(["model-a"]);
    expect((await lockStore.listForAccountIds(["a", "missing"])).map((item) => item.accountId)).toEqual(["a"]);
    expect((await lockStore.listExpired(NOW_MS)).map((item) => item.accountId)).toEqual(["b"]);
    await lockStore.delete("a", "model-a");
    expect(await lockStore.get("a", "model-a")).toBeUndefined();

    const quotaStore = new MemoryQuotaStateStore();
    const quota: QuotaStateRecord = { accountId: "a", quotaAvailable: false, lastQuotaRefreshAtMs: NOW_MS };
    await quotaStore.set(quota);
    await quotaStore.set({ accountId: "b", quotaAvailable: true, lastQuotaRefreshAtMs: null });
    expect(await quotaStore.get("a")).toEqual(quota);
    expect((await quotaStore.list()).map((item) => item.accountId)).toEqual(["a", "b"]);
    expect((await quotaStore.listForAccountIds(["b"])).map((item) => item.accountId)).toEqual(["b"]);
    expect(await quotaStore.listForAccountIds([])).toEqual([]);
  });

  test("health manager records retryable, permanent, success, and model-lock transitions", async () => {
    let nowMs = NOW_MS;
    const healthStore = new MemoryAccountHealthStore();
    const lockStore = new MemoryModelLockStore();
    const manager = new AccountHealthManager(healthStore, { nowMs: () => nowMs, cacheTtlMs: 0 }, lockStore);

    expect(await manager.recordFailure("account-a", "provider-1", providerError("provider_protocol_error", "fixture transient", { retryable: true }))).toMatchObject({
      status: "error",
      disabledUntilMs: null,
      failureCount: 1,
    });
    expect(await manager.isUsable("account-a")).toBe(true);
    expect(await manager.recordFailure("account-a", "provider-1", providerError("provider_protocol_error", "not retryable"))).toBeNull();

    const retryAt = new Date(nowMs + 1_000).toISOString();
    const cooling = await manager.recordFailure("account-a", "provider-1", providerError("provider_rate_limited", "fixture rate limit", { retryable: true, statusCode: 429, retryAt }));
    expect(cooling).toMatchObject({ status: "cooling_down", retryAt, disabledUntilMs: nowMs + 1_000, failureCount: 2 });
    expect(await manager.isUsable("account-a")).toBe(false);
    nowMs += 1_000;
    expect(await manager.isUsable("account-a")).toBe(true);
    expect((await manager.getHealth("account-a"))?.status).toBe("healthy");

    const permanent = await manager.recordPermanentFailure("account-a", "provider-1", providerError("authentication_failed", "fixture auth revoked", { statusCode: 401 }));
    expect(permanent).toMatchObject({ status: "disabled", disabledUntilMs: null, failureCount: 3 });
    expect(await manager.isUsable("account-a")).toBe(false);
    expect((await manager.getHealth("account-a"))?.status).toBe("disabled");

    const success = await manager.recordSuccess("account-a", "provider-1");
    expect(success).toMatchObject({ status: "healthy", failureCount: 0, generation: 4 });
    expect(await manager.isUsable("account-a")).toBe(true);
    expect((await manager.getHealthBatch(["account-a", "missing"])).get("account-a")?.status).toBe("healthy");
    expect((await manager.getHealthBatch([])).size).toBe(0);

    const lockRetryAt = new Date(nowMs + 2_000).toISOString();
    const modelLock = await manager.recordModelLock("account-a", "model-a", providerError("provider_rate_limited", "fixture model limit", { retryable: true, statusCode: 429, retryAt: lockRetryAt }));
    expect(modelLock).toMatchObject({ accountId: "account-a", modelId: "model-a", retryAt: lockRetryAt, failureCount: 1 });
    expect(await manager.isModelAvailable("account-a", "model-a")).toBe(false);
    expect(await manager.isModelAvailable("account-a", "model-b")).toBe(true);
    nowMs += 2_000;
    expect(await manager.isModelAvailable("account-a", "model-a")).toBe(true);
    expect((await manager.listModelLocksForAccounts(["account-a"])).get("account-a")).toHaveLength(1);
    expect((await manager.listModelLocksForAccounts([])).size).toBe(0);
    await manager.clearModelLock("account-a", "model-a");
    expect(await manager.listModelLocksForAccount("account-a")).toEqual([]);
    expect(await manager.recordModelLock("account-a", "model-b", providerError("provider_protocol_error", "fixture transient", { retryable: true }))).toBeNull();
  });

  test("cached credential config reads expire and invalidate on a revision change", async () => {
    let nowMs = 100;
    let revision = 0;
    let getCalls = 0;
    let listCalls = 0;
    let accounts = [account("a")];
    const store: CredentialConfigStore = {
      getAccount: async (id) => {
        getCalls += 1;
        return accounts.find((item) => item.id === id);
      },
      listAccounts: async () => {
        listCalls += 1;
        return accounts;
      },
    };
    const cached = createCachedCredentialConfigStore(store, { nowMs: () => nowMs, ttlMs: 50, readRevision: () => revision });

    expect(await cached.getAccount("a")).toEqual(accounts[0]);
    expect(await cached.getAccount("a")).toEqual(accounts[0]);
    expect(getCalls).toBe(1);
    expect(await cached.listAccounts()).toEqual(accounts);
    expect(await cached.listAccounts()).toEqual(accounts);
    expect(listCalls).toBe(1);

    nowMs = 150;
    expect(await cached.getAccount("a")).toEqual(accounts[0]);
    expect(getCalls).toBe(2);
    accounts = [account("a", { enabled: false })];
    revision = 1;
    expect(await cached.listAccounts()).toEqual(accounts);
    expect(listCalls).toBe(2);
    expect(await cached.getAccount("a")).toEqual(accounts[0]);
    expect(getCalls).toBe(2);
  });
});

describe("credential eligibility and ranking boundaries", () => {
  test("eligibility rejects disabled, quota-exhausted, disabled-health, cooling, and locked candidates only at the right boundaries", () => {
    const retryAt = new Date(NOW_MS + 100).toISOString();
    const lock = { accountId: "a", modelId: "model-a", retryAt, errorKind: "provider_rate_limited", statusCode: 429, sanitizedMessage: "fixture", failureCount: 1 } satisfies ModelLockRecord;
    expect(isAccountEligible(candidate("a", { enabled: false }), NOW_MS)).toBe(false);
    expect(isAccountEligible(candidate("a", { quotaAvailable: false }), NOW_MS)).toBe(false);
    expect(isAccountEligible(candidate("a", { health: health("disabled") }), NOW_MS)).toBe(false);
    expect(isAccountEligible(candidate("a", { health: health("cooling_down", retryAt, NOW_MS + 100) }), NOW_MS)).toBe(false);
    expect(isAccountEligible(candidate("a", { health: health("cooling_down", retryAt, NOW_MS + 100) }), NOW_MS + 100)).toBe(true);
    expect(isAccountEligible(candidate("a", { health: health("error") }), NOW_MS)).toBe(true);
    expect(isAccountEligible(candidate("a", { modelLocks: new Map([["model-a", lock]]) }), NOW_MS, "model-a")).toBe(false);
    expect(isAccountEligible(candidate("a", { modelLocks: new Map([["model-a", lock]]) }), NOW_MS, "model-b")).toBe(true);
    expect(isAccountEligible(candidate("a", { modelLocks: new Map([["model-a", lock]]) }), NOW_MS + 100, "model-a")).toBe(true);
    expect(isAccountEligible(candidate("a", { modelLocks: new Map([["model-a", lock]]) }), NOW_MS, undefined)).toBe(true);
    expect(isAccountEligible(candidate("a", { health: null, modelLocks: new Map([["model-a", lock]]) }), NOW_MS, "model-a")).toBe(false);
  });

  test("ranking places eligible preferred candidates first and leaves ineligible ids behind", () => {
    const ranked = rankAccountCandidates([
      candidate("z", { enabled: false }),
      candidate("b"),
      candidate("a"),
    ], "b", NOW_MS);
    expect(ranked.map((item) => item.id)).toEqual(["b", "a", "z"]);
    expect(credentialUnavailableError("provider-1", new Date(NOW_MS + 500).toISOString())).toMatchObject({
      kind: "credential_unavailable",
      retryable: true,
      routeScope: "account",
    });
  });
});

describe("quota coordinator", () => {
  test("defaults missing quota to available, persists state, and respects sweep cooldown", async () => {
    let nowMs = NOW_MS;
    const store = new MemoryQuotaStateStore();
    const coordinator = new QuotaCoordinator(store, { nowMs: () => nowMs, sweepCooldownMs: 100, cacheTtlMs: 0 });
    expect(await coordinator.getQuotaAvailable("missing")).toBe(true);
    expect(await coordinator.getQuotaAvailableBatch([])).toEqual(new Map());

    let refreshCalls = 0;
    const first = await coordinator.refreshQuotaIfDue("account-a", async () => {
      refreshCalls += 1;
      return false;
    });
    expect(first).toEqual({ refreshed: true, quotaAvailable: false, nextRefreshAtMs: NOW_MS + 100 });
    expect(await coordinator.getQuotaAvailable("account-a")).toBe(false);
    expect((await coordinator.getQuotaAvailableBatch(["account-a", "missing"])).get("account-a")).toBe(false);
    nowMs += 50;
    expect(await coordinator.refreshQuotaIfDue("account-a", async () => {
      refreshCalls += 1;
      return true;
    })).toEqual({ refreshed: false, quotaAvailable: false, nextRefreshAtMs: NOW_MS + 100 });
    expect(refreshCalls).toBe(1);

    await coordinator.setQuotaAvailable("account-a", true);
    expect(await coordinator.getQuotaAvailable("account-a")).toBe(true);
    nowMs += 50;
    const second = await coordinator.refreshQuotaIfDue("account-a", async () => {
      refreshCalls += 1;
      return true;
    });
    expect(second.refreshed).toBe(true);
    expect(refreshCalls).toBe(2);
  });

  test("coalesces concurrent refreshes and clears the in-flight entry after completion", async () => {
    let refreshCalls = 0;
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<boolean>();
    const coordinator = new QuotaCoordinator(new MemoryQuotaStateStore(), { nowMs: () => NOW_MS, sweepCooldownMs: 1_000, cacheTtlMs: 0 });
    const refresh = async () => {
      refreshCalls += 1;
      started.resolve();
      return gate.promise;
    };
    const firstPromise = coordinator.refreshQuotaIfDue("account-coalesced", refresh);
    await started.promise;
    const secondPromise = coordinator.refreshQuotaIfDue("account-coalesced", refresh);
    gate.resolve(true);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ refreshed: true, quotaAvailable: true });
    expect(refreshCalls).toBe(1);
    expect(await coordinator.getQuotaAvailable("account-coalesced")).toBe(true);
  });
});

describe("credential selection and leasing", () => {
  test("priority and preferred selection return static credentials and release static leases exactly once", async () => {
    const accounts = [account("a"), account("b")];
    const selector = new CredentialSelector(configStore(accounts), fakeOAuthPool().pool);
    const candidates = [candidate("a"), candidate("b")];

    const first = await selector.select({ providerId: "provider-1", candidates, strategy: "priority" });
    expect(first).toMatchObject({ account: { id: "a" }, reason: "healthy", selection: { kind: "api_key", secret: "fixture-secret-a" } });
    if (first === null) throw new Error("expected first selection");
    const second = await selector.select({ providerId: "provider-1", candidates, strategy: "priority" });
    expect(second).toMatchObject({ account: { id: "b" }, reason: "healthy" });
    if (second === null) throw new Error("expected second selection");
    await selector.release(first.selection.leaseId);
    await selector.release(first.selection.leaseId);
    await selector.release(second.selection.leaseId);
    const afterRelease = await selector.select({ providerId: "provider-1", candidates, strategy: "priority" });
    expect(afterRelease?.account.id).toBe("a");
    if (afterRelease !== null && afterRelease !== undefined) await selector.release(afterRelease.selection.leaseId);

    const preferred = await selector.select({ providerId: "provider-1", candidates, preferredAccountId: "b", strategy: "priority" });
    expect(preferred).toMatchObject({ account: { id: "b" }, reason: "preferred" });
    if (preferred !== null) await selector.release(preferred.selection.leaseId);
    const fallback = await selector.select({ providerId: "provider-1", candidates, preferredAccountId: "missing", strategy: "priority" });
    expect(fallback).toMatchObject({ account: { id: "a" }, reason: "fallback" });
    if (fallback !== null) await selector.release(fallback.selection.leaseId);
  });

  test("round-robin rotates idle accounts while tracking active selections", async () => {
    const candidates = [candidate("a"), candidate("b")];
    const selector = new CredentialSelector(configStore([account("a"), account("b")]), fakeOAuthPool().pool);
    const selected: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await selector.select({ providerId: "provider-1", candidates, strategy: "round-robin" });
      if (result === null) throw new Error("expected round-robin selection");
      selected.push(result.account.id);
      await selector.release(result.selection.leaseId);
    }
    expect(selected).toEqual(["a", "b", "a"]);

    const held = await selector.select({ providerId: "provider-1", candidates, strategy: "round-robin" });
    if (held === null) throw new Error("expected held selection");
    const balanced = await selector.select({ providerId: "provider-1", candidates, strategy: "round-robin" });
    expect(balanced?.account.id).toBe("a");
    await selector.release(held.selection.leaseId);
    if (balanced !== null && balanced !== undefined) await selector.release(balanced.selection.leaseId);
  });

  test("sticky affinity keeps one deterministic account and bypasses usage ranking", async () => {
    const candidates = [candidate("a"), candidate("b"), candidate("c")];
    const selector = new CredentialSelector(configStore(candidates.map((item) => account(item.id))), fakeOAuthPool().pool);
    const snapshots: AccountUsageSnapshot[] = candidates.map((item, index) => ({
      accountId: item.id,
      providerId: "provider-1",
      remainingFraction: index === 0 ? 0.01 : 0.99,
      resetAtMs: NOW_MS + index,
      fetchedAtMs: NOW_MS,
      stale: false,
    }));
    const first = await selector.select({ providerId: "provider-1", candidates, affinityKey: "tenant-a", stickyLimit: 2, usageSnapshots: snapshots, nowMs: NOW_MS });
    if (first === null) throw new Error("expected sticky selection");
    const second = await selector.select({ providerId: "provider-1", candidates, affinityKey: "tenant-a", stickyLimit: 2, usageSnapshots: snapshots, nowMs: NOW_MS });
    expect(second?.account.id).toBe(first.account.id);
    expect(first.reason).toBe("healthy");
    await selector.release(first.selection.leaseId);
    if (second !== null && second !== undefined) await selector.release(second.selection.leaseId);
  });

  test("usage snapshots rank headroom, normalize quota records/maps, and ignore stale data", async () => {
    const candidates = [candidate("a"), candidate("b")];
    const selector = new CredentialSelector(configStore([account("a"), account("b")]), fakeOAuthPool().pool);
    const quotaSnapshot: QuotaSnapshotState = {
      source: "fixture",
      status: "ready",
      plan: "fixture",
      windows: [{ kind: "daily", label: "daily", usedPercent: 20, remainingPercent: 80, resetsAt: new Date(NOW_MS + 5_000).toISOString() }],
      fetchedAt: new Date(NOW_MS).toISOString(),
      lastAttemptAt: new Date(NOW_MS).toISOString(),
      lastSuccessAt: new Date(NOW_MS).toISOString(),
      error: null,
    };
    const usageSnapshots = new Map<string, AccountUsageSnapshot | QuotaStateRecord>([
      ["a", { accountId: "a", providerId: "provider-1", remainingFraction: 0.2, resetAtMs: NOW_MS + 10_000, fetchedAtMs: NOW_MS, stale: false }],
      ["b", { accountId: "b", quotaAvailable: true, lastQuotaRefreshAtMs: NOW_MS, lastQuotaSuccessAtMs: NOW_MS, quota: quotaSnapshot }],
    ]);
    const usage = await selector.select({ providerId: "provider-1", candidates, usageSnapshots, strategy: "priority", nowMs: NOW_MS });
    expect(usage).toMatchObject({ account: { id: "b" }, reason: "usage_headroom" });
    if (usage !== null) await selector.release(usage.selection.leaseId);

    const stale = await selector.select({
      providerId: "provider-1",
      candidates,
      usageSnapshots: [{ accountId: "a", providerId: "provider-1", remainingFraction: 1, resetAtMs: null, fetchedAtMs: NOW_MS - 10_000, stale: true }],
      usageSnapshotTtlMs: 100,
      strategy: "priority",
      nowMs: NOW_MS,
    });
    expect(stale?.account.id).toBe("a");
    expect(stale?.reason).toBe("healthy");
    if (stale !== null && stale !== undefined) await selector.release(stale.selection.leaseId);
  });

  test("usage provider failures fall back to deterministic ranking and forceRefresh delegates bounded errors", async () => {
    const candidates = [candidate("a"), candidate("b")];
    let providerCalls = 0;
    const forcedError = providerError("provider_unavailable", "fixture refresh outage", { retryable: true, statusCode: 503 });
    const oauth = fakeOAuthPool({ forceRefresh: async () => { throw forcedError; } });
    const selector = new CredentialSelector(configStore([account("a"), account("b")]), oauth.pool);
    const result = await selector.select({
      providerId: "provider-1",
      candidates,
      usageSnapshotProvider: async () => {
        providerCalls += 1;
        throw new Error("fixture usage source unavailable");
      },
      usageSnapshotTimeoutMs: 5,
      strategy: "priority",
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ account: { id: "a" }, reason: "healthy" });
    expect(providerCalls).toBe(1);
    if (result !== null) await selector.release(result.selection.leaseId);
    await expect(selector.forceRefresh("a")).rejects.toMatchObject({ kind: forcedError.kind, statusCode: 503, retryable: true });
  });

  test("missing, disabled, empty static, and OAuth refresh-failure configs surface bounded errors", async () => {
    const oneCandidate = [candidate("a")];
    const oauth = fakeOAuthPool();
    const missing = new CredentialSelector(configStore([]), oauth.pool);
    await expect(missing.select({ providerId: "provider-1", candidates: oneCandidate })).rejects.toMatchObject({ kind: "credential_unavailable", retryable: false });

    const disabled = new CredentialSelector(configStore([account("a", { enabled: false })]), oauth.pool);
    await expect(disabled.select({ providerId: "provider-1", candidates: oneCandidate })).rejects.toMatchObject({ kind: "credential_unavailable", retryable: false });

    const empty = new CredentialSelector(configStore([account("a", { secret: "" })]), oauth.pool);
    await expect(empty.select({ providerId: "provider-1", candidates: oneCandidate })).rejects.toMatchObject({ kind: "credential_unavailable", retryable: false });

    const refreshError = providerError("provider_unavailable", "fixture oauth refresh unavailable", { retryable: true, statusCode: 503 });
    const failingOAuth = {
      lease: async () => { throw refreshError; },
      releaseLease: () => false,
      forceRefresh: async () => { throw refreshError; },
    } as unknown as TokenRefreshPool;
    const oauthAccount = account("a", { kind: "oauth", secret: JSON.stringify({ accessToken: "fixture-stale", projectId: "fixture-project" }) });
    const oauthSelector = new CredentialSelector(configStore([oauthAccount]), failingOAuth);
    await expect(oauthSelector.select({ providerId: "provider-1", candidates: [candidate("a", { credentialKind: "oauth" })] })).rejects.toMatchObject({ kind: "provider_unavailable", statusCode: 503, retryable: true });
  });

  test("OAuth bundles preserve provider metadata and release underlying leases idempotently", async () => {
    const oauth = fakeOAuthPool();
    const selector = new CredentialSelector(configStore([account("oauth-a", { kind: "oauth", secret: JSON.stringify({ accessToken: "fixture-old", projectId: "fixture-project", region: "fixture-region" }) })]), oauth.pool);
    const result = await selector.select({ providerId: "provider-1", candidates: [candidate("oauth-a", { credentialKind: "oauth" })] });
    if (result === null) throw new Error("expected OAuth selection");
    expect(JSON.parse(result.selection.secret)).toEqual({ accessToken: "fixture-access-token", projectId: "fixture-project", region: "fixture-region" });
    expect(oauth.activeLeaseIds.size).toBe(1);
    await selector.release(result.selection.leaseId);
    await selector.release(result.selection.leaseId);
    expect(oauth.activeLeaseIds.size).toBe(0);
    expect(oauth.releaseCalls).toEqual(["fixture-token-lease-1"]);
    expect(fingerprintOAuthToken({ accessToken: "fixture-access-token", expiresAtMs: null, refreshToken: null, kind: "oauth" })).toBe(fingerprintOAuthToken({ accessToken: "fixture-access-token", expiresAtMs: NOW_MS, refreshToken: null, kind: "oauth" }));
  });
});

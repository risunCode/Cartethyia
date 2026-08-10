import { describe, expect, test } from "bun:test";
import { createProviderError } from "../../src/traffic";
import { recoverCall } from "../../src/open-sse/handlers/recovery";
import { KimchiOAuthDriver } from "../../src/application/auth/oauth/kimchi";
import { resolveAuthDriverCapabilities } from "../../src/application/auth/drivers";
import { fingerprintOAuthToken, MemoryOAuthTokenStore, type AccountConfig, type CredentialConfigStore, type OAuthTokenRecord } from "../../src/application/auth/credentials";
import { createCleanupStack, type ProviderOutput } from "../../src/application/contracts";
import { TokenRefreshPool } from "../../src/application/auth/token-refresh";

const account: AccountConfig = { id: "hardening-account", providerId: "codex", kind: "oauth", secret: null, enabled: true, priority: 1 };
const accounts: CredentialConfigStore = { getAccount: async () => account, listAccounts: async () => [account] };
function expiredToken(refreshToken = "refresh-old"): OAuthTokenRecord {
  return { accessToken: "access-old", expiresAtMs: 1, refreshToken, kind: "oauth", generation: 0 };
}

function successfulOutput(): ProviderOutput {
  return { mode: "non_stream", body: { ok: true } };
}

describe("OAuth refresh durability", () => {
  test("rejects a stale generation and token fingerprint during compare-and-swap", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set(account.id, expiredToken());

    const committed = await store.compareAndSwap?.({
      accountId: account.id,
      expectedGeneration: 0,
      expectedTokenFingerprint: "stale",
      token: { ...expiredToken(), accessToken: "access-new", refreshToken: "refresh-new", generation: 1 },
    });

    expect(committed).toBe(false);
    expect((await store.get(account.id))?.accessToken).toBe("access-old");
  });

  test("durable lease ownership blocks a competing owner until release", async () => {
    const store = new MemoryOAuthTokenStore();
    const token = expiredToken();
    await store.set(account.id, token);
    const input = { accountId: account.id, generation: 0, tokenFingerprint: fingerprintOAuthToken(token), nowMs: 10_000, leaseMs: 15_000 };

    expect(await store.tryAcquireRefreshLease?.({ ...input, ownerId: "owner-a" })).toBe(true);
    expect(await store.tryAcquireRefreshLease?.({ ...input, ownerId: "owner-b" })).toBe(false);
    await store.releaseRefreshLease?.(account.id, "owner-a");
    expect(await store.tryAcquireRefreshLease?.({ ...input, ownerId: "owner-b" })).toBe(true);
  });

  test("two concurrent callers on one pool perform one rotating refresh", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set(account.id, expiredToken());
    let calls = 0;
    const pool = new TokenRefreshPool(accounts, store, {
      refresh: async () => {
        calls += 1;
        return { ok: true as const, token: { accessToken: "access-new", expiresAtMs: 100_000, refreshToken: "refresh-new", kind: "oauth" as const } };
      },
    }, { ownerId: "owner-pool", nowMs: () => 10_000 });

    const [left, right] = await Promise.all([pool.ensureFresh(account.id), pool.forceRefresh(account.id)]);
    expect(calls).toBe(1);
    expect(left.accessToken).toBe("access-new");
    expect(right.accessToken).toBe("access-new");
    expect((await store.get(account.id))?.generation).toBe(1);
  });

  test("backs off transient refresh failure until the persisted retry deadline", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set(account.id, expiredToken());
    let now = 10_000;
    let calls = 0;
    const pool = new TokenRefreshPool(accounts, store, {
      refresh: async () => {
        calls += 1;
        return { ok: false as const, error: createProviderError("provider_unavailable", "temporary outage", { retryable: true, routeScope: "account" }) };
      },
    }, { nowMs: () => now, ownerId: "owner-retry" });


    await expect(pool.ensureFresh(account.id)).rejects.toMatchObject({ kind: "provider_unavailable" });
    await expect(pool.ensureFresh(account.id)).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(calls).toBe(1);
    now += 2_000;
    await expect(pool.ensureFresh(account.id)).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(calls).toBe(2);
  });
  test("enforces minimum scheduled refresh spacing before max-age refresh", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set(account.id, { ...expiredToken(), accessToken: "access-fresh", expiresAtMs: null, lastRefreshAtMs: 9_000 });
    let now = 10_000;
    let calls = 0;
    const pool = new TokenRefreshPool(accounts, store, {
      refresh: async () => {
        calls += 1;
        return { ok: true as const, token: { accessToken: "access-new", expiresAtMs: 100_000, refreshToken: "refresh-new", kind: "oauth" as const } };
      },
    }, { nowMs: () => now, defaultPolicy: { refreshLeadMs: 0, maxRefreshAgeMs: 1_000, minRefreshIntervalMs: 5_000, jitterMs: 0 }, ownerId: "owner-cadence" });

    await pool.sweep();
    expect(calls).toBe(0);
    now = 15_000;
    await pool.sweep();
    expect(calls).toBe(1);
  });
});

describe("OAuth recovery contracts", () => {
  test("runs the auth failure hook before deciding whether a stream may retry", async () => {
    let attemptCount = 0;
    let retryReady = false;
    const authFailure = createProviderError("authentication_failed", "upstream rejected access token", { statusCode: 401, retryable: false, routeScope: "account" });
    const output = await recoverCall({
      attempt: async (): Promise<ProviderOutput> => {
        attemptCount += 1;
        if (attemptCount === 1) throw authFailure;
        return successfulOutput();
      },
      maxAttempts: 2,
      signal: new AbortController().signal,
      cleanup: createCleanupStack(),
      onFailure: async () => { retryReady = true; },
      shouldRetry: () => retryReady,
    });

    expect(output).toEqual({ mode: "non_stream", body: { ok: true } });
    expect(attemptCount).toBe(2);
  });
});

describe("OAuth provider capabilities", () => {
  test("marks Kimchi Kimi as a refreshable device-flow provider", () => {
    const capabilities = resolveAuthDriverCapabilities(new KimchiOAuthDriver({ fetch: async () => new Response("{}") }));
    expect(capabilities.supportsRefresh).toBe(true);
    expect(capabilities.accessOnly).toBe(false);
  });
});

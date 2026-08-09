import { describe, expect, test } from "bun:test";
import { makeProviderError } from "../src/traffic";
import { OAuthDriverError } from "../src/application/auth/oauth/base";
import { createDriverAwareOAuthRefresher } from "../src/application/auth/oauth-refresher";
import {
  MemoryOAuthTokenStore,
  MemoryQuotaStateStore,
  type AccountConfig,
  type CredentialConfigStore,
  type OAuthTokenRecord,
} from "../src/application/auth/credentials";
import { QuotaRefreshWorker, TokenRefreshPool } from "../src/application/auth";
import { fetchProviderQuota } from "../src/providers/quota/fetcher";

const account: AccountConfig = { id: "account-1", providerId: "codex", kind: "oauth", secret: null, enabled: true, priority: 1 };
const accounts: CredentialConfigStore = { getAccount: async () => account, listAccounts: async () => [account] };

function expiredToken(refreshToken = "old-refresh-token"): OAuthTokenRecord {
  return { accessToken: "old-access-token", expiresAtMs: 1, refreshToken, kind: "oauth" };
}

describe("central OAuth refresh pool", () => {
  test("coalesces concurrent request and manual refresh into one rotated-token exchange", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set(account.id, expiredToken());
    let calls = 0;
    const pool = new TokenRefreshPool(accounts, store, {
      refresh: async () => {
        calls += 1;
        await Promise.resolve();
        return { ok: true, token: { accessToken: "new-access-token", expiresAtMs: 100_000, refreshToken: "rotated-refresh-token", kind: "oauth" } };
      },
    }, { nowMs: () => 10_000 });

    const [requestToken, manualToken] = await Promise.all([pool.ensureFresh(account.id), pool.forceRefresh(account.id)]);

    expect(calls).toBe(1);
    expect(requestToken.accessToken).toBe("new-access-token");
    expect(manualToken.refreshToken).toBe("rotated-refresh-token");
    expect((await store.get(account.id))?.lastRefreshAtMs).toBe(10_000);
  });

  test("persists reauthentication state after a permanent revoked-grant response", async () => {
    const store = new MemoryOAuthTokenStore();
    await store.set(account.id, expiredToken());
    let calls = 0;
    const revoked = makeProviderError("authentication_failed", "OAuth refresh token revoked", { statusCode: 400, retryable: false, routeScope: "account" });
    const pool = new TokenRefreshPool(accounts, store, {
      refresh: async () => {
        calls += 1;
        return { ok: false, error: revoked };
      },
    }, { nowMs: () => 10_000 });

    await expect(pool.ensureFresh(account.id)).rejects.toMatchObject({ kind: "authentication_failed" });
    await expect(pool.ensureFresh(account.id)).rejects.toMatchObject({ kind: "authentication_failed" });

    expect(calls).toBe(1);
    expect((await store.get(account.id))?.refreshState).toBe("reauth_required");
    expect((await store.get(account.id))?.lastRefreshStatusCode).toBe(400);
  });
  test("classifies HTTP 400 refresh-token responses as permanent reauthentication", async () => {
    const refresher = createDriverAwareOAuthRefresher({
      drivers: { get: () => ({ refresh: async () => { throw new OAuthDriverError("token-refresh-http", "provider OAuth token refresh failed with HTTP 400", 400, false); } }) } as never,
      resolveProvider: async () => "codex",
    });
    const result = await refresher.refresh({ accountId: account.id, token: expiredToken() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("authentication_failed");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("central quota refresh worker", () => {
  test("prevents overlapping sweeps and honors persisted success cadence", async () => {
    const state = new MemoryQuotaStateStore();
    let now = 1_000_000;
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const worker = new QuotaRefreshWorker(accounts, state, async (accountId) => {
      calls += 1;
      await gate.promise;
      await state.set({ accountId, quotaAvailable: true, lastQuotaRefreshAtMs: now });
      return true;
    }, { nowMs: () => now, intervalMs: 60_000, supportsProvider: (providerId) => providerId === "codex" });

    const first = worker.sweep();
    await Promise.resolve();
    const second = worker.sweep();
    gate.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);

    now += 30_000;
    await worker.sweep();
    expect(calls).toBe(1);
    now += 30_000;
    await worker.sweep();
    expect(calls).toBe(2);
  });
});

describe("general quota transport", () => {
  test("maps HTTP auth failures to an error state instead of an empty healthy quota", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const result = await fetchProviderQuota("codex", "stale-access-token", undefined, fetcher);
    expect(result.error).toContain("Quota endpoint rejected request");
    expect(result.error).not.toContain("stale-access-token");
  });

  test("keeps Codex bundle identity while using the rotated access token for quota", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const fetcher = (async (url: string, init?: RequestInit) => {
      request = { url, init };
      return new Response(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 600 } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const credential = JSON.stringify({ accessToken: "stale-bundle-access", providerAccountId: "account-123", email: "user@example.com" });
    const result = await fetchProviderQuota("codex", credential, { accessToken: "rotated-access", expiresAtMs: null, refreshToken: null, kind: "oauth" }, fetcher);

    expect(result.error).toBeNull();
    expect(result.plan).toBe("plus");
    expect(request?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer rotated-access");
    expect(new Headers(request?.init?.headers).get("chatgpt-account-id")).toBe("account-123");
  });

  test("uses the Antigravity project-discovery POST contract and client headers", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const fetcher = (async (url: string, init?: RequestInit) => {
      request = { url, init };
      return new Response(JSON.stringify({ models: { gemini: { quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-01T00:00:00Z" } } } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await fetchProviderQuota("antigravity", JSON.stringify({ accessToken: "access", projectId: "project-1" }), undefined, fetcher);

    expect(result.error).toBeNull();
    expect(request?.url).toContain("fetchAvailableModels");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.body).toBe(JSON.stringify({ project: "project-1" }));
    expect(new Headers(request?.init?.headers).get("x-client-name")).toBe("antigravity");
  });
});

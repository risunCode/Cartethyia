import { describe, expect, test } from "bun:test";
import { oauthRefreshSweep } from "../../src/workers/oauth-refresh-worker";
import type { OAuthRefreshService, OAuthTokenRefresher } from "../../src/providers/authentication/oauth-refresh-service";

type RefreshServiceStub = Pick<OAuthRefreshService, "ensureFreshAccessToken">;

const dummyRefresher: OAuthTokenRefresher = {
  refresh: async () => ({ access: "a", refresh: "r", expiresAt: new Date() }),
};

function resolveRefresherFrom(map: ReadonlyMap<string, OAuthTokenRefresher>) {
  return async (providerId: string): Promise<OAuthTokenRefresher | undefined> => map.get(providerId);
}

function makeService(): RefreshServiceStub & {
  calls: Array<{ accountId: string; opts?: { force?: boolean; skewMs?: number } }>;
} {
  const calls: Array<{ accountId: string; opts?: { force?: boolean; skewMs?: number } }> = [];
  return {
    calls,
    ensureFreshAccessToken: async (accountId, _refresher, opts) => {
      calls.push({ accountId, ...(opts ? { opts } : {}) });
      return "fresh";
    },
  };
}

describe("oauthRefreshSweep", () => {
  test("skips accounts whose provider has no registered refresher", async () => {
    const service = makeService();
    await oauthRefreshSweep({
      loadDueAccounts: async () => [{ id: "a1", providerId: "unknown" }],
      refreshService: service,
      resolveRefresher: resolveRefresherFrom(new Map()),
    });
    expect(service.calls).toHaveLength(0);
  });

  test("refreshes every due account with a registered refresher", async () => {
    const service = makeService();
    let due = 0;
    let attempted = 0;
    await oauthRefreshSweep({
      loadDueAccounts: async () => [
        { id: "a1", providerId: "p1" },
        { id: "a2", providerId: "p1" },
      ],
      refreshService: service,
      resolveRefresher: resolveRefresherFrom(new Map([["p1", dummyRefresher]])),
      onTick: (r) => {
        due = r.due;
        attempted = r.attempted;
      },
    });
    expect(service.calls.map((c) => c.accountId).sort()).toEqual(["a1", "a2"]);
    expect(due).toBe(2);
    expect(attempted).toBe(2);
  });

  test("isolates a per-account error instead of failing the whole sweep", async () => {
    const errors: unknown[] = [];
    const service = makeService();
    service.ensureFreshAccessToken = async (accountId) => {
      if (accountId === "bad") throw new Error("boom");
      return "fresh";
    };
    await oauthRefreshSweep({
      loadDueAccounts: async () => [
        { id: "bad", providerId: "p1" },
        { id: "good", providerId: "p1" },
      ],
      refreshService: service,
      resolveRefresher: resolveRefresherFrom(new Map([["p1", dummyRefresher]])),
      onAccountError: (_id, _pid, error) => void errors.push(error),
    });
    expect(errors).toHaveLength(1);
  });

  test("bounds per-sweep concurrency instead of fanning out unbounded", async () => {
    let inFlight = 0;
    let peak = 0;
    const service = makeService();
    service.ensureFreshAccessToken = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return "fresh";
    };
    const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, providerId: "p1" }));
    await oauthRefreshSweep({
      loadDueAccounts: async () => accounts,
      refreshService: service,
      resolveRefresher: resolveRefresherFrom(new Map([["p1", dummyRefresher]])),
      maxConcurrency: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("logs and absorbs a due-accounts load failure instead of rejecting", async () => {
    const service = makeService();
    await expect(
      oauthRefreshSweep({
        loadDueAccounts: async () => {
          throw new Error("db down");
        },
        refreshService: service,
        resolveRefresher: resolveRefresherFrom(new Map([["p1", dummyRefresher]])),
      }),
    ).resolves.toBeUndefined();
    expect(service.calls).toHaveLength(0);
  });
});
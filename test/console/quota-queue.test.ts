import { describe, expect, test } from "bun:test";
import { AccountHealthManager, MemoryAccountHealthStore, MemoryOAuthTokenStore, MemoryQuotaStateStore } from "../../src/application/auth";
import { QuotaService } from "../../src/console/services/composition";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("quota refresh queue", () => {
  test("coalesces duplicate accounts and caps active refreshes", async () => {
    const waiters: Array<() => void> = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const accounts = {
      get: async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        const gate = Promise.withResolvers<void>();
        waiters.push(gate.resolve);
        await gate.promise;
        activeCalls -= 1;
        return null;
      },
    };
    const service = new QuotaService(accounts as never, {} as never, {} as never);

    const initial = service.enqueueRefresh(["a", "a", "b", "c", "d", "e"]);
    expect(initial.active).toBe(3);
    expect(initial.queued).toBe(2);
    expect(maxActiveCalls).toBe(3);

    waiters.splice(0, 3).forEach((release) => release());
    await flushMicrotasks();
    expect(service.queueStatus().active).toBe(2);
    expect(service.queueStatus().queued).toBe(0);
    expect(maxActiveCalls).toBe(3);

    waiters.splice(0).forEach((release) => release());
    await flushMicrotasks();
    expect(service.queueStatus().active).toBe(0);
    expect(service.queueStatus().queued).toBe(0);
  });

  test("does not disable accounts when a provider has no quota endpoint", async () => {
    const storedState: { value: { readonly accountId: string; readonly quotaAvailable: boolean } | null } = { value: null };
    const account = {
      id: "account-1",
      providerId: "cursor",
      name: "cursor-1",
      credentialKind: "api_key",
      credentialHint: "cursor-1",
      priority: 100,
      active: true,
      createdAt: "",
      updatedAt: "",
      health: null,
      quota: null,
    };
    const service = new QuotaService({
      get: async () => account,
      credential: async () => ({ credential: "test-key" }),
    } as never, {
      get: async () => null,
      set: async (state: { readonly accountId: string; readonly quotaAvailable: boolean }) => { storedState.value = state; },
    } as never, {} as never);

    const result = await service.refresh("account-1");
    expect(result?.status).toBe("error");
    expect(result?.error).toBe("Quota endpoint is not available for this provider.");
    expect(storedState.value?.quotaAvailable).toBe(true);
  });
  test("clears stale quota and disables invalidated OAuth accounts", async () => {
    const account = {
      id: "oauth-account",
      providerId: "codex",
      name: "Codex OAuth",
      credentialKind: "oauth",
      credentialHint: "user@example.com",
      priority: 100,
      active: true,
      createdAt: "",
      updatedAt: "",
      health: null,
      quota: null,
    };
    const tokens = new MemoryOAuthTokenStore();
    await tokens.set(account.id, { accessToken: "access", expiresAtMs: 1, refreshToken: "refresh", kind: "oauth", refreshState: "reauth_required" });
    const states = new MemoryQuotaStateStore();
    await states.set({
      accountId: account.id,
      quotaAvailable: true,
      lastQuotaRefreshAtMs: 10,
      lastQuotaSuccessAtMs: 10,
      quota: {
        source: "codex",
        status: "ready",
        plan: "Plus",
        windows: [{ kind: "weekly", label: "168 hour", usedPercent: 10, remainingPercent: 90, resetsAt: "2026-08-20T00:00:00.000Z" }],
        fetchedAt: "2026-08-11T00:00:00.000Z",
        lastAttemptAt: "2026-08-11T00:00:00.000Z",
        lastSuccessAt: "2026-08-11T00:00:00.000Z",
        error: null,
      },
    });
    const health = new AccountHealthManager(new MemoryAccountHealthStore(), { nowMs: () => 20 });
    const service = new QuotaService({
      get: async () => account,
      credential: async () => ({ credential: "oauth-bundle" }),
    } as never, states, tokens, {
      ensureFresh: async () => { throw new Error("must not refresh a reauthenticated account"); },
    }, health);

    const result = await service.refresh(account.id);
    const stored = await states.get(account.id);
    const healthView = await health.getHealth(account.id);

    expect(result?.windows).toEqual([]);
    expect(result?.plan).toBeNull();
    expect(result?.lastSuccessAt).toBeNull();
    expect(result?.error).toContain("OAuth account invalidated");
    expect(stored?.quotaAvailable).toBe(false);
    expect(stored?.lastQuotaSuccessAtMs).toBeNull();
    expect(healthView?.status).toBe("disabled");
    expect(await health.isUsable(account.id)).toBe(false);
  });
});

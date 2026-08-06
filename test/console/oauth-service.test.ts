import { describe, expect, test } from "bun:test";
import type { AccountListOptions, AccountListResult, AccountRepository, AccountRowView, ActiveAccountCredential } from "../../src/console/services";
import { OAuthService } from "../../src/console/services";
import type { AuthDriver } from "../../src/auth";
import { MemoryOAuthTokenStore, MapAuthDriverRegistry, OAuthDriverError, OAuthLoginSessionManager } from "../../src/auth";
import { createDriverAwareOAuthRefresher } from "../../src/auth";

function mockDriver(overrides: Partial<AuthDriver> = {}): { readonly driver: AuthDriver; readonly calls: { start: number; exchange: number; refresh: number; revoke: number } } {
  const calls = { start: 0, exchange: 0, refresh: 0, revoke: 0 };
  const driver: AuthDriver = {
    kind: "oauth",
    buildHeaders: () => ({}),
    async start(input) {
      calls.start += 1;
      return { authorizationUrl: `https://auth.example.com/authorize?state=${input.state}`, state: input.state ?? "state", expiresAtMs: Date.now() + 600_000 };
    },
    async exchange() {
      calls.exchange += 1;
      return { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async refresh() {
      calls.refresh += 1;
      return { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async revoke() {
      calls.revoke += 1;
    },
    ...overrides,
  };
  return { driver, calls };
}

class StubAccountRepository implements AccountRepository {
  readonly rows = new Map<string, AccountRowView>();

  async list(providerId?: string): Promise<readonly AccountRowView[]> {
    return [...this.rows.values()].filter((row) => providerId === undefined || row.providerId === providerId);
  }

  async listPaged(providerId: string, options: AccountListOptions): Promise<AccountListResult> {
    const all = [...this.rows.values()].filter((row) => row.providerId === providerId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const start = options.cursor ? all.findIndex((row) => row.id > options.cursor!) : 0;
    const slice = start === -1 ? [] : all.slice(start, start + limit);
    const nextCursor = slice.length === limit ? (slice[slice.length - 1]?.id ?? null) : null;
    return { items: slice, nextCursor };
  }

  async get(id: string): Promise<AccountRowView | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: { readonly providerId: string; readonly name: string; readonly credentialKind: "api_key" | "oauth" | "manual" | "none"; readonly credential: string; readonly priority?: number; readonly active?: boolean }): Promise<{ readonly id: string; readonly credentialHint: string }> {
    const id = crypto.randomUUID();
    const row: AccountRowView = {
      id,
      providerId: input.providerId,
      name: input.name,
      credentialKind: input.credentialKind,
      credentialHint: `${input.credential.slice(0, 4)}…`,
      priority: input.priority ?? 0,
      active: input.active ?? true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      health: null,
      quota: null,
    };
    this.rows.set(id, row);
    return { id, credentialHint: row.credentialHint };
  }

  async update(id: string, patch: { readonly name?: string; readonly credentialKind?: "api_key" | "oauth" | "manual" | "none"; readonly credential?: string; readonly priority?: number; readonly active?: boolean }): Promise<AccountRowView | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    const next: AccountRowView = {
      ...row,
      name: patch.name ?? row.name,
      credentialKind: patch.credentialKind ?? row.credentialKind,
      priority: patch.priority ?? row.priority,
      active: patch.active ?? row.active,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async removeBatch(ids: readonly string[]): Promise<number> {
    let count = 0;
    for (const id of ids) { if (this.rows.delete(id)) count++; }
    return count;
  }

  async setActiveBatch(ids: readonly string[], active: boolean): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) { this.rows.set(id, { ...row, active }); count++; }
    }
    return count;
  }

  async credential(): Promise<{ readonly credential: string } | null> {
    return null;
  }

  async listActiveCredentials(): Promise<readonly ActiveAccountCredential[]> {
    return [];
  }

  async health(): Promise<null> {
    return null;
  }

  async quota(): Promise<null> {
    return null;
  }
}

interface Harness {
  readonly service: OAuthService;
  readonly accounts: StubAccountRepository;
  readonly tokens: MemoryOAuthTokenStore;
  readonly registry: MapAuthDriverRegistry;
  readonly calls: { start: number; exchange: number; refresh: number; revoke: number };
}

function harness(overrides: Partial<AuthDriver> = {}): Harness {
  const { driver, calls } = mockDriver(overrides);
  const registry = new MapAuthDriverRegistry();
  registry.register("codex", driver);
  const accounts = new StubAccountRepository();
  const tokens = new MemoryOAuthTokenStore();
  const service = new OAuthService({
    sessions: new OAuthLoginSessionManager({ drivers: registry }),
    refresher: createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async (accountId) => (await accounts.get(accountId))?.providerId ?? null }),
    drivers: registry,
    accounts,
    tokens,
  });
  return { service, accounts, tokens, registry, calls };
}

describe("console OAuth lifecycle", () => {
  test("starts an interactive session with the provider authorization URL", async () => {
    const { service } = harness();
    const started = await service.start({ providerId: "codex", name: "My Codex" });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.authorizationUrl).toContain("https://auth.example.com/authorize");
      expect(started.state.length).toBeGreaterThan(0);
      expect(started.expiresAtMs).toBeGreaterThan(Date.now());
      const session = await service.session(started.sessionId);
      expect(session?.status).toBe("waiting-for-user");
      expect(session?.name).toBe("My Codex");
    }
  });

  test("polls device OAuth and persists the account on completion", async () => {
    const { service, accounts } = harness({
      start: async (input) => ({ authorizationUrl: "https://device.example/verify", state: input.state ?? "device-state", expiresAtMs: Date.now() + 60_000, userCode: "ABCD-1234", verificationUri: "https://device.example/verify", intervalSeconds: 1 }),
      poll: async () => ({ status: "completed", tokenSet: { accessToken: "device-access", refreshToken: "device-refresh" } }),
    });
    const started = await service.start({ providerId: "codex", name: "Device account" });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("device start failed");
    expect(started.userCode).toBe("ABCD-1234");
    const status = await service.session(started.sessionId);
    expect(status?.status).toBe("completed");
    expect(status?.accountId).not.toBeNull();
    expect(await accounts.list("codex")).toHaveLength(1);
  });

  test("rejects start for a provider without a driver", async () => {
    const { service, registry } = harness();
    registry.register("unknown", { kind: "oauth", buildHeaders: () => ({}) });
    const started = await service.start({ providerId: "unknown", name: "Ghost" });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe("invalid_request");
  });

  test("rejects start for a provider whose driver has no interactive flow", async () => {
    const { service, registry } = harness();
    registry.register("refresh-only", { kind: "oauth", buildHeaders: () => ({}), refresh: async () => ({ accessToken: "a" }) });
    const started = await service.start({ providerId: "refresh-only", name: "Passive" });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe("invalid_request");
  });

  test("exchanges the code, persists the account and token through storage ports", async () => {
    const { service, accounts, tokens, calls } = harness();
    const started = await service.start({ providerId: "codex", name: "My Codex" });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    expect(completed.ok).toBe(true);
    expect(calls.exchange).toBe(1);
    if (completed.ok) {
      expect(completed.status).toBe("completed");
      const account = await accounts.get(completed.accountId);
      expect(account?.credentialKind).toBe("oauth");
      expect(account?.active).toBe(true);
      const token = await tokens.get(completed.accountId);
      expect(token?.accessToken).toBe("access-1");
      expect(token?.refreshToken).toBe("refresh-1");
      const session = await service.session(started.sessionId);
      expect(session?.status).toBe("completed");
      expect(session?.accountId).toBe(completed.accountId);
    }
  });

  test("accepts a legacy callback URL value with code and state", async () => {
    const { service } = harness();
    const started = await service.start({ providerId: "codex", name: "Legacy" });
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { value: `http://localhost:1455/auth/callback?code=legacy-code&state=${started.state}` });
    expect(completed.ok).toBe(true);
  });

  test("rejects a mismatched state and marks the session failed", async () => {
    const { service } = harness();
    const started = await service.start({ providerId: "codex", name: "My Codex" });
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { code: "auth-code", state: "wrong-state" });
    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.status).toBe(400);
      expect(completed.code).toBe("invalid_request");
    }
    const session = await service.session(started.sessionId);
    expect(session?.status).toBe("failed");
  });

  test("maps a provider exchange failure to an error and keeps the account store untouched", async () => {
    const { service, accounts } = harness({ exchange: async () => { throw new OAuthDriverError("token exchange", "provider rejected the code", 502, true); } });
    const started = await service.start({ providerId: "codex", name: "My Codex" });
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.code).toBe("internal_error");
    expect((await accounts.list()).length).toBe(0);
  });

  test("rejects completing a session twice", async () => {
    const { service } = harness();
    const started = await service.start({ providerId: "codex", name: "Once" });
    if (!started.ok) throw new Error("start failed");
    const first = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    expect(first.ok).toBe(true);
    const second = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("conflict");
  });

  test("cancels a pending session", async () => {
    const { service } = harness();
    const started = await service.start({ providerId: "codex", name: "Cancel Me" });
    if (!started.ok) throw new Error("start failed");
    expect(await service.cancel(started.sessionId)).toBe(true);
    expect((await service.session(started.sessionId))?.status).toBe("cancelled");
    expect(await service.cancel("missing-session")).toBe(false);
  });

  test("expires sessions past their TTL", async () => {
    let now = Date.now();
    const { driver } = mockDriver();
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", driver);
    const accounts = new StubAccountRepository();
    const tokens = new MemoryOAuthTokenStore();
    const service = new OAuthService({
      sessions: new OAuthLoginSessionManager({ drivers: registry, nowMs: () => now, ttlMs: 60_000 }),
      refresher: createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => null }),
      drivers: registry,
      accounts,
      tokens,
    });
    const started = await service.start({ providerId: "codex", name: "Ticking" });
    if (!started.ok) throw new Error("start failed");
    now += 61_000;
    expect((await service.session(started.sessionId))?.status).toBe("expired");
    const completed = await service.complete(started.sessionId, { code: "late-code", state: started.state });
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.code).toBe("invalid_request");
  });

  test("refreshes an account explicitly and persists the rotated token", async () => {
    const { service, tokens, calls } = harness();
    const started = await service.start({ providerId: "codex", name: "Rotate" });
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    if (!completed.ok) throw new Error("complete failed");
    const refreshed = await service.refreshAccount(completed.accountId);
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.expiresAt).not.toBeNull();
    expect(calls.refresh).toBe(1);
    const token = await tokens.get(completed.accountId);
    expect(token?.accessToken).toBe("access-2");
    expect(token?.refreshToken).toBe("refresh-2");
    const status = await service.accountStatus(completed.accountId);
    expect(status?.expired).toBe(false);
  });

  test("surfaces a refresh failure without touching the stored token", async () => {
    const { service, tokens } = harness({ refresh: async () => { throw new OAuthDriverError("refresh", "refresh rejected", 401, false); } });
    const started = await service.start({ providerId: "codex", name: "Failing" });
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    if (!completed.ok) throw new Error("complete failed");
    const refreshed = await service.refreshAccount(completed.accountId);
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.code).toBe("unauthorized");
    const token = await tokens.get(completed.accountId);
    expect(token?.accessToken).toBe("access-1");
  });

  test("rejects refresh for non-OAuth accounts and accounts without a refresh token", async () => {
    const { service, accounts, tokens } = harness();
    const apiKeyAccount = await accounts.create({ providerId: "codex", name: "Key", credentialKind: "api_key", credential: "sk-1234" });
    const refused = await service.refreshAccount(apiKeyAccount.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("invalid_request");
    const oauthAccount = await accounts.create({ providerId: "codex", name: "No Token", credentialKind: "oauth", credential: "{}" });
    const noToken = await service.refreshAccount(oauthAccount.id);
    expect(noToken.ok).toBe(false);
    if (!noToken.ok) expect(noToken.code).toBe("invalid_request");

    const bearerAccount = await accounts.create({ providerId: "codex", name: "Bearer", credentialKind: "oauth", credential: "{}" });
    await tokens.set(bearerAccount.id, { accessToken: "browser-access", refreshToken: null, expiresAtMs: null, kind: "oauth" });
    const alreadyUsable = await service.refreshAccount(bearerAccount.id);
    expect(alreadyUsable).toEqual({ ok: true, expiresAt: null });
  });

  test("reports bounded account status including the expired state", async () => {
    const { service, accounts, tokens } = harness();
    const created = await accounts.create({ providerId: "codex", name: "Expired", credentialKind: "oauth", credential: "{}" });
    await tokens.set(created.id, { accessToken: "old-access", refreshToken: "old-refresh", expiresAtMs: Date.now() - 1_000, kind: "oauth" });
    const status = await service.accountStatus(created.id);
    expect(status).not.toBeNull();
    expect(status?.linked).toBe(true);
    expect(status?.hasRefreshToken).toBe(true);
    expect(status?.expired).toBe(true);
    expect(status?.refreshable).toBe(true);
    expect(status?.revocable).toBe(true);
    expect(await service.accountStatus("missing")).toBeNull();
  });

  test("revokes an account: driver call, disable, and token clear", async () => {
    const { service, accounts, tokens, calls } = harness();
    const started = await service.start({ providerId: "codex", name: "Revoke Me" });
    if (!started.ok) throw new Error("start failed");
    const completed = await service.complete(started.sessionId, { code: "auth-code", state: started.state });
    if (!completed.ok) throw new Error("complete failed");
    expect(await service.revoke("codex", completed.accountId)).toBe(true);
    expect(calls.revoke).toBe(1);
    const account = await accounts.get(completed.accountId);
    expect(account?.active).toBe(false);
    expect(await tokens.get(completed.accountId)).toBeUndefined();
    expect(await service.revoke("codex", "missing")).toBe(false);
  });
});
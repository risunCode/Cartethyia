import { describe, expect, test, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigPersistence, resetConfigPersistenceForTests } from "../../src/storage/main/config";
import type { ConfigPersistence } from "../../src/storage/main/config";
import type { PersistenceEnv } from "../../src/storage/main/env";
import type { AccountConfig, OAuthTokenRecord, QuotaStateRecord } from "../../src/auth/credentials";
import type { ModelLockRecord } from "../../src/domain/contracts";
import type { ProxyConfig } from "../../src/traffic/network";
import type { FilterRuleView } from "../../src/console/views";
import type { WarpAccount, WarpAccountCreateData } from "../../src/console/warp/types";
import type { RouteHealth } from "../../src/domain/contracts";

function testEnv(): PersistenceEnv {
  const dir = join(tmpdir(), `cartethyia-durable-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return {
    dataDir: dir,
    dbPath: join(dir, "cartethyia.sqlite"),
    runtimeDbPath: join(dir, "runtime.sqlite"),
    assetDir: join(dir, "assets"),
    logRetentionDays: 14,
    assetRetentionDays: 7,
    maxFlightsPerIp: 15,
  };
}

beforeEach(() => {
  resetConfigPersistenceForTests();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePersistence(): ConfigPersistence {
  return createConfigPersistence(testEnv());
}

function seedAccount(
  p: ConfigPersistence,
  over: Partial<{ id: string; provider: string; name: string; credential: string; credentialHint: string; kind: "api_key" | "oauth" | "manual" | "none"; active: boolean; priority: number }> = {},
): string {
  const id = over.id ?? `acc-${Math.random().toString(36).slice(2, 8)}`;
  p.accounts.create({
    id,
    provider: over.provider ?? "openai",
    name: over.name ?? id,
    credentialKind: over.kind ?? "api_key",
    credential: over.credential ?? "sk-test-secret",
    credentialHint: over.credentialHint ?? "…test",
    priority: over.priority ?? 100,
    active: over.active ?? true,
  });
  return id;
}

function seedProxy(
  p: ConfigPersistence,
  over: Partial<{ id: string; name: string; protocol: "http" | "https" | "socks5"; host: string; port: number; active: boolean; priority: number }> = {},
): string {
  const id = over.id ?? `px-${Math.random().toString(36).slice(2, 8)}`;
  p.proxies.create({
    id,
    name: over.name ?? id,
    protocol: over.protocol ?? "http",
    host: over.host ?? "127.0.0.1",
    port: over.port ?? 8080,
    active: over.active ?? true,
    priority: over.priority ?? 100,
  });
  return id;
}

function makeQuotaRecord(accountId: string, over: Partial<QuotaStateRecord> = {}): QuotaStateRecord {
  return {
    accountId,
    quotaAvailable: over.quotaAvailable ?? true,
    lastQuotaRefreshAtMs: over.lastQuotaRefreshAtMs ?? Date.now(),
    lastQuotaAttemptAtMs: over.lastQuotaAttemptAtMs ?? null,
    lastQuotaSuccessAtMs: over.lastQuotaSuccessAtMs ?? null,
    quota: over.quota ?? null,
  };
}

function makeOAuthToken(over: Partial<OAuthTokenRecord> = {}): OAuthTokenRecord {
  return {
    accessToken: over.accessToken ?? "access-token-value",
    expiresAtMs: over.expiresAtMs ?? null,
    refreshToken: over.refreshToken ?? null,
    kind: "oauth",
  };
}

function makeRouteHealth(
  scope: "account" | "proxy",
  over: Partial<RouteHealth> = {},
): RouteHealth {
  return {
    scope,
    status: over.status ?? "healthy",
    statusCode: over.statusCode ?? null,
    failureKind: over.failureKind ?? null,
    sanitizedMessage: over.sanitizedMessage ?? null,
    occurredAt: over.occurredAt ?? new Date().toISOString(),
    retryAt: over.retryAt ?? null,
  };
}

function makeWarpCreateData(over: Partial<WarpAccountCreateData> = {}): WarpAccountCreateData {
  return {
    id: over.id ?? `warp-${Math.random().toString(36).slice(2, 8)}`,
    label: over.label ?? "test-warp",
    deviceId: over.deviceId ?? "device-123",
    accessToken: over.accessToken ?? "warp-access-token",
    licenseKey: over.licenseKey ?? "warp-license-key",
    privateKey: over.privateKey ?? "warp-private-key",
    addressV4: over.addressV4 ?? "172.16.0.2",
    addressV6: over.addressV6 ?? "fd01::2",
    publicKey: over.publicKey ?? "warp-public-key",
    endpoint: over.endpoint ?? "engage.cloudflarewireless.com",
    endpointPort: over.endpointPort ?? 2408,
    dns: over.dns ?? "1.1.1.1",
    mtu: over.mtu ?? 1280,
    socksPort: over.socksPort ?? 40000,
  };
}

// ── DurableQuotaStateStore ──────────────────────────────────────────────────

describe("DurableQuotaStateStore", () => {
  test("get returns undefined for an unknown account id", async () => {
    const p = makePersistence();
    const store = p.stores.quotaState;
    expect(await store.get("nonexistent-account")).toBeUndefined();
  });

  test("set then get round-trips quota state", async () => {
    const p = makePersistence();
    const store = p.stores.quotaState;
    const accountId = seedAccount(p, { id: "quota-acc-1" });
    // QuotaStateStore.set does UPDATE — the health row must exist first.
    p.accountHealth.upsert(accountId, makeRouteHealth("account"));

    const record = makeQuotaRecord(accountId, {
      quotaAvailable: true,
      lastQuotaRefreshAtMs: 1_700_000_000_000,
      lastQuotaSuccessAtMs: 1_700_000_000_000,
    });
    await store.set(record);

    const got = await store.get(accountId);
    expect(got).toBeDefined();
    expect(got!.accountId).toBe(accountId);
    expect(got!.quotaAvailable).toBe(true);
    expect(got!.lastQuotaRefreshAtMs).toBe(1_700_000_000_000);
    expect(got!.lastQuotaSuccessAtMs).toBe(1_700_000_000_000);
  });

  test("set silently no-ops when the account does not exist", async () => {
    const p = makePersistence();
    const store = p.stores.quotaState;
    await store.set(makeQuotaRecord("ghost-account"));
    expect(await store.get("ghost-account")).toBeUndefined();
  });

  test("list returns all accounts with stored quota", async () => {
    const p = makePersistence();
    const store = p.stores.quotaState;
    const a1 = seedAccount(p, { id: "quota-a1" });
    const a2 = seedAccount(p, { id: "quota-a2" });
    p.accountHealth.upsert(a1, makeRouteHealth("account"));
    p.accountHealth.upsert(a2, makeRouteHealth("account"));

    await store.set(makeQuotaRecord(a1, { quotaAvailable: true }));
    await store.set(makeQuotaRecord(a2, { quotaAvailable: false }));

    const all = await store.list();
    expect(all.length).toBe(2);
    const ids = all.map((r) => r.accountId);
    expect(ids).toContain(a1);
    expect(ids).toContain(a2);
  });

  test("quotaAvailable defaults to true when stored 'available' is not false", async () => {
    const p = makePersistence();
    const store = p.stores.quotaState;
    const accountId = seedAccount(p, { id: "quota-default-acc" });
    p.accountHealth.upsert(accountId, makeRouteHealth("account"));

    await store.set(makeQuotaRecord(accountId, { quotaAvailable: true }));
    const got = await store.get(accountId);
    expect(got!.quotaAvailable).toBe(true);
  });

  test("set overwrites previous quota for the same account", async () => {
    const p = makePersistence();
    const store = p.stores.quotaState;
    const accountId = seedAccount(p, { id: "quota-overwrite" });
    p.accountHealth.upsert(accountId, makeRouteHealth("account"));

    await store.set(makeQuotaRecord(accountId, {
      quotaAvailable: true, lastQuotaRefreshAtMs: 1_000, lastQuotaSuccessAtMs: 1_000,
    }));
    await store.set(makeQuotaRecord(accountId, {
      quotaAvailable: false, lastQuotaRefreshAtMs: 2_000, lastQuotaSuccessAtMs: 2_000,
    }));

    const got = await store.get(accountId);
    expect(got!.quotaAvailable).toBe(false);
    expect(got!.lastQuotaRefreshAtMs).toBe(2_000);
  });
});

// ── DurableOAuthTokenStore ──────────────────────────────────────────────────

describe("DurableOAuthTokenStore", () => {
  test("get returns undefined for an unknown account id", async () => {
    const p = makePersistence();
    expect(await p.stores.oauthToken.get("nonexistent")).toBeUndefined();
  });

  test("set then get round-trips an OAuth token bundle", async () => {
    const p = makePersistence();
    const store = p.stores.oauthToken;
    const accountId = seedAccount(p, { id: "oauth-acc-1" });

    const token = makeOAuthToken({
      accessToken: "at-secret-123",
      expiresAtMs: 1_700_000_000_000,
      refreshToken: "rt-secret-456",
    });
    await store.set(accountId, token);

    const got = await store.get(accountId);
    expect(got).toBeDefined();
    expect(got!.accessToken).toBe("at-secret-123");
    expect(got!.expiresAtMs).toBe(1_700_000_000_000);
    expect(got!.refreshToken).toBe("rt-secret-456");
    expect(got!.kind).toBe("oauth");
  });

  test("set silently no-ops when the account does not exist", async () => {
    const p = makePersistence();
    const store = p.stores.oauthToken;
    await store.set("ghost-account", makeOAuthToken());
    expect(await store.get("ghost-account")).toBeUndefined();
  });

  test("delete clears the token; subsequent get returns undefined", async () => {
    const p = makePersistence();
    const store = p.stores.oauthToken;
    const accountId = seedAccount(p, { id: "oauth-del-acc" });

    await store.set(accountId, makeOAuthToken({ accessToken: "to-delete" }));
    expect((await store.get(accountId))!.accessToken).toBe("to-delete");

    await store.delete(accountId);
    const got = await store.get(accountId);
    // After delete, credential is emptied — toToken returns a token with empty
    // accessToken from the empty string, which is filtered out (length === 0
    // → undefined).
    expect(got).toBeUndefined();
  });

  test("get treats a raw bearer credential as a non-refreshable OAuth token", async () => {
    const p = makePersistence();
    const store = p.stores.oauthToken;
    const accountId = seedAccount(p, {
      id: "oauth-bearer",
      credential: "raw-bearer-token-abc",
      kind: "oauth",
    });

    const got = await store.get(accountId);
    expect(got).toBeDefined();
    expect(got!.accessToken).toBe("raw-bearer-token-abc");
    expect(got!.refreshToken).toBeNull();
    expect(got!.expiresAtMs).toBeNull();
  });

  test("set merges with previous credential bundle fields", async () => {
    const p = makePersistence();
    const store = p.stores.oauthToken;
    const accountId = seedAccount(p, { id: "oauth-merge" });

    await store.set(accountId, makeOAuthToken({
      accessToken: "first-at",
      refreshToken: "shared-rt",
    }));
    // Update only the access token; refresh should persist.
    await store.set(accountId, makeOAuthToken({
      accessToken: "second-at",
      refreshToken: null,
    }));

    // The bundle stores refreshToken as null, but since the previous
    // bundle had it, the merge replaces it with null.
    const got = await store.get(accountId);
    expect(got!.accessToken).toBe("second-at");
  });
});

// ── DurableCredentialConfigStore ────────────────────────────────────────────

describe("DurableCredentialConfigStore", () => {
  test("getAccount returns undefined for an unknown id", async () => {
    const p = makePersistence();
    expect(await p.stores.credentialConfig.getAccount("nonexistent")).toBeUndefined();
  });

  test("getAccount returns the account config with mapped kind and secret", async () => {
    const p = makePersistence();
    const store = p.stores.credentialConfig;
    seedAccount(p, {
      id: "cred-acc-1",
      provider: "openai",
      credential: "sk-secret-value",
      kind: "api_key",
    });

    const got = await store.getAccount("cred-acc-1");
    expect(got).toBeDefined();
    expect(got!.id).toBe("cred-acc-1");
    expect(got!.providerId).toBe("openai");
    expect(got!.kind).toBe("api_key");
    expect(got!.secret).toBe("sk-secret-value");
    expect(got!.enabled).toBe(true);
    expect(got!.priority).toBe(100);
  });

  test("getAccount returns null secret when credential is empty", async () => {
    const p = makePersistence();
    const store = p.stores.credentialConfig;
    seedAccount(p, { id: "cred-empty", credential: "" });

    const got = await store.getAccount("cred-empty");
    expect(got!.secret).toBeNull();
  });

  test("getAccount returns disabled=false for inactive accounts", async () => {
    const p = makePersistence();
    const store = p.stores.credentialConfig;
    seedAccount(p, { id: "cred-inactive", active: false });

    const got = await store.getAccount("cred-inactive");
    expect(got!.enabled).toBe(false);
  });

  test("listAccounts returns all accounts ordered by provider, priority, name", async () => {
    const p = makePersistence();
    const store = p.stores.credentialConfig;
    seedAccount(p, { id: "cred-b", provider: "openai", priority: 200, name: "beta" });
    seedAccount(p, { id: "cred-a", provider: "openai", priority: 100, name: "alpha" });
    seedAccount(p, { id: "cred-c", provider: "anthropic", priority: 50, name: "gamma" });

    const all = await store.listAccounts();
    expect(all.length).toBe(3);
    // Ordered by provider ASC, priority ASC, name ASC
    expect(all[0]!.id).toBe("cred-c"); // anthropic
    expect(all[1]!.id).toBe("cred-a"); // openai, priority 100
    expect(all[2]!.id).toBe("cred-b"); // openai, priority 200
  });

  test("kind 'oauth' maps through credentialKindOf", async () => {
    const p = makePersistence();
    const store = p.stores.credentialConfig;
    seedAccount(p, { id: "cred-oauth", kind: "oauth" });

    const got = await store.getAccount("cred-oauth");
    expect(got!.kind).toBe("oauth");
  });

  test("kind 'manual' maps through credentialKindOf", async () => {
    const p = makePersistence();
    const store = p.stores.credentialConfig;
    seedAccount(p, { id: "cred-manual", kind: "manual" });

    const got = await store.getAccount("cred-manual");
    expect(got!.kind).toBe("manual");
  });
});

// ── DurableProxyPoolConfigStore ─────────────────────────────────────────────

describe("DurableProxyPoolConfigStore", () => {
  test("getProxy returns the config without enabling the pool", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    seedProxy(p, { id: "pool-px-1" });
    // Pool is always enabled — no global toggle anymore.
    const got = await store.getProxy("pool-px-1");
    expect(got).toBeDefined();
    expect(got!.id).toBe("pool-px-1");
  });

  test("listProxies returns all proxies without enabling the pool", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    seedProxy(p, { id: "pool-px-2" });
    expect((await store.listProxies()).length).toBe(1);
  });

  test("getProxy returns the config when pool is enabled", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    seedProxy(p, { id: "pool-px-3" });
    p.proxies.patchSettings({ enabled: true });

    const got = await store.getProxy("pool-px-3");
    expect(got).toBeDefined();
    expect(got!.id).toBe("pool-px-3");
    expect(got!.url).toContain("127.0.0.1:8080");
    expect(got!.enabled).toBe(true);
    expect(got!.maxConcurrency).toBe(8);
    expect(got!.priority).toBe(100);
    expect(got!.weight).toBe(100);
    expect(got!.excludedProviderIds).toEqual([]);
  });

  test("getProxy returns undefined for unknown proxy id when pool enabled", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    p.proxies.patchSettings({ enabled: true });
    expect(await store.getProxy("nonexistent")).toBeUndefined();
  });

  test("listProxies returns all proxies when pool is enabled", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    seedProxy(p, { id: "pool-a", priority: 100 });
    seedProxy(p, { id: "pool-b", priority: 50 });
    p.proxies.patchSettings({ enabled: true });

    const all = await store.listProxies();
    expect(all.length).toBe(2);
    // Ordered by priority ASC, name ASC
    expect(all[0]!.id).toBe("pool-b");
    expect(all[1]!.id).toBe("pool-a");
  });

  test("proxy url includes auth credentials when username and password set", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    p.proxies.create({
      id: "pool-auth",
      name: "pool-auth",
      protocol: "http",
      host: "proxy.example.com",
      port: 3128,
      username: "user",
      password: "pass",
    });
    p.proxies.patchSettings({ enabled: true });

    const got = await store.getProxy("pool-auth");
    expect(got).toBeDefined();
    expect(got!.url).toContain("user:pass@");
    expect(got!.url).toContain("proxy.example.com:3128");
  });

  test("proxy url includes username-only auth when password is null", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    p.proxies.create({
      id: "pool-user-only",
      name: "pool-user-only",
      protocol: "socks5",
      host: "socks.example.com",
      port: 1080,
      username: "justuser",
      password: null,
    });
    p.proxies.patchSettings({ enabled: true });

    const got = await store.getProxy("pool-user-only");
    expect(got!.url).toContain("justuser@");
    expect(got!.url).not.toContain("justuser:pass@");
  });

  test("weight is clamped to [1, 1000]", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    p.proxies.create({
      id: "pool-heavy",
      name: "pool-heavy",
      protocol: "http",
      host: "h",
      port: 80,
      weight: 5000,
    });
    p.proxies.patchSettings({ enabled: true });

    const got = await store.getProxy("pool-heavy");
    expect(got!.weight).toBe(1000);
  });

  test("excludedProviderIds propagate from proxy settings", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    seedProxy(p, { id: "pool-excl" });
    p.proxies.patchSettings({
      enabled: true,
      excludedProviders: ["openai", "anthropic"],
    });

    const got = await store.getProxy("pool-excl");
    expect(got!.excludedProviderIds).toEqual(["openai", "anthropic"]);
  });

  test("isRelay reflects the proxy's relay flag", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    p.proxies.create({
      id: "pool-relay",
      name: "pool-relay",
      protocol: "http",
      host: "relay.example.com",
      port: 8080,
      isRelay: true,
    });
    p.proxies.patchSettings({ enabled: true });

    const got = await store.getProxy("pool-relay");
    expect(got!.isRelay).toBe(true);
  });

  test("disabled proxy in enabled pool still returns its config", async () => {
    const p = makePersistence();
    const store = p.stores.proxyPool;
    seedProxy(p, { id: "pool-disabled", active: false });
    p.proxies.patchSettings({ enabled: true });

    const got = await store.getProxy("pool-disabled");
    expect(got).toBeDefined();
    expect(got!.enabled).toBe(false);
  });
});

// ── FilterRuleRepository ────────────────────────────────────────────────────

describe("FilterRuleRepository", () => {
  test("create and list a plain-text rule", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({
      pattern: "secret-key",
      replacement: "[REDACTED]",
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.ruleId).toMatch(/^rule_/);
    expect(created.pattern).toBe("secret-key");
    expect(created.replacement).toBe("[REDACTED]");
    expect(created.isActive).toBe(true);
    expect(created.isRegex).toBe(true); // isRegex defaults to true (input.isRegex !== false)
    expect(created.sortOrder).toBe(1);

    const all = await p.filterRules.list();
    expect(all.length).toBe(1);
    expect(all[0]!.ruleId).toBe(created.ruleId);
  });

  test("create with explicit ruleId uses the provided id", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({
      ruleId: "custom-rule-id",
      pattern: "test-pattern",
    });
    expect(created.ruleId).toBe("custom-rule-id");
  });

  test("create with isRegex=false stores a plain-text rule", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({
      pattern: "literal-text",
      isRegex: false,
    });
    expect(created.isRegex).toBe(false);
  });

  test("create with isActive=false stores an inactive rule", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({
      pattern: "inactive-rule",
      isActive: false,
    });
    expect(created.isActive).toBe(false);
  });

  test("create throws on empty pattern", async () => {
    const p = makePersistence();
    await expect(p.filterRules.create({ pattern: "   " })).rejects.toThrow("pattern is required");
  });

  test("create throws on invalid regex pattern", async () => {
    const p = makePersistence();
    await expect(p.filterRules.create({ pattern: "[invalid", isRegex: true })).rejects.toThrow("invalid regex pattern");
  });

  test("sort order auto-increments for each new rule", async () => {
    const p = makePersistence();
    const a = await p.filterRules.create({ pattern: "a" });
    const b = await p.filterRules.create({ pattern: "b" });
    const c = await p.filterRules.create({ pattern: "c" });
    expect(a.sortOrder).toBe(1);
    expect(b.sortOrder).toBe(2);
    expect(c.sortOrder).toBe(3);
  });

  test("update patches pattern, replacement, isActive, isRegex, sortOrder", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({ pattern: "original" });
    const updated = await p.filterRules.update(created.id, {
      pattern: "updated-pattern",
      replacement: "updated-replacement",
      isActive: false,
      isRegex: false,
      sortOrder: 99,
    });
    expect(updated).not.toBeNull();
    expect(updated!.pattern).toBe("updated-pattern");
    expect(updated!.replacement).toBe("updated-replacement");
    expect(updated!.isActive).toBe(false);
    expect(updated!.isRegex).toBe(false);
    expect(updated!.sortOrder).toBe(99);
  });

  test("update returns null for unknown id", async () => {
    const p = makePersistence();
    const updated = await p.filterRules.update(99999, { pattern: "x" });
    expect(updated).toBeNull();
  });

  test("update throws on empty pattern", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({ pattern: "valid" });
    await expect(p.filterRules.update(created.id, { pattern: "  " })).rejects.toThrow("pattern cannot be empty");
  });

  test("update with empty patch returns the unchanged rule", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({ pattern: "no-change" });
    const updated = await p.filterRules.update(created.id, {});
    expect(updated).not.toBeNull();
    expect(updated!.pattern).toBe("no-change");
  });

  test("remove deletes the rule and returns true", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({ pattern: "to-remove" });
    expect(await p.filterRules.remove(created.id)).toBe(true);
    expect((await p.filterRules.list()).length).toBe(0);
  });

  test("remove returns false for unknown id", async () => {
    const p = makePersistence();
    expect(await p.filterRules.remove(99999)).toBe(false);
  });

  test("list returns rules ordered by sort_order ASC, id ASC", async () => {
    const p = makePersistence();
    const a = await p.filterRules.create({ pattern: "a" });
    const b = await p.filterRules.create({ pattern: "b" });
    await p.filterRules.update(a.id, { sortOrder: 10 });
    await p.filterRules.update(b.id, { sortOrder: 5 });

    const all = await p.filterRules.list();
    expect(all[0]!.id).toBe(b.id); // sortOrder 5
    expect(all[1]!.id).toBe(a.id); // sortOrder 10
  });

  test("replacement defaults to empty string", async () => {
    const p = makePersistence();
    const created = await p.filterRules.create({ pattern: "no-repl" });
    expect(created.replacement).toBe("");
  });
});

// ── WarpAccountRepository ───────────────────────────────────────────────────

describe("WarpAccountRepository", () => {
  test("create and get round-trip a warp account", async () => {
    const p = makePersistence();
    const data = makeWarpCreateData({ id: "warp-create-1", label: "my-warp" });
    const created = await p.warpAccounts.create(data);

    expect(created.id).toBe("warp-create-1");
    expect(created.label).toBe("my-warp");
    expect(created.deviceId).toBe(data.deviceId);
    expect(created.accessToken).toBe(data.accessToken);
    expect(created.licenseKey).toBe(data.licenseKey);
    expect(created.privateKey).toBe(data.privateKey);
    expect(created.addressV4).toBe(data.addressV4);
    expect(created.addressV6).toBe(data.addressV6);
    expect(created.publicKey).toBe(data.publicKey);
    expect(created.endpoint).toBe(data.endpoint);
    expect(created.endpointPort).toBe(data.endpointPort);
    expect(created.dns).toBe(data.dns);
    expect(created.mtu).toBe(data.mtu);
    expect(created.socksPort).toBe(data.socksPort);
    expect(created.enabled).toBe(true); // always created with enabled=1
    expect(created.running).toBe(false); // always created with running=0
    expect(created.pid).toBeNull();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeNull();

    const got = await p.warpAccounts.get("warp-create-1");
    expect(got).not.toBeNull();
    expect(got!.label).toBe("my-warp");
  });

  test("get returns null for unknown id", async () => {
    const p = makePersistence();
    expect(await p.warpAccounts.get("nonexistent")).toBeNull();
  });

  test("list returns all warp accounts ordered by created_at ASC", async () => {
    const p = makePersistence();
    const a = await p.warpAccounts.create(makeWarpCreateData({ id: "warp-list-a" }));
    const b = await p.warpAccounts.create(makeWarpCreateData({ id: "warp-list-b" }));

    const all = await p.warpAccounts.list();
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe("warp-list-a");
    expect(all[1]!.id).toBe("warp-list-b");
  });

  test("list returns empty when no accounts exist", async () => {
    const p = makePersistence();
    expect((await p.warpAccounts.list()).length).toBe(0);
  });

  test("update patches label, enabled, and socksPort", async () => {
    const p = makePersistence();
    const created = await p.warpAccounts.create(makeWarpCreateData({ id: "warp-update-1" }));

    const updated = await p.warpAccounts.update("warp-update-1", {
      label: "new-label",
      enabled: false,
      socksPort: 50000,
    });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe("new-label");
    expect(updated!.enabled).toBe(false);
    expect(updated!.socksPort).toBe(50000);
    expect(updated!.updatedAt).not.toBeNull();
  });

  test("update returns null for unknown id", async () => {
    const p = makePersistence();
    const updated = await p.warpAccounts.update("nonexistent", { label: "x" });
    expect(updated).toBeNull();
  });

  test("update with empty patch returns the unchanged account", async () => {
    const p = makePersistence();
    const created = await p.warpAccounts.create(makeWarpCreateData({ id: "warp-empty-patch" }));
    const updated = await p.warpAccounts.update("warp-empty-patch", {});
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe(created.label);
  });

  test("remove deletes the account and returns true", async () => {
    const p = makePersistence();
    await p.warpAccounts.create(makeWarpCreateData({ id: "warp-remove-1" }));
    expect(await p.warpAccounts.remove("warp-remove-1")).toBe(true);
    expect(await p.warpAccounts.get("warp-remove-1")).toBeNull();
  });

  test("remove returns false for unknown id", async () => {
    const p = makePersistence();
    expect(await p.warpAccounts.remove("nonexistent")).toBe(false);
  });

  test("setRunning updates running flag and pid", async () => {
    const p = makePersistence();
    const id = "warp-running-1";
    await p.warpAccounts.create(makeWarpCreateData({ id }));

    await p.warpAccounts.setRunning(id, true, 12345);
    const running = await p.warpAccounts.get(id);
    expect(running!.running).toBe(true);
    expect(running!.pid).toBe(12345);

    await p.warpAccounts.setRunning(id, false, null);
    const stopped = await p.warpAccounts.get(id);
    expect(stopped!.running).toBe(false);
    expect(stopped!.pid).toBeNull();
  });
});

// ── HealthRepository (account + proxy scopes) ──────────────────────────────

describe("HealthRepository: account scope", () => {
  test("get returns null for an unknown account id", async () => {
    const p = makePersistence();
    expect(await p.accountHealth.get("nonexistent")).toBeNull();
  });

  test("upsert then get round-trips account health", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "health-acc-1" });
    const health = makeRouteHealth("account", {
      status: "error",
      statusCode: 429,
      failureKind: "rate_limited",
      sanitizedMessage: "Too many requests",
    });

    await p.accountHealth.upsert(accountId, health);
    const got = await p.accountHealth.get(accountId);
    expect(got).not.toBeNull();
    expect(got!.scope).toBe("account");
    expect(got!.status).toBe("error");
    expect(got!.statusCode).toBe(429);
    expect(got!.failureKind).toBe("rate_limited");
    expect(got!.sanitizedMessage).toBe("Too many requests");
  });

  test("upsert silently no-ops when the parent account does not exist", async () => {
    const p = makePersistence();
    // No account seeded — upsert should be a silent no-op.
    await p.accountHealth.upsert("ghost-account", makeRouteHealth("account"));
    expect(await p.accountHealth.get("ghost-account")).toBeNull();
    expect((await p.accountHealth.list()).length).toBe(0);
  });

  test("upsert overwrites previous health on conflict (same account id)", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "health-overwrite" });

    await p.accountHealth.upsert(accountId, makeRouteHealth("account", { status: "healthy" }));
    await p.accountHealth.upsert(accountId, makeRouteHealth("account", { status: "error", statusCode: 500 }));

    const got = await p.accountHealth.get(accountId);
    expect(got!.status).toBe("error");
    expect(got!.statusCode).toBe(500);
  });

  test("list returns all account health records", async () => {
    const p = makePersistence();
    const a1 = seedAccount(p, { id: "health-list-a" });
    const a2 = seedAccount(p, { id: "health-list-b" });

    await p.accountHealth.upsert(a1, makeRouteHealth("account"));
    await p.accountHealth.upsert(a2, makeRouteHealth("account", { status: "cooling_down" }));

    const all = await p.accountHealth.list();
    expect(all.length).toBe(2);
    const statuses = all.map((r) => r.status);
    expect(statuses).toContain("healthy");
    expect(statuses).toContain("cooling_down");
  });

  test("clear removes the health record for a given account", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "health-clear" });
    await p.accountHealth.upsert(accountId, makeRouteHealth("account"));

    await p.accountHealth.clear(accountId);
    expect(await p.accountHealth.get(accountId)).toBeNull();
  });

  test("clear on unknown id is a silent no-op", async () => {
    const p = makePersistence();
    await p.accountHealth.clear("nonexistent");
    expect((await p.accountHealth.list()).length).toBe(0);
  });
});

describe("HealthRepository: proxy scope", () => {
  test("get returns null for an unknown proxy id", async () => {
    const p = makePersistence();
    expect(await p.proxyHealth.get("nonexistent")).toBeNull();
  });

  test("upsert then get round-trips proxy health", async () => {
    const p = makePersistence();
    const proxyId = seedProxy(p, { id: "health-px-1" });
    const health = makeRouteHealth("proxy", {
      status: "error",
      statusCode: 502,
      failureKind: "upstream_error",
      sanitizedMessage: "Bad Gateway",
    });

    await p.proxyHealth.upsert(proxyId, health);
    const got = await p.proxyHealth.get(proxyId);
    expect(got).not.toBeNull();
    expect(got!.scope).toBe("proxy");
    expect(got!.status).toBe("error");
    expect(got!.statusCode).toBe(502);
    expect(got!.failureKind).toBe("upstream_error");
    expect(got!.sanitizedMessage).toBe("Bad Gateway");
  });

  test("upsert silently no-ops when the parent proxy does not exist", async () => {
    const p = makePersistence();
    await p.proxyHealth.upsert("ghost-proxy", makeRouteHealth("proxy"));
    expect(await p.proxyHealth.get("ghost-proxy")).toBeNull();
    expect((await p.proxyHealth.list()).length).toBe(0);
  });

  test("upsert overwrites previous health on conflict (same proxy id)", async () => {
    const p = makePersistence();
    const proxyId = seedProxy(p, { id: "health-px-overwrite" });

    await p.proxyHealth.upsert(proxyId, makeRouteHealth("proxy", { status: "healthy" }));
    await p.proxyHealth.upsert(proxyId, makeRouteHealth("proxy", { status: "disabled" }));

    const got = await p.proxyHealth.get(proxyId);
    expect(got!.status).toBe("disabled");
  });

  test("list returns all proxy health records", async () => {
    const p = makePersistence();
    const p1 = seedProxy(p, { id: "health-px-list-a" });
    const p2 = seedProxy(p, { id: "health-px-list-b" });

    await p.proxyHealth.upsert(p1, makeRouteHealth("proxy"));
    await p.proxyHealth.upsert(p2, makeRouteHealth("proxy", { status: "error" }));

    const all = await p.proxyHealth.list();
    expect(all.length).toBe(2);
  });

  test("clear removes the health record for a given proxy", async () => {
    const p = makePersistence();
    const proxyId = seedProxy(p, { id: "health-px-clear" });
    await p.proxyHealth.upsert(proxyId, makeRouteHealth("proxy"));

    await p.proxyHealth.clear(proxyId);
    expect(await p.proxyHealth.get(proxyId)).toBeNull();
  });

  test("account and proxy health are isolated (separate tables)", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "iso-acc" });
    const proxyId = seedProxy(p, { id: "iso-px" });

    await p.accountHealth.upsert(accountId, makeRouteHealth("account", { status: "error" }));
    await p.proxyHealth.upsert(proxyId, makeRouteHealth("proxy", { status: "healthy" }));

    // Same id string used for both scopes — they must not collide.
    const accHealth = await p.accountHealth.get(accountId);
    const pxHealth = await p.proxyHealth.get(proxyId);
    expect(accHealth!.status).toBe("error");
    expect(pxHealth!.status).toBe("healthy");

    // Account health list should not contain the proxy record and vice versa.
    const accAll = await p.accountHealth.list();
    const pxAll = await p.proxyHealth.list();
    expect(accAll.length).toBe(1);
    expect(pxAll.length).toBe(1);
  });
});

describe("DurableModelLockStore", () => {
  test("get returns undefined for an unknown account/model pair", async () => {
    const p = makePersistence();
    expect(await p.stores.modelLocks.get("nonexistent", "sonnet-4")).toBeUndefined();
  });

  test("round-trips set/get, upserts on conflict, and lists per account", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "ml-acc-1" });
    const store = p.stores.modelLocks;
    const rec: ModelLockRecord = { accountId, modelId: "sonnet-4", retryAt: "2026-08-05T00:05:00.000Z", errorKind: "provider_rate_limited", statusCode: 429, sanitizedMessage: "rate limited", failureCount: 1 };
    await store.set(rec);
    const got = await store.get(accountId, "sonnet-4");
    expect(got?.modelId).toBe("sonnet-4");
    expect(got?.failureCount).toBe(1);

    // Upsert on conflict (same PK) — failure count increments.
    await store.set({ ...rec, failureCount: 3, retryAt: "2026-08-05T00:10:00.000Z" });
    const updated = await store.get(accountId, "sonnet-4");
    expect(updated?.failureCount).toBe(3);
    expect(updated?.retryAt).toBe("2026-08-05T00:10:00.000Z");

    // A second model lock on the same account.
    await store.set({ ...rec, modelId: "haiku-4" });
    const all = await store.listForAccount(accountId);
    expect(all).toHaveLength(2);
  });

  test("delete removes the lock", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "ml-del-1" });
    const store = p.stores.modelLocks;
    await store.set({ accountId, modelId: "sonnet-4", retryAt: "2026-08-05T00:05:00.000Z", errorKind: "provider_rate_limited", statusCode: 429, sanitizedMessage: "x", failureCount: 1 });
    await store.delete(accountId, "sonnet-4");
    expect(await store.get(accountId, "sonnet-4")).toBeUndefined();
  });

  test("listExpired returns only locks whose retry_at has passed", async () => {
    const p = makePersistence();
    const accountId = seedAccount(p, { id: "ml-exp-1" });
    const store = p.stores.modelLocks;
    await store.set({ accountId, modelId: "past-model", retryAt: "2026-08-05T00:01:00.000Z", errorKind: null, statusCode: null, sanitizedMessage: null, failureCount: 1 });
    await store.set({ accountId, modelId: "future-model", retryAt: "2026-08-05T01:00:00.000Z", errorKind: null, statusCode: null, sanitizedMessage: null, failureCount: 1 });
    const expired = await store.listExpired(Date.parse("2026-08-05T00:05:00.000Z"));
    expect(expired.map((r) => r.modelId)).toEqual(["past-model"]);
  });
});

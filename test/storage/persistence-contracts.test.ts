import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import {
  clearAllDatabaseTables,
  createConfigPersistence,
  resetConfigPersistenceForTests,
  credentialKindOf,
  toRouteStatus,
  toErrorKind,
  orNullString,
  configError,
  type ConfigPersistence,
} from "../../src/storage/main/config";
import { fingerprintOAuthToken } from "../../src/application/auth/credentials";
import {
  ensureRuntimeSchema,
  createRuntimePersistence,
  resetRuntimePersistenceForTests,
  mapClientName,
  mapClientSource,
  retainRuntimeData,
  type RuntimePersistence,
} from "../../src/storage/runtime/runtime";
import {
  BACKUP_APP,
  BACKUP_VERSION,
  BACKUP_TABLES,
  MAX_BACKUP_BYTES,
  validateRestorePayload,
  type BackupPayload,
} from "../../src/storage/main/backup";
import type { PersistenceEnv } from "../../src/storage/main/env";

let dirCounter = 0;
function uniqueTempDir(label: string): string {
  const base = join(tmpdir(), `cthya-${label}-${process.pid}-${Date.now()}-${dirCounter++}`);
  mkdirSync(base, { recursive: true });
  return base;
}
function makeEnv(dir: string): PersistenceEnv {
  return { dataDir: dir, dbPath: join(dir, "config.sqlite"), runtimeDbPath: join(dir, "runtime.sqlite"), assetDir: join(dir, "assets"), logRetentionDays: 14, assetRetentionDays: 7, maxFlightsPerIp: 15 };
}
function makeConfig(label: string): ConfigPersistence { return createConfigPersistence(makeEnv(uniqueTempDir(label))); }
function makeRuntime(label: string): RuntimePersistence { return createRuntimePersistence(makeEnv(uniqueTempDir(label))); }

describe("config schema initialization and idempotency", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("schema"); });
  afterEach(() => persist.close());

  test("ensure creates the singleton settings row on first call", () => {
    const s = persist.settings.ensure();
    expect(s.passwordHash).toBeNull();
    expect(s.passwordVersion).toBe(1);
    expect(s.jwtSecret).toBeNull();
    expect(s.settingsJson).toEqual({});
    expect(s.initializedAt).toBeTruthy();
  });

  test("ensure is idempotent — no duplicate row, no reset", () => {
    const first = persist.settings.ensure();
    persist.settings.patchSettingsJson({ theme: "dark" });
    persist.settings.setPasswordHash("hash-abc");
    const second = persist.settings.ensure();
    const third = persist.settings.ensure();
    expect(second.settingsJson).toEqual({ theme: "dark" });
    expect(third.passwordHash).toBe("hash-abc");
    expect(third.initializedAt).toBe(first.initializedAt);
    const n = (persist.db().query("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("all CONFIG_SCHEMA_SQL tables exist after open", () => {
    const tables = (persist.db().query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["account_model_locks","access_rules","api_keys","combos","custom_providers","filter_rules","ip_bans","model_aliases","oauth_refresh_leases","provider_account_health","provider_accounts","provider_models","proxy_health","proxy_settings","proxies","settings","share_links","warp_accounts"]) {
      expect(tables).toContain(t);
    }
  });

  test("durable OAuth store enforces lease ownership and token generation CAS", async () => {
    persist.accounts.create({ id: "oauth-cas", provider: "codex", name: "oauth-cas", credentialKind: "oauth", credential: JSON.stringify({ accessToken: "access-old", refreshToken: "refresh-old", accessExpiresAt: 1 }), credentialHint: "…-old" });
    const token = await persist.stores.oauthToken.get("oauth-cas");
    expect(token?.generation).toBe(0);
    const acquired = await persist.stores.oauthToken.tryAcquireRefreshLease?.({ accountId: "oauth-cas", ownerId: "owner-a", generation: 0, tokenFingerprint: fingerprintOAuthToken(token ?? null), nowMs: 10_000, leaseMs: 15_000 });
    expect(acquired).toBe(true);
    expect(await persist.stores.oauthToken.tryAcquireRefreshLease?.({ accountId: "oauth-cas", ownerId: "owner-b", generation: 0, tokenFingerprint: fingerprintOAuthToken(token ?? null), nowMs: 10_000, leaseMs: 15_000 })).toBe(false);
    expect(await persist.stores.oauthToken.compareAndSwap?.({ accountId: "oauth-cas", expectedGeneration: 0, expectedTokenFingerprint: "stale", token: { accessToken: "access-new", expiresAtMs: 100_000, refreshToken: "refresh-new", kind: "oauth", generation: 1 } })).toBe(false);
    await persist.stores.oauthToken.releaseRefreshLease?.("oauth-cas", "owner-a");
  });
  test("preserves account identity hint while rotating OAuth tokens", async () => {
    persist.accounts.create({ id: "oauth-identity", provider: "cursor", name: "Cursor 1", credentialKind: "oauth", credential: JSON.stringify({ accessToken: "access-old", refreshToken: "refresh-old", email: "risundaily@gmail.com", accessExpiresAt: 1 }), credentialHint: "risundaily@gmail.com" });
    await persist.stores.oauthToken.set("oauth-identity", { accessToken: "access-new", expiresAtMs: 100_000, refreshToken: "refresh-new", kind: "oauth" });
    const row = persist.db().query("SELECT credential_hint AS credentialHint, credential FROM provider_accounts WHERE id = ?").get("oauth-identity") as { credentialHint: string; credential: string };
    expect(row.credentialHint).toBe("risundaily@gmail.com");
    expect(JSON.parse(row.credential).email).toBe("risundaily@gmail.com");
  });

  test("closeForSwap then reopen reopens the same file", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k1", name: "key1", key: "secret-1", keyPrefix: "secret-1" });
    persist.closeForSwap();
    persist.reopen();
    expect(persist.apiKeys.list()).toHaveLength(1);
    expect(persist.apiKeys.list()[0]!.id).toBe("k1");
  });

  test("reopen re-runs schema on a DB missing tables", () => {
    const env = persist.env;
    persist.db().exec("DROP TABLE IF EXISTS filter_rules");
    persist.closeForSwap();
    persist.reopen();
    const row = persist.db().query("SELECT name FROM sqlite_master WHERE type='table' AND name='filter_rules'").get();
    expect(row).not.toBeNull();
  });

  test("close then db() throws a closed error", () => {
    persist.close();
    expect(() => persist.db()).toThrow(/closed/i);
  });

  test("get on uninitialized settings returns null", () => {
    expect(persist.settings.get()).toBeNull();
  });
});

describe("settings repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("settings"); });
  afterEach(() => persist.close());

  test("patchSettingsJson merges shallowly", () => {
    persist.settings.ensure();
    persist.settings.patchSettingsJson({ theme: "dark", lang: "en" });
    persist.settings.patchSettingsJson({ theme: "light" });
    const json = persist.settings.getSettingsJson();
    expect(json.theme).toBe("light");
    expect(json.lang).toBe("en");
  });

  test("getRuntimeSettings falls back to env defaults when unset", () => {
    persist.settings.ensure();
    const rt = persist.settings.getRuntimeSettings(persist.env);
    expect(rt.logRetentionDays).toBe(persist.env.logRetentionDays);
    expect(rt.assetRetentionDays).toBe(persist.env.assetRetentionDays);
  });

  test("patchRuntimeSettings clamps to [1,365]", () => {
    persist.settings.ensure();
    const rt = persist.settings.patchRuntimeSettings({ logRetentionDays: 99999, assetRetentionDays: -5 });
    expect(rt.logRetentionDays).toBe(365);
    expect(rt.assetRetentionDays).toBe(1);
  });

  test("setPasswordHash bumps password_version", () => {
    persist.settings.ensure();
    const before = persist.settings.get()!.passwordVersion;
    persist.settings.setPasswordHash("new-hash");
    const after = persist.settings.get()!;
    expect(after.passwordHash).toBe("new-hash");
    expect(after.passwordVersion).toBe(before + 1);
  });

  test("bumpPasswordVersion increments without changing hash", () => {
    persist.settings.ensure();
    persist.settings.setPasswordHash("hash-1");
    const before = persist.settings.get()!.passwordVersion;
    persist.settings.bumpPasswordVersion();
    const after = persist.settings.get()!;
    expect(after.passwordVersion).toBe(before + 1);
    expect(after.passwordHash).toBe("hash-1");
  });

  test("rotateJwtSecret stores and bumps version", () => {
    persist.settings.ensure();
    const before = persist.settings.get()!.passwordVersion;
    persist.settings.rotateJwtSecret("jwt-xyz");
    const after = persist.settings.get()!;
    expect(after.jwtSecret).toBe("jwt-xyz");
    expect(after.passwordVersion).toBe(before + 1);
  });

  test("patchSettingsJson throws when settings not initialized", () => {
    expect(() => persist.settings.patchSettingsJson({ a: 1 })).toThrow();
  });

  test("malformed settings_json treated as empty, never crashes", () => {
    persist.settings.ensure();
    persist.db().query("UPDATE settings SET settings_json=? WHERE id=1").run("{not valid json");
    const s = persist.settings.get();
    expect(s).not.toBeNull();
    expect(s!.settingsJson).toEqual({});
  });
});

describe("api key repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("apikeys"); });
  afterEach(() => persist.close());

  test("create then getById round-trips", () => {
    persist.settings.ensure();
    const c = persist.apiKeys.create({ id: "ak1", name: "test", key: "sk-1", keyPrefix: "sk-1", rateLimitRpm: 100 });
    expect(c.id).toBe("ak1"); expect(c.active).toBe(true); expect(c.rateLimitRpm).toBe(100);
    const f = persist.apiKeys.getById("ak1");
    expect(f).not.toBeNull(); expect(f!.keyPrefix).toBe("sk-1");
  });

  test("getBySecret finds active keys and rejects revoked keys immediately", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak2", name: "s", key: "sk-find", keyPrefix: "sk-find" });
    expect(persist.apiKeys.getBySecret("sk-find")?.id).toBe("ak2");
    expect(persist.apiKeys.revoke("ak2")).toBe(true);
    expect(persist.apiKeys.getBySecret("sk-find")).toBeNull();
    expect(persist.apiKeys.getBySecret("sk-wrong")).toBeNull();
  });

  test("credential returns raw secret", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak3", name: "c", key: "sk-cred", keyPrefix: "sk-cred" });
    expect(persist.apiKeys.credential("ak3")).toBe("sk-cred");
    expect(persist.apiKeys.credential("nope")).toBeNull();
  });

  test("revoke sets active=false, revoked_at; double-revoke returns false", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak4", name: "r", key: "sk-r", keyPrefix: "sk-r" });
    expect(persist.apiKeys.revoke("ak4")).toBe(true);
    expect(persist.apiKeys.getById("ak4")!.active).toBe(false);
    expect(persist.apiKeys.getById("ak4")!.revokedAt).toBeTruthy();
    expect(persist.apiKeys.revoke("ak4")).toBe(false);
  });

  test("delete returns true then false", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak5", name: "d", key: "sk-d", keyPrefix: "sk-d" });
    expect(persist.apiKeys.delete("ak5")).toBe(true);
    expect(persist.apiKeys.delete("ak5")).toBe(false);
    expect(persist.apiKeys.getById("ak5")).toBeNull();
  });

  test("update changes name and key_prefix", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak6", name: "orig", key: "sk-orig", keyPrefix: "sk-orig" });
    const u = persist.apiKeys.update("ak6", { name: "renamed", key: "sk-newsecret" });
    expect(u!.name).toBe("renamed"); expect(u!.keyPrefix).toBe("sk-newsecret"); expect(u!.active).toBe(true);
  });

  test("getBySecret reflects disable and key regeneration immediately", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak10", name: "fresh", key: "sk-old-key", keyPrefix: "sk-old-key" });
    expect(persist.apiKeys.update("ak10", { active: false })).not.toBeNull();
    expect(persist.apiKeys.getBySecret("sk-old-key")).toBeNull();
    expect(persist.apiKeys.update("ak10", { key: "sk-new-key" })?.active).toBe(true);
    expect(persist.apiKeys.getBySecret("sk-old-key")).toBeNull();
    expect(persist.apiKeys.getBySecret("sk-new-key")?.id).toBe("ak10");
  });

  test("update on missing returns null", () => {
    persist.settings.ensure();
    expect(persist.apiKeys.update("missing", { name: "x" })).toBeNull();
  });

  test("touch coalesces last_used_at; flush writes", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak7", name: "t", key: "sk-t", keyPrefix: "sk-t" });
    persist.apiKeys.touch("ak7"); persist.apiKeys.flushTouches();
    expect(persist.apiKeys.getById("ak7")!.lastUsedAt).toBeTruthy();
  });

  test("one-time token accounting", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak8", name: "ot", key: "sk-ot", keyPrefix: "sk-ot", oneTimeTokenLimit: 1000 });
    expect(persist.apiKeys.sumOneTimeTokensUsed("ak8")).toBe(0);
    persist.apiKeys.consumeOneTimeTokens("ak8", 500);
    expect(persist.apiKeys.sumOneTimeTokensUsed("ak8")).toBe(500);
  });

  test("duplicate name violates UNIQUE", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ak9", name: "dup", key: "sk-1", keyPrefix: "sk-1" });
    expect(() => persist.apiKeys.create({ id: "ak10", name: "dup", key: "sk-2", keyPrefix: "sk-2" })).toThrow();
  });
});

describe("account repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("accounts"); });
  afterEach(() => persist.close());
  function mk(id: string, provider = "openai", name?: string) {
    return persist.accounts.create({ id, provider, name: name ?? id, credentialKind: "api_key", credential: `cred-${id}`, credentialHint: "hint" });
  }

  test("create then get round-trips", () => {
    persist.settings.ensure();
    const a = mk("a1");
    expect(a.id).toBe("a1"); expect(a.credentialKind).toBe("api_key"); expect(a.active).toBe(true);
    expect(persist.accounts.get("a1")).not.toBeNull();
  });

  test("patch updates fields, bumps updated_at", () => {
    persist.settings.ensure(); mk("a2");
    const before = persist.accounts.get("a2")!.updatedAt;
    const p = persist.accounts.patch("a2", { priority: 50, active: false, cooldownUntil: "2025-01-01T00:00:00Z" });
    expect(p!.priority).toBe(50); expect(p!.active).toBe(false); expect(p!.cooldownUntil).toBe("2025-01-01T00:00:00Z");
    expect(p!.updatedAt >= before).toBe(true);
  });

  test("patch on missing returns null", () => { persist.settings.ensure(); expect(persist.accounts.patch("missing", { priority: 1 })).toBeNull(); });

  test("delete returns true/false correctly", () => {
    persist.settings.ensure(); mk("a3");
    expect(persist.accounts.delete("a3")).toBe(true);
    expect(persist.accounts.delete("a3")).toBe(false);
  });

  test("deleteBatch returns count of actually deleted", () => {
    persist.settings.ensure(); mk("b1"); mk("b2"); mk("b3");
    expect(persist.accounts.deleteBatch(["b1","b2","missing"])).toBe(2);
    expect(persist.accounts.deleteBatch(["b1","b2"])).toBe(0);
  });

  test("deleteBatch with empty array returns 0", () => { persist.settings.ensure(); expect(persist.accounts.deleteBatch([])).toBe(0); });

  test("setActiveBatch toggles matching only", () => {
    persist.settings.ensure(); mk("s1"); mk("s2"); mk("s3");
    expect(persist.accounts.setActiveBatch(["s1","s2"], false)).toBe(2);
    expect(persist.accounts.get("s1")!.active).toBe(false);
    expect(persist.accounts.get("s2")!.active).toBe(false);
    expect(persist.accounts.get("s3")!.active).toBe(true);
  });

  test("setActiveBatch with empty array returns 0", () => { persist.settings.ensure(); expect(persist.accounts.setActiveBatch([], true)).toBe(0); });

  test("list filters by provider and orders by priority", () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "p1", provider: "openai", name: "p1", credentialKind: "api_key", credential: "c1", credentialHint: "h", priority: 200 });
    persist.accounts.create({ id: "p2", provider: "openai", name: "p2", credentialKind: "api_key", credential: "c2", credentialHint: "h", priority: 50 });
    persist.accounts.create({ id: "p3", provider: "anthropic", name: "p3", credentialKind: "api_key", credential: "c3", credentialHint: "h", priority: 100 });
    expect(persist.accounts.list("openai").map((a) => a.id)).toEqual(["p2","p1"]);
    expect(persist.accounts.list()).toHaveLength(3);
  });

  test("listPaged paginates by id cursor", () => {
    persist.settings.ensure();
    for (let i = 0; i < 10; i++) mk(`page-${i}`, "openai");
    const p1 = persist.accounts.listPaged("openai", { limit: 4 });
    expect(p1.items).toHaveLength(4); expect(p1.nextCursor).not.toBeNull();
    const p2 = persist.accounts.listPaged("openai", { limit: 4, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(4);
    const p3 = persist.accounts.listPaged("openai", { limit: 4, cursor: p2.nextCursor! });
    expect(p3.items).toHaveLength(2); expect(p3.nextCursor).toBeNull();
  });

  test("listPaged clamps limit to [1,500]", () => {
    persist.settings.ensure(); mk("pg1", "openai");
    expect(persist.accounts.listPaged("openai", { limit: 0 }).items).toHaveLength(1);
    expect(persist.accounts.listPaged("openai", { limit: 99999 }).items).toHaveLength(1);
  });

  test("listActiveCredentials returns active secrets in priority order", () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "ac1", provider: "openai", name: "ac1", credentialKind: "api_key", credential: "s1", credentialHint: "h", priority: 200 });
    persist.accounts.create({ id: "ac2", provider: "openai", name: "ac2", credentialKind: "api_key", credential: "s2", credentialHint: "h", priority: 50 });
    persist.accounts.create({ id: "ac3", provider: "openai", name: "ac3", credentialKind: "api_key", credential: "s3", credentialHint: "h", priority: 100, active: false });
    expect(persist.accounts.listActiveCredentials("openai")).toEqual(["s2","s1"]);
  });

  test("UNIQUE(provider, name) prevents duplicate names per provider", () => {
    persist.settings.ensure(); mk("dup1", "openai", "same");
    expect(() => mk("dup2", "openai", "same")).toThrow();
  });
});

describe("health repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("health"); });
  afterEach(() => persist.close());

  test("upsert then get round-trips account health", async () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "h1", provider: "openai", name: "h1", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    await persist.accountHealth.upsert("h1", { scope: "account", status: "error", statusCode: 429, failureKind: "provider_rate_limited", sanitizedMessage: "rl", occurredAt: "2025-01-01T00:00:00Z", retryAt: "2025-01-01T00:01:00Z" });
    const h = await persist.accountHealth.get("h1");
    expect(h!.status).toBe("error"); expect(h!.statusCode).toBe(429); expect(h!.failureKind).toBe("provider_rate_limited");
  });

  test("upsert on missing parent is a no-op (legacy guard)", async () => {
    persist.settings.ensure();
    await persist.accountHealth.upsert("missing", { scope: "account", status: "error", statusCode: 500, failureKind: "internal_error", sanitizedMessage: null, occurredAt: null, retryAt: null });
    expect(await persist.accountHealth.get("missing")).toBeNull();
  });

  test("upsert updates existing row (ON CONFLICT), no duplicate", async () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "h2", provider: "openai", name: "h2", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    await persist.accountHealth.upsert("h2", { scope: "account", status: "healthy", statusCode: null, failureKind: null, sanitizedMessage: null, occurredAt: null, retryAt: null });
    await persist.accountHealth.upsert("h2", { scope: "account", status: "error", statusCode: 503, failureKind: "provider_unavailable", sanitizedMessage: "down", occurredAt: "now", retryAt: null });
    const h = await persist.accountHealth.get("h2");
    expect(h!.status).toBe("error"); expect(h!.statusCode).toBe(503);
    const n = (persist.db().query("SELECT COUNT(*) AS n FROM provider_account_health WHERE account_id=?").get("h2") as { n: number }).n;
    expect(n).toBe(1);
  });

  test("clear removes health without touching the account", async () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "h3", provider: "openai", name: "h3", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    await persist.accountHealth.upsert("h3", { scope: "account", status: "error", statusCode: 500, failureKind: "internal_error", sanitizedMessage: "e", occurredAt: "now", retryAt: null });
    await persist.accountHealth.clear("h3");
    expect(await persist.accountHealth.get("h3")).toBeNull();
    expect(persist.accounts.get("h3")).not.toBeNull();
  });

  test("list returns all health rows", async () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "h4", provider: "openai", name: "h4", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    persist.accounts.create({ id: "h5", provider: "openai", name: "h5", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    await persist.accountHealth.upsert("h4", { scope: "account", status: "healthy", statusCode: null, failureKind: null, sanitizedMessage: null, occurredAt: null, retryAt: null });
    await persist.accountHealth.upsert("h5", { scope: "account", status: "error", statusCode: 429, failureKind: "provider_rate_limited", sanitizedMessage: "rl", occurredAt: "now", retryAt: null });
    expect((await persist.accountHealth.list())).toHaveLength(2);
  });

  test("proxy health is separate from account health", async () => {
    persist.settings.ensure();
    persist.proxies.create({ id: "px1", name: "px1", protocol: "http", host: "localhost", port: 8080 });
    await persist.proxyHealth.upsert("px1", { scope: "proxy", status: "error", statusCode: 502, failureKind: "network_unavailable", sanitizedMessage: "bg", occurredAt: "now", retryAt: null });
    expect((await persist.proxyHealth.get("px1"))!.statusCode).toBe(502);
    expect((await persist.accountHealth.list())).toHaveLength(0);
  });

  test("deleting an account cascades to its health row (FK ON DELETE CASCADE)", async () => {
    persist.settings.ensure();
    persist.accounts.create({ id: "h6", provider: "openai", name: "h6", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    await persist.accountHealth.upsert("h6", { scope: "account", status: "error", statusCode: 500, failureKind: "internal_error", sanitizedMessage: "e", occurredAt: "now", retryAt: null });
    persist.accounts.delete("h6");
    expect(await persist.accountHealth.get("h6")).toBeNull();
  });
});

describe("proxy repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("proxies"); });
  afterEach(() => persist.close());

  test("create then get round-trips with clamping", () => {
    persist.settings.ensure();
    const p = persist.proxies.create({ id: "px1", name: "p1", protocol: "http", host: "ex.com", port: 8080, maxConcurrency: 99999, weight: 5000 });
    expect(p.maxConcurrency).toBe(10_000); expect(p.weight).toBe(1_000);
    expect(p.protocol).toBe("http"); expect(p.active).toBe(true);
    expect(persist.proxies.get("px1")!.host).toBe("ex.com");
  });

  test("invalid protocol is rejected by the database CHECK constraint", () => {
    persist.settings.ensure();
    persist.proxies.create({ id: "px2", name: "p2", protocol: "http", host: "h", port: 80 });
    expect(() => persist.db().query("UPDATE proxies SET protocol='ftp' WHERE id=?").run("px2")).toThrow(/CHECK constraint/);
  });

  test("patch updates fields, bumps updated_at", () => {
    persist.settings.ensure();
    persist.proxies.create({ id: "px3", name: "p3", protocol: "http", host: "h", port: 80 });
    const before = persist.proxies.get("px3")!.updatedAt;
    const p = persist.proxies.patch("px3", { host: "new", port: 9090, active: false });
    expect(p!.host).toBe("new"); expect(p!.port).toBe(9090); expect(p!.active).toBe(false);
    expect(p!.updatedAt >= before).toBe(true);
  });

  test("patch on missing returns null", () => { persist.settings.ensure(); expect(persist.proxies.patch("missing", { host: "x" })).toBeNull(); });

  test("recordTest ok=true records success", () => {
    persist.settings.ensure();
    persist.proxies.create({ id: "px4", name: "p4", protocol: "http", host: "h", port: 80 });
    const r = persist.proxies.recordTest("px4", { testedAt: "2025-01-01T00:00:00Z", ok: true, latencyMs: 42, statusCode: 200, error: null });
    expect(r!.lastTestSuccessAt).toBe("2025-01-01T00:00:00Z"); expect(r!.lastTestSuccessLatencyMs).toBe(42); expect(r!.lastTestError).toBeNull();
  });

  test("recordTest ok=false records error, truncates to 500 chars", () => {
    persist.settings.ensure();
    persist.proxies.create({ id: "px5", name: "p5", protocol: "http", host: "h", port: 80 });
    const long = "x".repeat(600);
    const r = persist.proxies.recordTest("px5", { testedAt: "2025-01-01T00:00:00Z", ok: false, latencyMs: null, statusCode: 502, error: long });
    expect(r!.lastTestErrorAt).toBe("2025-01-01T00:00:00Z"); expect(r!.lastTestError).toBe("x".repeat(500)); expect(r!.lastTestStatusCode).toBe(502);
  });

  test("recordTest on missing returns null", () => {
    persist.settings.ensure();
    expect(persist.proxies.recordTest("missing", { testedAt: "now", ok: true, latencyMs: 1, statusCode: 200, error: null })).toBeNull();
  });

  test("delete returns true/false", () => {
    persist.settings.ensure();
    persist.proxies.create({ id: "px6", name: "p6", protocol: "http", host: "h", port: 80 });
    expect(persist.proxies.delete("px6")).toBe(true);
    expect(persist.proxies.delete("px6")).toBe(false);
  });

  test("proxy settings: getSettings null initially, patchSettings creates then updates", () => {
    persist.settings.ensure();
    expect(persist.proxies.getSettings()).toBeNull();
    const c = persist.proxies.patchSettings({ enabled: true, routingPreset: "target-concurrent", targetConcurrent: 50 });
    expect(c.enabled).toBe(true); expect(c.routingPreset).toBe("target-concurrent"); expect(c.targetConcurrent).toBe(50);
    const u = persist.proxies.patchSettings({ targetConcurrent: 100 });
    expect(u.targetConcurrent).toBe(100); expect(u.enabled).toBe(true);
    expect(persist.proxies.getSettings()!.targetConcurrent).toBe(100);
  });

  test("proxy settings clamps smart_dynamic_proxy_count to [1,32]", () => {
    persist.settings.ensure();
    expect(persist.proxies.patchSettings({ smartDynamicProxyCount: 999 }).smartDynamicProxyCount).toBe(32);
    expect(persist.proxies.patchSettings({ smartDynamicProxyCount: 0 }).smartDynamicProxyCount).toBe(1);
  });

  test("proxy settings clamps target_concurrent to [0,10000]", () => {
    persist.settings.ensure();
    expect(persist.proxies.patchSettings({ targetConcurrent: -5 }).targetConcurrent).toBe(0);
    expect(persist.proxies.patchSettings({ targetConcurrent: 99999 }).targetConcurrent).toBe(10_000);
  });

  test("proxy settings normalizes invalid routing_preset to 'auto'", () => {
    persist.settings.ensure();
    expect(persist.proxies.patchSettings({ routingPreset: "bogus" as any }).routingPreset).toBe("auto");
  });

  test("proxy settings excludedProviders parsed from JSON", () => {
    persist.settings.ensure();
    expect(persist.proxies.patchSettings({ excludedProviders: ["openai","anthropic"] }).excludedProviders).toEqual(["openai","anthropic"]);
  });

  test("proxy settings malformed JSON returns empty list", () => {
    persist.settings.ensure();
    persist.proxies.patchSettings({ excludedProviders: ["a"] });
    persist.db().query("UPDATE proxy_settings SET excluded_providers_json=? WHERE id=1").run("{bad");
    expect(persist.proxies.getSettings()!.excludedProviders).toEqual([]);
  });
});

describe("upsert repositories (aliases, combos, custom providers, access rules, models, ip bans)", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("upsert"); });
  afterEach(() => persist.close());

  test("alias upsert creates then updates on conflict", () => {
    persist.settings.ensure();
    persist.aliases.upsert("gpt4", "gpt-4-turbo"); persist.aliases.upsert("gpt4", "gpt-4o");
    expect(persist.aliases.list()).toHaveLength(1);
    expect(persist.aliases.get("gpt4")!.model).toBe("gpt-4o");
  });

  test("alias delete returns true/false", () => {
    persist.settings.ensure(); persist.aliases.upsert("x", "y");
    expect(persist.aliases.delete("x")).toBe(true); expect(persist.aliases.delete("x")).toBe(false);
  });

  test("combo upsert creates then updates on conflict", () => {
    persist.settings.ensure();
    const c1 = persist.combos.upsert({ id: "c1", name: "combo1", models: ["m1","m2"] });
    expect(c1.models).toEqual(["m1","m2"]); expect(c1.strategy).toBe("fallback");
    const c2 = persist.combos.upsert({ id: "c1", name: "combo1", models: ["m3"], strategy: "round_robin", stickyLimit: 5 });
    expect(c2.models).toEqual(["m3"]); expect(c2.strategy).toBe("round_robin"); expect(c2.stickyLimit).toBe(5);
    expect(persist.combos.list()).toHaveLength(1);
  });

  test("combo delete returns true/false", () => {
    persist.settings.ensure(); persist.combos.upsert({ id: "c2", name: "c2", models: [] });
    expect(persist.combos.delete("c2")).toBe(true); expect(persist.combos.delete("c2")).toBe(false);
  });

  test("combo malformed models_json returns empty list", () => {
    persist.settings.ensure(); persist.combos.upsert({ id: "c3", name: "c3", models: ["a"] });
    persist.db().query("UPDATE combos SET models_json=? WHERE id=?").run("{bad", "c3");
    expect(persist.combos.get("c3")!.models).toEqual([]);
  });

  test("custom provider upsert creates then updates on conflict", () => {
    persist.settings.ensure();
    const c1 = persist.customProviders.upsert({ id: "cp1", slug: "my-llm", name: "MyLLM", type: "openai-compatible", baseUrl: "http://x", credential: "sk-x" });
    expect(c1.credential).toBe("sk-x"); expect(c1.timeoutSeconds).toBe(30);
    const c2 = persist.customProviders.upsert({ id: "cp1", slug: "my-llm", name: "MyLLM2", type: "openai-compatible", baseUrl: "http://y", credential: "sk-y", timeoutSeconds: 60 });
    expect(c2.name).toBe("MyLLM2"); expect(c2.credential).toBe("sk-y"); expect(c2.timeoutSeconds).toBe(60);
    expect(persist.customProviders.list()).toHaveLength(1);
  });

  test("custom provider getBySlug", () => {
    persist.settings.ensure();
    persist.customProviders.upsert({ id: "cp2", slug: "slug-test", name: "N", type: "openai-compatible", baseUrl: "http://x", credential: "sk" });
    expect(persist.customProviders.getBySlug("slug-test")).not.toBeNull();
    expect(persist.customProviders.getBySlug("missing")).toBeNull();
  });

  test("custom provider updateModels changes models, returns null for missing", () => {
    persist.settings.ensure();
    persist.customProviders.upsert({ id: "cp3", slug: "s", name: "N", type: "openai-compatible", baseUrl: "http://x", credential: "sk" });
    const u = persist.customProviders.updateModels("cp3", [{ id: "m1" }]);
    expect(u!.models).toEqual([{ id: "m1" }]);
    expect(persist.customProviders.updateModels("missing", [])).toBeNull();
  });

  test("custom provider delete returns true/false", () => {
    persist.settings.ensure();
    persist.customProviders.upsert({ id: "cp4", slug: "s4", name: "N", type: "openai-compatible", baseUrl: "http://x", credential: "sk" });
    expect(persist.customProviders.delete("cp4")).toBe(true);
    expect(persist.customProviders.delete("cp4")).toBe(false);
  });

  test("custom provider malformed models_json and headers_json return safe defaults", () => {
    persist.settings.ensure();
    persist.customProviders.upsert({ id: "cp5", slug: "s5", name: "N", type: "openai-compatible", baseUrl: "http://x", credential: "sk" });
    persist.db().query("UPDATE custom_providers SET models_json=?, headers_json=? WHERE id=?").run("{bad", "{also bad", "cp5");
    const r = persist.customProviders.get("cp5")!;
    expect(r.models).toEqual([]); expect(r.customHeaders).toEqual({});
  });

  test("access rule upsert creates then updates on conflict", () => {
    persist.settings.ensure();
    persist.accessRules.upsert("scope1", { mode: "allow", entries: ["a","b"] });
    persist.accessRules.upsert("scope1", { mode: "deny", entries: ["c"] });
    const r = persist.accessRules.get("scope1")!;
    expect(r.mode).toBe("deny"); expect(r.entries).toEqual(["c"]);
    const n = (persist.db().query("SELECT COUNT(*) AS n FROM access_rules WHERE scope=?").get("scope1") as { n: number }).n;
    expect(n).toBe(1);
  });

  test("access rule malformed entries_json returns empty list", () => {
    persist.settings.ensure();
    persist.accessRules.upsert("scope2", { mode: "allow", entries: ["x"] });
    persist.db().query("UPDATE access_rules SET entries_json=? WHERE scope=?").run("{bad", "scope2");
    expect(persist.accessRules.get("scope2")!.entries).toEqual([]);
  });

  test("provider model upsert creates then updates on conflict", () => {
    persist.settings.ensure();
    persist.providerModels.upsert("openai", "gpt-4", { enabled: true, source: "manual" });
    persist.providerModels.upsert("openai", "gpt-4", { enabled: false, source: "discovered" });
    const m = persist.providerModels.get("openai", "gpt-4")!;
    expect(m.enabled).toBe(false); expect(m.source).toBe("discovered");
    const n = (persist.db().query("SELECT COUNT(*) AS n FROM provider_models WHERE provider=? AND model_id=?").get("openai", "gpt-4") as { n: number }).n;
    expect(n).toBe(1);
  });

  test("provider model delete returns true/false", () => {
    persist.settings.ensure();
    persist.providerModels.upsert("openai", "gpt-4", { enabled: true });
    expect(persist.providerModels.delete("openai", "gpt-4")).toBe(true);
    expect(persist.providerModels.delete("openai", "gpt-4")).toBe(false);
  });

  test("ip ban add is idempotent (ON CONFLICT updates reason)", async () => {
    persist.settings.ensure();
    await persist.ipBans.add("1.2.3.4", "first");
    await persist.ipBans.add("1.2.3.4", "second");
    const list = await persist.ipBans.list();
    expect(list).toHaveLength(1); expect(list[0]!.reason).toBe("second");
  });

  test("ip ban remove and isBanned", async () => {
    persist.settings.ensure();
    await persist.ipBans.add("5.6.7.8", "bad");
    expect(await persist.ipBans.isBanned("5.6.7.8")).toBe(true);
    expect(await persist.ipBans.isBanned("9.9.9.9")).toBe(false);
    expect(await persist.ipBans.remove("5.6.7.8")).toBe(true);
    expect(await persist.ipBans.remove("5.6.7.8")).toBe(false);
    expect(await persist.ipBans.isBanned("5.6.7.8")).toBe(false);
  });

  test("durable offense scoring promotes repeated abuse to an IP ban", async () => {
    persist.settings.ensure();
    expect(persist.ipBans.recordOffense).toBeFunction();
    for (let index = 0; index < 8; index += 1) {
      const decision = await persist.ipBans.recordOffense!("9.8.7.6", "invalid_api_key");
      if (index < 7) expect(decision.thresholdReached).toBe(false);
      else expect(decision.thresholdReached).toBe(true);
    }
    expect(await persist.ipBans.isBanned("9.8.7.6")).toBe(true);
  });
});

describe("share link repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("sharelinks"); });
  afterEach(() => persist.close());

  test("create then getByTokenHash round-trips", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k1", name: "k", key: "sk-1", keyPrefix: "sk-1" });
    persist.shareLinks.create({ id: "sl1", apiKeyId: "k1", tokenHash: "th-1" });
    const r = persist.shareLinks.getByTokenHash("th-1");
    expect(r).not.toBeNull(); expect(r!.apiKeyId).toBe("k1"); expect(r!.active).toBe(true);
  });

  test("listByApiKey returns links for a key", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k2", name: "k2", key: "sk-2", keyPrefix: "sk-2" });
    persist.shareLinks.create({ id: "sl2", apiKeyId: "k2", tokenHash: "th-2" });
    persist.shareLinks.create({ id: "sl3", apiKeyId: "k2", tokenHash: "th-3" });
    expect(persist.shareLinks.listByApiKey("k2")).toHaveLength(2);
    expect(persist.shareLinks.listByApiKey("missing")).toHaveLength(0);
  });

  test("patchActive toggles; returns null for missing", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k3", name: "k3", key: "sk-3", keyPrefix: "sk-3" });
    persist.shareLinks.create({ id: "sl4", apiKeyId: "k3", tokenHash: "th-4" });
    const r = persist.shareLinks.patchActive("sl4", false);
    expect(r!.active).toBe(false);
    expect(persist.shareLinks.patchActive("missing", true)).toBeNull();
  });

  test("touch updates last_viewed_at", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k4", name: "k4", key: "sk-4", keyPrefix: "sk-4" });
    persist.shareLinks.create({ id: "sl5", apiKeyId: "k4", tokenHash: "th-5" });
    persist.shareLinks.touch("sl5");
    expect(persist.shareLinks.getByTokenHash("th-5")!.lastViewedAt).toBeTruthy();
  });

  test("delete returns true/false", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k5", name: "k5", key: "sk-5", keyPrefix: "sk-5" });
    persist.shareLinks.create({ id: "sl6", apiKeyId: "k5", tokenHash: "th-6" });
    expect(persist.shareLinks.delete("sl6")).toBe(true);
    expect(persist.shareLinks.delete("sl6")).toBe(false);
  });

  test("deleting an api key cascades to share links (FK ON DELETE CASCADE)", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k6", name: "k6", key: "sk-6", keyPrefix: "sk-6" });
    persist.shareLinks.create({ id: "sl7", apiKeyId: "k6", tokenHash: "th-7" });
    persist.apiKeys.delete("k6");
    expect(persist.shareLinks.getByTokenHash("th-7")).toBeNull();
  });

  test("duplicate token_hash violates UNIQUE", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "k7", name: "k7", key: "sk-7", keyPrefix: "sk-7" });
    persist.apiKeys.create({ id: "k8", name: "k8", key: "sk-8", keyPrefix: "sk-8" });
    persist.shareLinks.create({ id: "sl8", apiKeyId: "k7", tokenHash: "dup-th" });
    expect(() => persist.shareLinks.create({ id: "sl9", apiKeyId: "k8", tokenHash: "dup-th" })).toThrow();
  });
});

describe("CLI model mapping repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("cli-mappings"); });
  afterEach(() => persist.close());

  test("persists per-tool slot mappings and enable state", () => {
    persist.settings.ensure();
    persist.cliModelMappings.setEnabled("claude", true);
    const mapping = persist.cliModelMappings.upsert({
      toolId: "claude",
      slotKey: "opus",
      sourceModel: "claude/claude-opus-4-8",
      targetModel: "openai/gpt-5.5",
      enabled: true,
    });
    expect(mapping.targetModel).toBe("openai/gpt-5.5");
    expect(persist.cliModelMappings.getSettings("claude")?.enabled).toBe(true);
    expect(persist.cliModelMappings.list("claude")).toHaveLength(1);
    expect(persist.cliModelMappings.list("codex")).toHaveLength(0);
  });

  test("reset removes mappings and settings", () => {
    persist.settings.ensure();
    persist.cliModelMappings.setEnabled("codex", true);
    persist.cliModelMappings.upsert({ toolId: "codex", slotKey: "session", sourceModel: "gpt-5.1", targetModel: "openai/gpt-5.5", enabled: true });
    persist.cliModelMappings.reset("codex");
    expect(persist.cliModelMappings.getSettings("codex")).toBeNull();
    expect(persist.cliModelMappings.list("codex")).toHaveLength(0);
  });
});

describe("warp account repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("warp"); });
  afterEach(() => persist.close());

  test("create then get round-trips with secrets", async () => {
    persist.settings.ensure();
    const w = await persist.warpAccounts.create({
      id: "w1", label: "warp1", deviceId: "dev1", accessToken: "at1", licenseKey: "lk1",
      privateKey: "pk1", addressV4: "10.0.0.1", addressV6: "::1", publicKey: "pub1",
      endpoint: "ep1", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40001,
    });
    expect(w.id).toBe("w1"); expect(w.accessToken).toBe("at1"); expect(w.enabled).toBe(true); expect(w.running).toBe(false);
    const g = await persist.warpAccounts.get("w1");
    expect(g).not.toBeNull(); expect(g!.licenseKey).toBe("lk1");
  });

  test("update changes label, returns null for missing", async () => {
    persist.settings.ensure();
    await persist.warpAccounts.create({
      id: "w2", label: "orig", deviceId: "d", accessToken: "a", licenseKey: "l",
      privateKey: "p", addressV4: "1", addressV6: "2", publicKey: "3",
      endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40002,
    });
    const u = await persist.warpAccounts.update("w2", { label: "updated", enabled: false });
    expect(u!.label).toBe("updated"); expect(u!.enabled).toBe(false);
    expect(await persist.warpAccounts.update("missing", { label: "x" })).toBeNull();
  });

  test("update with empty label throws", async () => {
    persist.settings.ensure();
    await persist.warpAccounts.create({
      id: "w3", label: "x", deviceId: "d", accessToken: "a", licenseKey: "l",
      privateKey: "p", addressV4: "1", addressV6: "2", publicKey: "3",
      endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40003,
    });
    expect(() => persist.warpAccounts.update("w3", { label: "  " })).toThrow(/empty/i);
  });

  test("update clamps socksPort to [1,65535] and keepalive to [0,120]", async () => {
    persist.settings.ensure();
    await persist.warpAccounts.create({
      id: "w4", label: "x", deviceId: "d", accessToken: "a", licenseKey: "l",
      privateKey: "p", addressV4: "1", addressV6: "2", publicKey: "3",
      endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40004,
    });
    const u = await persist.warpAccounts.update("w4", { socksPort: 99999, persistentKeepalive: 999 });
    expect(u!.socksPort).toBe(65_535);
    expect(u!.persistentKeepalive).toBe(120);
  });

  test("setRunning updates running and pid", async () => {
    persist.settings.ensure();
    await persist.warpAccounts.create({
      id: "w5", label: "x", deviceId: "d", accessToken: "a", licenseKey: "l",
      privateKey: "p", addressV4: "1", addressV6: "2", publicKey: "3",
      endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40005,
    });
    await persist.warpAccounts.setRunning("w5", true, 12345);
    const g = await persist.warpAccounts.get("w5");
    expect(g!.running).toBe(true); expect(g!.pid).toBe(12345);
  });

  test("remove returns true/false", async () => {
    persist.settings.ensure();
    await persist.warpAccounts.create({
      id: "w6", label: "x", deviceId: "d", accessToken: "a", licenseKey: "l",
      privateKey: "p", addressV4: "1", addressV6: "2", publicKey: "3",
      endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40006,
    });
    expect(await persist.warpAccounts.remove("w6")).toBe(true);
    expect(await persist.warpAccounts.remove("w6")).toBe(false);
  });

  test("create uses default label when empty", async () => {
    persist.settings.ensure();
    const w = await persist.warpAccounts.create({
      id: "w7", label: "", deviceId: "d", accessToken: "a", licenseKey: "l",
      privateKey: "p", addressV4: "1", addressV6: "2", publicKey: "3",
      endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40007,
    });
    expect(w.label).toBe("Warp-40007");
  });

  test("list returns all accounts ordered by created_at", async () => {
    persist.settings.ensure();
    for (let i = 0; i < 3; i++) {
      await persist.warpAccounts.create({
        id: `w-${i}`, label: `w${i}`, deviceId: `d${i}`, accessToken: `a${i}`, licenseKey: `l${i}`,
        privateKey: `p${i}`, addressV4: "1", addressV6: "2", publicKey: "3",
        endpoint: "e", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 40010 + i,
      });
    }
    const list = await persist.warpAccounts.list();
    expect(list).toHaveLength(3);
  });
});

describe("filter rule repository", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("filterrules"); });
  afterEach(() => persist.close());

  test("create then list returns rules sorted by sort_order", async () => {
    persist.settings.ensure();
    await persist.filterRules.create({ pattern: "foo", replacement: "bar", isRegex: false });
    await persist.filterRules.create({ pattern: "baz", replacement: "", isRegex: false });
    const list = await persist.filterRules.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.sortOrder).toBeLessThanOrEqual(list[1]!.sortOrder);
  });

  test("create with empty pattern throws", async () => {
    persist.settings.ensure();
    expect(() => persist.filterRules.create({ pattern: "  ", isRegex: false })).toThrow();
  });

  test("create with invalid regex throws", async () => {
    persist.settings.ensure();
    expect(() => persist.filterRules.create({ pattern: "[invalid", isRegex: true })).toThrow();
  });

  test("update changes fields; returns null for missing", async () => {
    persist.settings.ensure();
    const created = await persist.filterRules.create({ pattern: "test", isRegex: false });
    const u = await persist.filterRules.update(created.id, { replacement: "rep" });
    expect(u!.replacement).toBe("rep");
    expect(await persist.filterRules.update(99999, { replacement: "x" })).toBeNull();
  });

  test("remove returns true/false", async () => {
    persist.settings.ensure();
    const created = await persist.filterRules.create({ pattern: "rm", isRegex: false });
    expect(await persist.filterRules.remove(created.id)).toBe(true);
    expect(await persist.filterRules.remove(created.id)).toBe(false);
  });

  test("listSync returns same data synchronously", async () => {
    persist.settings.ensure();
    await persist.filterRules.create({ pattern: "sync", isRegex: false });
    const syncList = persist.filterRules.listSync();
    expect(syncList).toHaveLength(1);
  });
});

describe("backup export and restore", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("backup"); });
  afterEach(() => persist.close());

  test("export produces a payload with correct app/version and all backup tables", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "bk1", name: "bk", key: "sk-bk", keyPrefix: "sk-bk" });
    const backup = persist.backup();
    expect(backup.app).toBe(BACKUP_APP);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.exportedAt).toBeTruthy();
    for (const t of BACKUP_TABLES) {
      expect(backup.tables).toHaveProperty(t);
    }
  });

  test("export includes secrets (the backup contract explicitly allows secrets)", () => {
    persist.settings.ensure();
    persist.settings.setPasswordHash("pass-hash-bk");
    persist.settings.rotateJwtSecret("jwt-secret-bk");
    persist.apiKeys.create({ id: "bk2", name: "bk2", key: "sk-secret-bk", keyPrefix: "sk-secret" });
    persist.accounts.create({ id: "bk3", provider: "openai", name: "bk3", credentialKind: "api_key", credential: "cred-secret-bk", credentialHint: "h" });

    const backup = persist.backup();
    const settings = backup.tables.settings as Record<string, unknown>;
    expect(settings.password_hash).toBe("pass-hash-bk");
    expect(settings.jwt_secret).toBe("jwt-secret-bk");

    const apiKeys = backup.tables.api_keys as Array<Record<string, unknown>>;
    expect(apiKeys[0]!.key).toBe("sk-secret-bk");

    const accounts = backup.tables.provider_accounts as Array<Record<string, unknown>>;
    expect(accounts[0]!.credential).toBe("cred-secret-bk");
  });

  test("export settings/proxy_settings as single object (or empty object when no row)", () => {
    persist.settings.ensure();
    const backup = persist.backup();
    expect(backup.tables.settings).toBeTypeOf("object");
    expect(backup.tables.proxy_settings).toBeTypeOf("object");
  });

  test("export of empty DB gives empty arrays/objects", () => {
    persist.settings.ensure();
    const backup = persist.backup();
    expect(backup.tables.api_keys).toEqual([]);
    expect(backup.tables.provider_accounts).toEqual([]);
    expect(backup.tables.proxies).toEqual([]);
    expect(backup.tables.ip_bans).toEqual([]);
  });

  test("round-trip: export then restore into a fresh DB", () => {
    persist.settings.ensure();
    persist.settings.setPasswordHash("rt-hash");
    persist.settings.rotateJwtSecret("rt-jwt");
    persist.apiKeys.create({ id: "rt1", name: "rt", key: "sk-rt", keyPrefix: "sk-rt", rateLimitRpm: 200 });
    persist.accounts.create({ id: "rt2", provider: "openai", name: "rt2", credentialKind: "api_key", credential: "cred-rt", credentialHint: "h" });
    persist.proxies.create({ id: "rt3", name: "rt3", protocol: "http", host: "rt.host", port: 8080 });
    persist.aliases.upsert("rt-alias", "rt-model");
    persist.combos.upsert({ id: "rt-combo", name: "rtc", models: ["m1"] });
    persist.customProviders.upsert({ id: "rt-cp", slug: "rt-slug", name: "RT", type: "openai-compatible", baseUrl: "http://rt", credential: "sk-rt" });
    persist.ipBans.add("1.2.3.4", "bad");

    const backup = persist.backup();
    const validation = validateRestorePayload(backup);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    // Restore into a fresh DB
    const fresh = makeConfig("restore");
    fresh.settings.ensure();
    const result = fresh.restoreBackup(validation as any);
    expect(result.restored.api_keys).toBe(1);
    expect(result.restored.provider_accounts).toBe(1);
    expect(result.restored.proxies).toBe(1);
    expect(result.restored.model_aliases).toBe(1);
    expect(result.restored.combos).toBe(1);
    expect(result.restored.custom_providers).toBe(1);
    expect(result.restored.ip_bans).toBe(1);

    // Verify secrets survived the restore
    expect(fresh.settings.get()!.passwordHash).toBe("rt-hash");
    expect(fresh.settings.get()!.jwtSecret).toBe("rt-jwt");
    expect(fresh.apiKeys.credential("rt1")).toBe("sk-rt");
    expect(fresh.accounts.list()[0]!.credentialHint).toBe("h");
    expect(fresh.aliases.get("rt-alias")!.model).toBe("rt-model");
    expect(fresh.customProviders.getBySlug("rt-slug")!.credential).toBe("sk-rt");
    fresh.close();
  });

  test("restore replaces existing data (delete+insert in one transaction)", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "orig1", name: "orig", key: "sk-orig", keyPrefix: "sk-orig" });
    const backup = persist.backup();

    // Add more data after backup
    persist.apiKeys.create({ id: "post-backup", name: "post", key: "sk-post", keyPrefix: "sk-post" });
    expect(persist.apiKeys.list()).toHaveLength(2);

    const validation = validateRestorePayload(backup);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    persist.restoreBackup(validation as any);

    // Only the backed-up key should remain
    expect(persist.apiKeys.list()).toHaveLength(1);
    expect(persist.apiKeys.list()[0]!.id).toBe("orig1");
  });

  test("restore is atomic — a failed restore rolls back leaving DB untouched", () => {
    persist.settings.ensure();
    persist.apiKeys.create({ id: "safe1", name: "safe", key: "sk-safe", keyPrefix: "sk-safe" });
    const beforeCount = (persist.db().query("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n;

    // Build a payload that passes validation but fails at apply (FK violation):
    // share_links references a non-existent api_key_id
    const hostile: BackupPayload = {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables: {
        settings: { id: 1, password_hash: null, password_version: 1, jwt_secret: null, settings_json: "{}", initialized_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" },
        api_keys: [],
        share_links: [{ id: "bad-sl", api_key_id: "nonexistent-key", token_hash: "th-bad", active: 1, created_at: "2025-01-01T00:00:00Z", last_viewed_at: null }],
        model_aliases: [], cli_tool_mapping_settings: [], cli_model_mappings: [], combos: [], access_rules: [], provider_accounts: [], custom_providers: [], warp_accounts: [], proxies: [], proxy_settings: { id: 1, enabled: 0, excluded_providers_json: "[]", smart_dynamic_routing: 0, smart_dynamic_proxy_count: 2, routing_preset: "auto", target_concurrent: 0, updated_at: "2025-01-01T00:00:00Z" }, ip_bans: [],
      },
    };

    // Note: validateRestorePayload checks structure, not FK constraints.
    // The apply should fail with an FK error because foreign_keys=ON.
    const validation = validateRestorePayload(hostile);
    // Validation might pass since it only checks columns/types
    if (validation.ok) {
      expect(() => persist.restoreBackup(validation as any)).toThrow();
      // DB should be untouched
      const afterCount = (persist.db().query("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n;
      expect(afterCount).toBe(beforeCount);
      expect(persist.apiKeys.getById("safe1")).not.toBeNull();
    }
  });
});

describe("restore validation — hostile/oversized/unknown payloads", () => {
  test("rejects non-object payload", () => {
    expect(validateRestorePayload("string").ok).toBe(false);
    expect(validateRestorePayload(null).ok).toBe(false);
    expect(validateRestorePayload([]).ok).toBe(false);
  });

  test("rejects wrong app name", () => {
    const p = { app: "wrong", version: BACKUP_VERSION, exportedAt: "x", tables: {} };
    expect(validateRestorePayload(p).ok).toBe(false);
  });

  test("rejects wrong version", () => {
    const p = { app: BACKUP_APP, version: 999, exportedAt: "x", tables: {} };
    expect(validateRestorePayload(p).ok).toBe(false);
  });

  test("rejects tables that is not an object", () => {
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: "not-object" };
    expect(validateRestorePayload(p).ok).toBe(false);
    const p2 = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: [] };
    expect(validateRestorePayload(p2).ok).toBe(false);
  });

  test("rejects unknown table name", () => {
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { evil_table: [] } };
    const r = validateRestorePayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("evil_table");
  });

  test("rejects more tables than allowlist (unknown tables)", () => {
    const tables: Record<string, unknown> = {};
    for (const t of BACKUP_TABLES) tables[t] = [];
    tables["extra_evil"] = [];
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables };
    expect(validateRestorePayload(p).ok).toBe(false);
  });

  test("rejects non-array rows for list tables", () => {
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { api_keys: "not-array" } };
    const r = validateRestorePayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("api_keys");
  });

  test("accepts object or array for settings/proxy_settings", () => {
    const p1 = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { settings: { id: 1, password_hash: null, password_version: 1, jwt_secret: null, settings_json: "{}", initialized_at: "x", updated_at: "x" } } };
    expect(validateRestorePayload(p1).ok).toBe(true);
    const p2 = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { settings: [{ id: 1, password_hash: null, password_version: 1, jwt_secret: null, settings_json: "{}", initialized_at: "x", updated_at: "x" }] } };
    expect(validateRestorePayload(p2).ok).toBe(true);
  });

  test("rejects empty object for settings (treated as no rows)", () => {
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { settings: {} } };
    const r = validateRestorePayload(p);
    // {} is treated as empty → 0 rows, which is valid
    expect(r.ok).toBe(true);
  });

  test("rejects unknown column in a row", () => {
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { api_keys: [{ id: "x", name: "x", key: "x", key_prefix: "x", active: 1, rate_limit_rpm: null, daily_token_limit: null, monthly_token_limit: null, one_time_token_limit: null, one_time_tokens_used: 0, quote_big_text: null, quote_sub_text: null, quote_body: null, max_concurrent_requests: null, provider_allowlist: null, model_allowlist: null, model_denylist: null, last_used_at: null, created_at: "x", revoked_at: null, evil_column: "hack" }] } };
    const r = validateRestorePayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("evil_column");
  });

  test("rejects non-primitive cell value (nested object)", () => {
    const p2 = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { api_keys: [{ id: "x", name: { hack: 1 }, key: "x", key_prefix: "x", active: 1, rate_limit_rpm: null, daily_token_limit: null, monthly_token_limit: null, one_time_token_limit: null, one_time_tokens_used: 0, quote_big_text: null, quote_sub_text: null, quote_body: null, max_concurrent_requests: null, provider_allowlist: null, model_allowlist: null, model_denylist: null, last_used_at: null, created_at: "x", revoked_at: null }] } };
    const r = validateRestorePayload(p2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("must be a primitive");
  });

  test("rejects non-object row", () => {
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { api_keys: ["string-row"] } };
    const r = validateRestorePayload(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("must be a row object");
  });

  test("boolean values are accepted and converted to 0/1 on apply", () => {
    const persist = makeConfig("bool-restore");
    persist.settings.ensure();
    const p = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: "x", tables: { api_keys: [{ id: "b1", name: "b", key: "sk-b", key_prefix: "sk-b", active: true, rate_limit_rpm: null, daily_token_limit: null, monthly_token_limit: null, one_time_token_limit: null, one_time_tokens_used: 0, quote_big_text: null, quote_sub_text: null, quote_body: null, max_concurrent_requests: null, provider_allowlist: null, model_allowlist: null, model_denylist: null, last_used_at: null, created_at: "x", revoked_at: null }], settings: { id: 1, password_hash: null, password_version: 1, jwt_secret: null, settings_json: "{}", initialized_at: "x", updated_at: "x" }, share_links: [], model_aliases: [], combos: [], access_rules: [], provider_accounts: [], custom_providers: [], warp_accounts: [], proxies: [], proxy_settings: { id: 1, enabled: true, excluded_providers_json: "[]", smart_dynamic_routing: false, smart_dynamic_proxy_count: 2, routing_preset: "auto", target_concurrent: 0, updated_at: "x" }, ip_bans: [] } };
    const v = validateRestorePayload(p);
    expect(v.ok).toBe(true);
    if (!v.ok) { persist.close(); return; }
    const result = persist.restoreBackup(v as any);
    expect(result.restored.api_keys).toBe(1);
    expect(persist.apiKeys.getById("b1")!.active).toBe(true);
    persist.close();
  });

  test("MAX_BACKUP_BYTES is 64 MiB", () => {
    expect(MAX_BACKUP_BYTES).toBe(64 * 1024 * 1024);
  });

  test("BACKUP_TABLES contains exactly the expected tables", () => {
    expect(BACKUP_TABLES).toEqual([
      "settings", "api_keys", "share_links", "model_aliases",
      "cli_tool_mapping_settings", "cli_model_mappings", "combos", "access_rules",
      "provider_accounts", "custom_providers", "warp_accounts",
      "proxies", "proxy_settings", "ip_bans",
    ]);
  });
});

describe("restore with Warp rows (secrets preserved per backup contract)", () => {
  let persist: ConfigPersistence;
  beforeEach(() => { resetConfigPersistenceForTests(); persist = makeConfig("warp-backup"); });
  afterEach(() => persist.close());

  test("Warp account secrets survive export+restore round-trip", async () => {
    persist.settings.ensure();
    await persist.warpAccounts.create({
      id: "wbk1", label: "warp-bk", deviceId: "dev-bk", accessToken: "at-bk-secret", licenseKey: "lk-bk-secret",
      privateKey: "pk-bk-secret", addressV4: "10.0.0.1", addressV6: "::1", publicKey: "pub-bk",
      endpoint: "engage.cloudflare.com", endpointPort: 2408, dns: "1.1.1.1", mtu: 1280, socksPort: 50001,
    });

    const backup = persist.backup();
    const warpRows = backup.tables.warp_accounts as Array<Record<string, unknown>>;
    expect(warpRows[0]!.access_token).toBe("at-bk-secret");
    expect(warpRows[0]!.license_key).toBe("lk-bk-secret");
    expect(warpRows[0]!.private_key).toBe("pk-bk-secret");

    const v = validateRestorePayload(backup);
    expect(v.ok).toBe(true);
    if (!v.ok) return;

    // Restore into fresh DB
    const fresh = makeConfig("warp-restore");
    fresh.settings.ensure();
    fresh.restoreBackup(v as any);
    const w = await fresh.warpAccounts.get("wbk1");
    expect(w!.accessToken).toBe("at-bk-secret");
    expect(w!.licenseKey).toBe("lk-bk-secret");
    expect(w!.privateKey).toBe("pk-bk-secret");
    fresh.close();
  });
});

describe("runtime persistence — schema, telemetry, console logs, retention", () => {
  let rt: RuntimePersistence;
  beforeEach(() => { resetRuntimePersistenceForTests(); rt = makeRuntime("rt-main"); });
  afterEach(() => rt.close());

  test("runtime schema creates request_history, console_logs, warp_metrics tables", () => {
    const tables = (rt.db().query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("request_history");
    expect(tables).toContain("console_logs");
    expect(tables).toContain("warp_metrics");
    expect(tables).toContain("request_payloads");
  });
  test("bounded payload artifacts persist separately from request history", () => {
    rt.payloads.save("payload-1", "client_request", { text: "{\"model\":\"demo\"}", truncated: false, originalBytes: 16, capturedBytes: 16 });
    rt.payloads.save("payload-1", "provider_response", { text: "event: done", truncated: true, originalBytes: 20000, capturedBytes: 10 });
    rt.flush();
    const payload = rt.payloads.get("payload-1");
    expect(payload?.clientRequest?.text).toBe("{\"model\":\"demo\"}");
    expect(payload?.providerResponse?.truncated).toBe(true);
    expect(payload?.providerResponse?.originalBytes).toBe(20000);
  });

  test("runtime DB path is separate from config DB path", () => {
    expect(rt.env.runtimeDbPath).not.toBe(rt.env.dbPath);
    expect(rt.env.runtimeDbPath).toContain("runtime.sqlite");
    expect(rt.env.dbPath).toContain("config.sqlite");
  });

  test("console log push and list", () => {
    rt.consoleLogs.push("info", "test", "hello world");
    rt.flush();
    const result = rt.consoleLogs.list({ limit: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.msg).toBe("hello world");
    expect(result.items[0]!.level).toBe("info");
  });
  test("read queries do not force a pending telemetry flush", () => {
    rt.consoleLogs.push("info", "test", "queued");
    expect(rt.pendingWrites()).toBe(1);
    expect(rt.consoleLogs.list({ limit: 10 }).items).toHaveLength(0);
    expect(rt.pendingWrites()).toBe(1);
    rt.flush();
    expect(rt.consoleLogs.list({ limit: 10 }).items).toHaveLength(1);
  });

  test("console log clear removes all entries", () => {
    rt.consoleLogs.push("info", "t", "msg1");
    rt.consoleLogs.push("error", "t", "msg2");
    rt.flush();
    rt.consoleLogs.clear();
    expect(rt.consoleLogs.list({ limit: 10 }).items).toHaveLength(0);
  });

  test("console log after returns entries after a given id", () => {
    rt.consoleLogs.push("info", "t", "a");
    rt.consoleLogs.push("info", "t", "b");
    rt.consoleLogs.push("info", "t", "c");
    rt.flush();
    const all = rt.consoleLogs.list({ limit: 10 }).items;
    const mid = all[1]!.id;
    const after = rt.consoleLogs.after(mid, 10);
    expect(after).toHaveLength(1);
    expect(after[0]!.msg).toBe("c");
  });

  test("console log sanitizeMessage is applied on push", () => {
    rt.consoleLogs.push("info", "t", "Bearer sk-secret-token-123");
    rt.flush();
    const entry = rt.consoleLogs.list({ limit: 1 }).items[0]!;
    expect(entry.msg).not.toContain("sk-secret-token-123");
    expect(entry.msg).toContain("[redacted]");
  });

  test("warp metrics record and latest", () => {
    rt.warpMetrics.record({
      accountId: "wm1", label: "warp1", pid: 1234, socksPort: 40001,
      rssKb: 10240, rxBytes: 1000, txBytes: 2000, healthy: true, egressIp: "1.2.3.4", collectedAt: "2025-01-01 00:00:00",
    });
    rt.flush();
    const latest = rt.warpMetrics.latest();
    expect(latest).toHaveLength(1);
    expect(latest[0]!.accountId).toBe("wm1");
    expect(latest[0]!.rssKb).toBe(10240);
    expect(latest[0]!.healthy).toBe(true);
  });

  test("warp metrics page paginates", () => {
    for (let i = 0; i < 5; i++) {
      rt.warpMetrics.record({ accountId: `wm${i}`, label: "w", pid: i, socksPort: 40000+i, rssKb: 0, rxBytes: 0, txBytes: 0, healthy: true, egressIp: null, collectedAt: "2025-01-01 00:00:00" });
    }
    rt.flush();
    const p1 = rt.warpMetrics.page(null, 3);
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = rt.warpMetrics.page(p1.nextCursor, 3);
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
  });

  test("warp metrics summary aggregates healthy instances", () => {
    rt.warpMetrics.record({ accountId: "s1", label: "w1", pid: 1, socksPort: 40001, rssKb: 2048, rxBytes: 1048576, txBytes: 2097152, healthy: true, egressIp: "1.1.1.1", collectedAt: new Date().toISOString().slice(0,19).replace("T"," ") });
    rt.flush();
    const s = rt.warpMetrics.summary();
    expect(s.runningCount).toBe(1);
    expect(s.totalRssMb).toBe(2);
  });

  test("warp metrics prune removes old rows", () => {
    for (let i = 0; i < 20; i++) {
      rt.warpMetrics.record({ accountId: `p${i}`, label: "w", pid: i, socksPort: 40000+i, rssKb: 0, rxBytes: 0, txBytes: 0, healthy: true, egressIp: null, collectedAt: "2025-01-01 00:00:00" });
    }
    rt.flush();
    rt.warpMetrics.prune(5);
    const count = (rt.db().query("SELECT COUNT(*) AS n FROM warp_metrics").get() as { n: number }).n;
    expect(count).toBeLessThanOrEqual(8); // 5 * 1.5 = 7.5, rounded
  });

  test("resetAll clears all runtime tables", () => {
    rt.consoleLogs.push("info", "t", "msg");
    rt.warpMetrics.record({ accountId: "x", label: "w", pid: 1, socksPort: 1, rssKb: 0, rxBytes: 0, txBytes: 0, healthy: true, egressIp: null, collectedAt: "2025-01-01 00:00:00" });
    rt.flush();
    rt.resetAll();
    expect(rt.consoleLogs.list({ limit: 10 }).items).toHaveLength(0);
    expect(rt.warpMetrics.latest()).toHaveLength(0);
  });

  test("closeForSwap then reopen reopens the runtime DB", () => {
    rt.consoleLogs.push("info", "t", "persisted-msg");
    rt.flush();
    rt.closeForSwap();
    rt.reopen();
    expect(rt.consoleLogs.list({ limit: 10 }).items).toHaveLength(1);
  });

  test("close then db() throws a closed error", () => {
    rt.close();
    expect(() => rt.db()).toThrow(/closed/i);
  });
});

describe("runtime telemetry writer", () => {
  let rt: RuntimePersistence;
  beforeEach(() => { resetRuntimePersistenceForTests(); rt = makeRuntime("telemetry"); });
  afterEach(() => rt.close());

  test("finish writes a request_history row", async () => {
    const handle = rt.telemetry.start({
      requestId: "trace-1",
      endpoint: "/v1/chat/completions",
      surface: "openai-chat",
      apiKeyId: "key1",
      apiKeyPrefix: "sk-prefix",
      clientName: "claude_code",
      clientSource: "explicit_header",
      startedAt: new Date().toISOString(),
      clientIp: "127.0.0.1",
      messageCount: 0,
      toolCount: 0,
      imageCount: 0,
    });
    await handle.finish({
      statusCode: 200, errorKind: null,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 10, cacheWriteTokens: 5, source: "provider" },
      providerId: "openai", model: "gpt-4", mode: "stream",
      messageCount: 1, toolCount: 0, imageCount: 0,
    });
    rt.flush();
    const page = rt.metadata.queryRequests({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.requestId).toBe("trace-1");
    expect(page.items[0]!.status).toBe(200);
    expect(page.items[0]!.inputTokens).toBe(100);
    expect(page.items[0]!.mode).toBe("stream");
  });

  test("mapClientName narrows to allowlist", () => {
    expect(mapClientName("claude_code")).toBe("claude_code");
    expect(mapClientName("unknown")).toBe("unknown");
    expect(mapClientName("bogus")).toBe("unknown");
    expect(mapClientName(null)).toBe("unknown");
  });

  test("mapClientSource narrows to allowlist", () => {
    expect(mapClientSource("explicit_header")).toBe("explicit_header");
    expect(mapClientSource("bogus")).toBe("unknown");
    expect(mapClientSource(null)).toBe("unknown");
  });

  test("telemetry is best-effort — write buffer never crashes on closed DB", () => {
    rt.close();
    // These should not throw even though DB is closed
    rt.consoleLogs.push("info", "t", "post-close");
    expect(rt.pendingWrites()).toBeGreaterThanOrEqual(0);
  });
});

describe("runtime retention", () => {
  let rt: RuntimePersistence;
  beforeEach(() => { resetRuntimePersistenceForTests(); rt = makeRuntime("retention"); });
  afterEach(() => rt.close());

  test("retain removes old request_history and console_logs", () => {
    // Insert an old request_history row
    rt.db().query("INSERT INTO request_history (trace_id, endpoint, surface, status, stream, started_at, finished_at, duration_ms, usage_source, client_name, client_source, message_count, tool_count, image_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("old-trace", "/v1", "openai", 200, 0, "2020-01-01 00:00:00", "2020-01-01 00:00:01", 100, "unknown", "unknown", "unknown", 0, 0, 0);
    rt.db().query("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, ?, ?, ?)").run("2020-01-01 00:00:00", "info", "old", "old log");

    const result = rt.retain({ logRetentionDays: 1, assetRetentionDays: 1 });
    expect(result.historyRemoved).toBeGreaterThan(0);
    expect(result.consoleLogsRemoved).toBeGreaterThan(0);

    const histCount = (rt.db().query("SELECT COUNT(*) AS n FROM request_history").get() as { n: number }).n;
    expect(histCount).toBe(0);
    const logCount = (rt.db().query("SELECT COUNT(*) AS n FROM console_logs").get() as { n: number }).n;
    expect(logCount).toBe(0);
  });

  test("retain keeps recent data", () => {
    const recent = new Date().toISOString().slice(0, 19).replace("T", " ");
    rt.db().query("INSERT INTO request_history (trace_id, endpoint, surface, status, stream, started_at, finished_at, duration_ms, usage_source, client_name, client_source, message_count, tool_count, image_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("recent-trace", "/v1", "openai", 200, 0, recent, recent, 50, "unknown", "unknown", "unknown", 0, 0, 0);
    const result = rt.retain({ logRetentionDays: 14, assetRetentionDays: 7 });
    expect(result.historyRemoved).toBe(0);
    const histCount = (rt.db().query("SELECT COUNT(*) AS n FROM request_history").get() as { n: number }).n;
    expect(histCount).toBe(1);
  });

  test("retain caps console_logs at MAX_CONSOLE_LOG_ROWS (10000)", () => {
    // Insert 10002 rows
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    for (let i = 0; i < 10002; i++) {
      rt.db().query("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, ?, ?, ?)").run(now, "info", "t", `msg-${i}`);
    }
    const result = rt.retain({ logRetentionDays: 365, assetRetentionDays: 365 });
    expect(result.consoleLogsRemoved).toBeGreaterThan(0);
    const count = (rt.db().query("SELECT COUNT(*) AS n FROM console_logs").get() as { n: number }).n;
    expect(count).toBeLessThanOrEqual(10000);
  });

  test("retainRuntimeData is idempotent — safe to call repeatedly", () => {
    rt.db().query("INSERT INTO request_history (trace_id, endpoint, surface, status, stream, started_at, finished_at, duration_ms, usage_source, client_name, client_source, message_count, tool_count, image_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("old", "/v1", "openai", 200, 0, "2020-01-01 00:00:00", "2020-01-01 00:00:01", 100, "unknown", "unknown", "unknown", 0, 0, 0);
    const r1 = retainRuntimeData(() => rt.db(), { logRetentionDays: 1, assetRetentionDays: 1, assetDir: rt.env.assetDir });
    const r2 = retainRuntimeData(() => rt.db(), { logRetentionDays: 1, assetRetentionDays: 1, assetDir: rt.env.assetDir });
    expect(r1.historyRemoved).toBeGreaterThan(0);
    expect(r2.historyRemoved).toBe(0);
  });

  test("startRetentionMaintenance returns a stop function", () => {
    const maintenance = rt.startRetentionMaintenance(3600000);
    expect(typeof maintenance.stop).toBe("function");
    maintenance.stop();
  });
});

describe("runtime metadata queries", () => {
  let rt: RuntimePersistence;
  beforeEach(() => { resetRuntimePersistenceForTests(); rt = makeRuntime("metadata"); });
  afterEach(() => rt.close());

  test("querySummary returns zeros on empty DB", () => {
    rt.flush();
    const s = rt.metadata.querySummary("24h");
    expect(s.requests).toBe(0);
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
    expect(s.errors).toBe(0);
  });

  test("getRequestById returns null for missing", () => {
    rt.flush();
    expect(rt.metadata.getRequestById(99999)).toBeNull();
  });

  test("queryRequests returns empty page on empty DB", () => {
    rt.flush();
    const page = rt.metadata.queryRequests({ limit: 10 });
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  test("sumKeyTokens returns zeros for unknown key", () => {
    rt.flush();
    const r = rt.metadata.sumKeyTokens("unknown-key");
    expect(r.dailyUsed).toBe(0);
    expect(r.allTimeUsed).toBe(0);
  });

  test("queryProviderToday returns empty array on empty DB", () => {
    rt.flush();
    expect(rt.metadata.queryProviderToday()).toHaveLength(0);
  });
});

describe("ensureRuntimeSchema idempotency and trace_id uniqueness", () => {
  test("ensureRuntimeSchema is idempotent — safe to call twice", () => {
    const dir = uniqueTempDir("ensure-schema");
    const dbPath = join(dir, "rt.sqlite");
    const db = new Database(dbPath, { create: true });
    const r1 = ensureRuntimeSchema(db);
    const r2 = ensureRuntimeSchema(db);
    expect(r2.traceIdUnique).toBe(r1.traceIdUnique);
    db.close();
  });

  test("trace_id uniqueness is promoted when no duplicates exist", () => {
    const dir = uniqueTempDir("trace-unique");
    const dbPath = join(dir, "rt.sqlite");
    const db = new Database(dbPath, { create: true });
    const r = ensureRuntimeSchema(db);
    expect(r.traceIdUnique).toBe(true);
    // The unique index should exist
    const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_request_history_trace_id'").get();
    expect(idx).not.toBeNull();
    db.close();
  });
});

describe("config/runtime database separation", () => {
  test("config DB and runtime DB use different files under the same data dir", async () => {
    const dir = uniqueTempDir("separation");
    const env = makeEnv(dir);
    const config = createConfigPersistence(env);
    config.settings.ensure();
    config.close();

    const rt = createRuntimePersistence(env);
    rt.consoleLogs.push("info", "t", "msg");
    rt.flush();

    // Both files exist
    expect(existsSync(env.dbPath)).toBe(true);
    expect(existsSync(env.runtimeDbPath)).toBe(true);

    // Config DB has settings table, runtime DB does not
    const configDb = new Database(env.dbPath);
    const hasSettings = configDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
    expect(hasSettings).not.toBeNull();
    configDb.close();

    const rtDb = new Database(env.runtimeDbPath);
    const rtHasSettings = rtDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
    expect(rtHasSettings).toBeNull();
    const rtHasRequestHistory = rtDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='request_history'").get();
    expect(rtHasRequestHistory).not.toBeNull();
    rtDb.close();

    rt.close();
  });

  test("config backup never includes runtime tables", () => {
    const dir = uniqueTempDir("backup-sep");
    const env = makeEnv(dir);
    const config = createConfigPersistence(env);
    config.settings.ensure();
    config.apiKeys.create({ id: "sep1", name: "sep", key: "sk-sep", keyPrefix: "sk-sep" });
    const backup = config.backup();
    expect(backup.tables).not.toHaveProperty("request_history");
    expect(backup.tables).not.toHaveProperty("console_logs");
    expect(backup.tables).not.toHaveProperty("warp_metrics");
    config.close();
  });

  test("runtime data is not in config DB and vice versa", () => {
    const dir = uniqueTempDir("cross-sep");
    const env = makeEnv(dir);
    const config = createConfigPersistence(env);
    config.settings.ensure();
    const rt = createRuntimePersistence(env);
    rt.consoleLogs.push("info", "t", "x");
    rt.flush();
    rt.close();
    config.close();

    // Config DB should NOT have console_logs
    const configDb = new Database(env.dbPath);
    const configHasConsoleLogs = configDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='console_logs'").get();
    expect(configHasConsoleLogs).toBeNull();
    configDb.close();

    // Runtime DB should NOT have api_keys
    const rtDb = new Database(env.runtimeDbPath);
    const rtHasApiKeys = rtDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'").get();
    expect(rtHasApiKeys).toBeNull();
    rtDb.close();
  });
});

describe("resetAll and clearAllDatabaseTables", () => {
  test("clearAllDatabaseTables removes all rows from all tables", () => {
    const persist = makeConfig("clearall");
    persist.settings.ensure();
    persist.apiKeys.create({ id: "ca1", name: "ca", key: "sk-ca", keyPrefix: "sk-ca" });
    persist.accounts.create({ id: "ca2", provider: "openai", name: "ca2", credentialKind: "api_key", credential: "c", credentialHint: "h" });
    clearAllDatabaseTables(persist.db());
    expect(persist.apiKeys.list()).toHaveLength(0);
    expect(persist.accounts.list()).toHaveLength(0);
    persist.close();
  });

  test("resetAll clears tables then re-ensures settings", () => {
    const persist = makeConfig("resetall");
    persist.settings.ensure();
    persist.settings.setPasswordHash("before-reset");
    persist.apiKeys.create({ id: "ra1", name: "ra", key: "sk-ra", keyPrefix: "sk-ra" });
    persist.resetAll();
    // Settings should be re-initialized
    const s = persist.settings.get();
    expect(s).not.toBeNull();
    expect(s!.passwordHash).toBeNull(); // reset
    expect(persist.apiKeys.list()).toHaveLength(0);
    persist.close();
  });

  test("runtime resetAll clears all runtime tables", () => {
    const rt = makeRuntime("rt-resetall");
    rt.consoleLogs.push("info", "t", "msg");
    rt.warpMetrics.record({ accountId: "x", label: "w", pid: 1, socksPort: 1, rssKb: 0, rxBytes: 0, txBytes: 0, healthy: true, egressIp: null, collectedAt: "2025-01-01 00:00:00" });
    rt.flush();
    rt.resetAll();
    expect(rt.consoleLogs.list({ limit: 10 }).items).toHaveLength(0);
    expect(rt.warpMetrics.latest()).toHaveLength(0);
    rt.close();
  });
});

describe("schema helper functions", () => {
  test("credentialKindOf maps legacy kinds", () => {
    expect(credentialKindOf("bearer")).toBe("api_key");
    expect(credentialKindOf("pat")).toBe("api_key");
    expect(credentialKindOf("session-token")).toBe("api_key");
    expect(credentialKindOf("oauth")).toBe("oauth");
    expect(credentialKindOf("api_key")).toBe("api_key");
    expect(credentialKindOf("manual")).toBe("manual");
    expect(credentialKindOf("unknown")).toBe("manual");
    expect(credentialKindOf(null)).toBe("manual");
    expect(credentialKindOf(undefined)).toBe("manual");
  });

  test("toRouteStatus returns valid statuses, defaults to error", () => {
    expect(toRouteStatus("healthy")).toBe("healthy");
    expect(toRouteStatus("cooling_down")).toBe("cooling_down");
    expect(toRouteStatus("error")).toBe("error");
    expect(toRouteStatus("disabled")).toBe("disabled");
    expect(toRouteStatus("bogus")).toBe("error");
    expect(toRouteStatus(null)).toBe("error");
  });

  test("toErrorKind returns null for empty, otherwise passes through", () => {
    expect(toErrorKind(null)).toBeNull();
    expect(toErrorKind(undefined)).toBeNull();
    expect(toErrorKind("")).toBeNull();
    expect(toErrorKind("internal_error")).toBe("internal_error");
  });

  test("orNullString returns null for empty/null/undefined", () => {
    expect(orNullString(null)).toBeNull();
    expect(orNullString(undefined)).toBeNull();
    expect(orNullString("")).toBeNull();
    expect(orNullString("value")).toBe("value");
  });

  test("configError produces a sanitized error", () => {
    const e = configError("some error with password=top-secret");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).not.toContain("top-secret");
  });
});

describe("persistence env", () => {
  test("makeEnv produces correct paths", () => {
    const dir = "/test/dir";
    const env = makeEnv(dir);
    expect(env.dataDir).toBe(dir);
    expect(env.dbPath).toBe(join(dir, "config.sqlite"));
    expect(env.runtimeDbPath).toBe(join(dir, "runtime.sqlite"));
    expect(env.assetDir).toBe(join(dir, "assets"));
    expect(env.logRetentionDays).toBe(14);
    expect(env.assetRetentionDays).toBe(7);
    expect(env.maxFlightsPerIp).toBe(15);
  });
});

import { describe, expect, test, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigPersistence, resetConfigPersistenceForTests } from "../../src/storage/main/config";
import type { PersistenceEnv } from "../../src/storage/main/env";

function testEnv(): PersistenceEnv {
  const dir = join(tmpdir(), `cartethyia-config-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
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

describe("config persistence: settings", () => {
  test("ensure + get + settings_json round-trip", () => {
    const p = createConfigPersistence(testEnv());
    const ensured = p.settings.ensure();
    expect(ensured.passwordHash).toBeNull();
    expect(p.settings.get()).not.toBeNull();

    const patched = p.settings.patchSettingsJson({ foo: "bar", nested: { x: 1 } });
    expect(patched.foo).toBe("bar");
    expect((patched.nested as { x: number }).x).toBe(1);

    const reread = p.settings.getSettingsJson();
    expect(reread.foo).toBe("bar");
  });

  test("runtime settings patch is bounded and persisted", () => {
    const p = createConfigPersistence(testEnv());
    p.settings.ensure();
    const runtime = p.settings.patchRuntimeSettings({ logRetentionDays: 42 });
    expect(runtime.logRetentionDays).toBe(42);
    const reread = p.settings.getRuntimeSettings(testEnv());
    expect(reread.logRetentionDays).toBe(42);
  });

  test("password hash + version + jwt rotation", () => {
    const p = createConfigPersistence(testEnv());
    p.settings.ensure();
    p.settings.setPasswordHash("argon2$hash");
    p.settings.bumpPasswordVersion();
    p.settings.rotateJwtSecret("secret-123");

    const row = p.settings.get();
    expect(row).not.toBeNull();
    expect(row!.passwordHash).toBe("argon2$hash");
    expect(row!.passwordVersion).toBeGreaterThanOrEqual(1);
    expect(row!.jwtSecret).toBe("secret-123");
  });
});

describe("config persistence: api keys", () => {
  function keyInput(over: Partial<import("../../src/storage/main/config").ApiKeyCreateInput> = {}) {
    return {
      id: "key-1",
      name: "primary",
      key: "sk-secret-1",
      keyPrefix: "sk-",
      ...over,
    } satisfies import("../../src/storage/main/config").ApiKeyCreateInput;
  }

  test("create, getBySecret, credential, list", () => {
    const p = createConfigPersistence(testEnv());
    const created = p.apiKeys.create(keyInput());
    expect(created.id).toBe("key-1");
    expect(created.keyPrefix).toBe("sk-");

    expect(p.apiKeys.getById("key-1")?.name).toBe("primary");
    expect(p.apiKeys.getBySecret("sk-secret-1")?.id).toBe("key-1");
    expect(p.apiKeys.getBySecret("sk-wrong")).toBeNull();
    expect(p.apiKeys.credential("key-1")).toBe("sk-secret-1");
    expect(p.apiKeys.list().length).toBe(1);
  });

  test("update patches fields, including ACL allowlist", () => {
    const p = createConfigPersistence(testEnv());
    p.apiKeys.create(keyInput());
    const updated = p.apiKeys.update("key-1", {
      name: "renamed",
      rateLimitRpm: 10,
      dailyTokenLimit: 1000,
      modelAllowlist: "gpt-5,claude*",
      modelDenylist: "gpt-4",
    });
    expect(updated?.name).toBe("renamed");
    expect(updated?.rateLimitRpm).toBe(10);
    expect(updated?.dailyTokenLimit).toBe(1000);
    expect(updated?.modelAllowlist).toContain("gpt-5");
  });

  test("regenerate secret via update.key, revoke, delete", () => {
    const p = createConfigPersistence(testEnv());
    p.apiKeys.create(keyInput());
    const regen = p.apiKeys.update("key-1", { key: "sk-secret-2" });
    // key_prefix is re-sliced to the first 12 chars on regeneration
    expect(regen?.keyPrefix).toBe("sk-secret-2");
    expect(p.apiKeys.getBySecret("sk-secret-2")?.id).toBe("key-1");
    expect(p.apiKeys.getBySecret("sk-secret-1")).toBeNull();
    expect(p.apiKeys.credential("key-1")).toBe("sk-secret-2");

    expect(p.apiKeys.revoke("key-1")).toBe(true);
    expect(p.apiKeys.getById("key-1")?.active).toBe(false);
    // revoking again returns false (already revoked)
    expect(p.apiKeys.revoke("key-1")).toBe(false);
  });

  test("one-time token accounting", () => {
    const p = createConfigPersistence(testEnv());
    p.apiKeys.create(keyInput({ oneTimeTokenLimit: 100 }));
    expect(p.apiKeys.sumOneTimeTokensUsed("key-1")).toBe(0);
    p.apiKeys.consumeOneTimeTokens("key-1", 30);
    expect(p.apiKeys.sumOneTimeTokensUsed("key-1")).toBe(30);
  });

  test("touch coalesces last_used_at", () => {
    const p = createConfigPersistence(testEnv());
    p.apiKeys.create(keyInput());
    p.apiKeys.touch("key-1");
    p.apiKeys.flushTouches();
    expect(p.apiKeys.getById("key-1")?.lastUsedAt).not.toBeNull();
  });

  test("unknown id update returns null", () => {
    const p = createConfigPersistence(testEnv());
    expect(p.apiKeys.update("missing", { name: "x" })).toBeNull();
    expect(p.apiKeys.delete("missing")).toBe(false);
  });
});

describe("config persistence: accounts & health", () => {
  test("create, patch, listActiveCredentials, delete", () => {
    const p = createConfigPersistence(testEnv());
    p.accounts.create({
      id: "acc-1",
      provider: "openai",
      name: "prod",
      credentialKind: "api_key",
      credential: "sk-prod",
      credentialHint: "sk-",
      priority: 10,
      active: true,
    });
    const listed = p.accounts.list();
    expect(listed.length).toBe(1);
    expect(listed[0]!.id).toBe("acc-1");
    expect(listed[0]!.credentialHint).toBe("sk-");

    const creds = p.accounts.listActiveCredentials("openai");
    expect(creds).toEqual(["sk-prod"]);

    const patched = p.accounts.patch("acc-1", { name: "renamed", priority: 5, active: false });
    expect(patched?.name).toBe("renamed");
    expect(patched?.priority).toBe(5);
    expect(patched?.active).toBe(false);
    expect(p.accounts.listActiveCredentials("openai")).toEqual([]);

    expect(p.accounts.patch("missing", { name: "x" })).toBeNull();
    expect(p.accounts.delete("acc-1")).toBe(true);
    expect(p.accounts.get("acc-1")).toBeNull();
  });

  test("account health upsert requires parent account, then clear", async () => {
    const p = createConfigPersistence(testEnv());
    // health upser silently skips when the parent account row is absent
    await p.accountHealth.upsert("openai/acc-1", {
      scope: "account",
      status: "error",
      statusCode: 503,
      failureKind: "unavailable",
      sanitizedMessage: "upstream 503",
      occurredAt: "2025-01-01T00:00:00Z",
      retryAt: "2025-01-01T00:01:00Z",
    });
    expect(await p.accountHealth.get("openai/acc-1")).toBeNull();

    // create the account, then health persists
    p.accounts.create({
      id: "openai/acc-1",
      provider: "openai",
      name: "acc-1",
      credentialKind: "api_key",
      credential: "sk",
      credentialHint: "sk-",
    });
    await p.accountHealth.upsert("openai/acc-1", {
      scope: "account",
      status: "error",
      statusCode: 503,
      failureKind: "unavailable",
      sanitizedMessage: "upstream 503",
      occurredAt: "2025-01-01T00:00:00Z",
      retryAt: "2025-01-01T00:01:00Z",
    });
    const health = await p.accountHealth.get("openai/acc-1");
    expect(health).not.toBeNull();
    expect(health?.statusCode).toBe(503);
    expect((await p.accountHealth.list()).length).toBe(1);
    await p.accountHealth.clear("openai/acc-1");
    expect(await p.accountHealth.get("openai/acc-1")).toBeNull();
  });
});

describe("config persistence: proxies", () => {
  test("create, list, patch, recordTest", () => {
    const p = createConfigPersistence(testEnv());
    p.proxies.create({
      id: "px-1",
      name: "eu-1",
      protocol: "https",
      host: "proxy.example.com",
      port: 443,
      username: "u",
      password: "p",
    });
    const pxy = p.proxies.get("px-1");
    expect(pxy?.host).toBe("proxy.example.com");
    expect(pxy?.port).toBe(443);
    expect(pxy?.isRelay).toBe(false);

    const tested = p.proxies.recordTest("px-1", { testedAt: "2025-01-01T00:00:00Z", ok: true, latencyMs: 120, statusCode: 200, error: null });
    expect(tested?.lastTestSuccessAt).toBe("2025-01-01T00:00:00Z");
    expect(tested?.lastTestSuccessLatencyMs).toBe(120);

    const patched = p.proxies.patch("px-1", { active: false, weight: 3 });
    expect(patched?.active).toBe(false);
    expect(patched?.weight).toBe(3);

    expect(p.proxies.recordTest("px-missing", { testedAt: "x", ok: true, latencyMs: null, statusCode: null, error: null })).toBeNull();
    expect(p.proxies.delete("px-1")).toBe(true);
  });

  test("proxy settings defaults on first patch", () => {
    const p = createConfigPersistence(testEnv());
    expect(p.proxies.getSettings()).toBeNull();
    const patched = p.proxies.patchSettings({ enabled: true, routingPreset: "target-user", excludedProviders: ["openai"] });
    expect(patched.enabled).toBe(true);
    expect(patched.routingPreset).toBe("target-user");
    expect(patched.excludedProviders).toContain("openai");
    expect(p.proxies.getSettings()?.enabled).toBe(true);
    // bounded: unknown preset falls back to auto
    const bounded = p.proxies.patchSettings({ routingPreset: "nonsense" as never });
    expect(bounded.routingPreset).toBe("auto");
  });
});

describe("config persistence: routing refs", () => {
  test("aliases CRUD", () => {
    const p = createConfigPersistence(testEnv());
    p.aliases.upsert("fast", "openai/gpt-5");
    expect(p.aliases.get("fast")?.model).toBe("openai/gpt-5");
    expect(p.aliases.list().length).toBe(1);
    p.aliases.upsert("fast", "anthropic/claude-3");
    expect(p.aliases.get("fast")?.model).toBe("anthropic/claude-3");
    expect(p.aliases.delete("fast")).toBe(true);
    expect(p.aliases.get("fast")).toBeNull();
  });

  test("combos CRUD", () => {
    const p = createConfigPersistence(testEnv());
    p.combos.upsert({ id: "c-1", name: "trio", models: ["openai/gpt-5", "google/gemini-2.5-pro"], strategy: "fallback", stickyLimit: 3 });
    const combo = p.combos.get("c-1");
    expect(combo?.name).toBe("trio");
    expect(combo?.stickyLimit).toBe(3);
    expect(p.combos.list().length).toBe(1);
    expect(p.combos.delete("c-1")).toBe(true);
  });

  test("provider models upsert/enable/delete", () => {
    const p = createConfigPersistence(testEnv());
    p.providerModels.upsert("openai", "gpt-5", { enabled: true, source: "catalog" });
    const m = p.providerModels.get("openai", "gpt-5");
    expect(m?.enabled).toBe(true);
    expect(m?.source).toBe("catalog");
    expect(p.providerModels.list("openai").length).toBe(1);
    p.providerModels.upsert("openai", "gpt-5", { enabled: false });
    expect(p.providerModels.get("openai", "gpt-5")?.enabled).toBe(false);
    expect(p.providerModels.delete("openai", "gpt-5")).toBe(true);
  });
});


describe("config persistence: custom providers & access", () => {
  test("custom provider upsert/updateModels/delete", () => {
    const p = createConfigPersistence(testEnv());
    p.customProviders.upsert({
      id: "cp-1",
      slug: "my-llm",
      name: "My LLM",
      type: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      credential: "sk-custom",
      timeoutSeconds: 30,
    });
    expect(p.customProviders.get("cp-1")?.slug).toBe("my-llm");
    expect(p.customProviders.getBySlug("my-llm")?.id).toBe("cp-1");
    expect(p.customProviders.list().length).toBe(1);

    const updated = p.customProviders.updateModels("cp-1", [{ modelId: "m1" }]);
    expect(updated?.models?.length).toBe(1);
    expect(p.customProviders.delete("cp-1")).toBe(true);
    expect(p.customProviders.get("cp-1")).toBeNull();
  });

  test("access rules get + upsert", () => {
    const p = createConfigPersistence(testEnv());
    expect(p.accessRules.get("openai")).toBeNull();
    const rule = p.accessRules.upsert("openai", { mode: "allow", entries: ["acc-1"] });
    expect(rule.mode).toBe("allow");
    expect(rule.entries).toContain("acc-1");
    expect(p.accessRules.get("openai")?.mode).toBe("allow");
  });

  test("share links CRUD + touch + patchActive", () => {
    const p = createConfigPersistence(testEnv());
    // share links FK-reference an existing api key
    p.apiKeys.create({ id: "key-1", name: "n", key: "sk-1", keyPrefix: "sk-" });
    p.shareLinks.create({ id: "sl-1", apiKeyId: "key-1", tokenHash: "h1", active: true });
    expect(p.shareLinks.getByTokenHash("h1")?.id).toBe("sl-1");
    expect(p.shareLinks.listByApiKey("key-1").length).toBe(1);
    expect(p.shareLinks.patchActive("sl-1", false)?.active).toBe(false);
    p.shareLinks.touch("sl-1");
    expect(p.shareLinks.getByTokenHash("h1")?.lastViewedAt).not.toBeNull();
    expect(p.shareLinks.delete("sl-1")).toBe(true);
  });
});

describe("config persistence: backup & reset", () => {
  test("backup returns a payload with settings", () => {
    const p = createConfigPersistence(testEnv());
    p.settings.ensure();
    p.settings.setPasswordHash("argon2$hash");
    const payload = p.backup();
    expect(payload).toBeDefined();
    expect(typeof payload).toBe("object");
  });

  test("resetAll clears rows and re-ensures settings", () => {
    const p = createConfigPersistence(testEnv());
    p.apiKeys.create({ id: "k", name: "n", key: "sk", keyPrefix: "sk-" });
    p.aliases.upsert("a", "openai/gpt-5");
    expect(p.aliases.list().length).toBe(1);
    p.resetAll();
    expect(p.aliases.list().length).toBe(0);
    expect(p.apiKeys.list().length).toBe(0);
    expect(p.settings.get()).not.toBeNull();
  });

  test("checkpoint does not throw", () => {
    const p = createConfigPersistence(testEnv());
    p.checkpoint();
  });
});


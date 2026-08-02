import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { convert9RouterBackup } from "../../src/console/backup/compat/9router";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

beforeEach(() => {
  useIsolatedDataDir();
});

const sampleBackup = {
  settings: {},
  providerConnections: [
    {
      provider: "codex",
      authType: "oauth",
      name: "codex-one",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      email: "one@example.com",
      providerSpecificData: { chatgptAccountId: "account-one", chatgptPlanType: "plus" },
    },
    { provider: "qwen", authType: "apikey", name: "unsupported", apiKey: "qwen-key" },
    { provider: "openai", authType: "apikey", name: "openai-one", apiKey: "openai-key" },
  ],
  providerNodes: [{ id: "node-1", name: "Custom node", type: "openai", baseUrl: "https://example.com/v1" }],
  proxyPools: [{ id: "relay-1", name: "Vercel relay", proxyUrl: "https://relay.vercel.app", type: "vercel", isActive: true }],
  apiKeys: [{ id: "key-1", name: "9router key", key: "sk-nine-router", isActive: true }],
  combos: [{ id: "combo-1", name: "Codex combo", kind: "fallback", models: ["codex/gpt-5.4"] }],
  modelAliases: { fast: "codex/gpt-5.4" },
};

describe("9router backup compatibility adapter", () => {
  test("converts supported credentials, aliases, combos, and relay pools", () => {
    const result = convert9RouterBackup(sampleBackup);
    const tables = result.backup.tables as Record<string, Array<Record<string, unknown>>>;
    const accounts = tables.provider_accounts;
    const oauth = accounts?.find((row) => row.provider === "openai-codex");
    expect(oauth?.credential_kind).toBe("oauth");
    expect(JSON.parse(String(oauth?.credential)).provider).toBe("openai-codex");
    expect(accounts?.some((row) => row.provider === "openai")).toBe(true);
    expect(result.report.skipped.unsupportedProviders).toEqual([{ provider: "qwen", count: 1, names: ["unsupported"] }]);
    expect(tables.proxies?.[0]?.is_relay).toBe(1);
    expect(tables.proxies?.[0]?.host).toBe("relay.vercel.app");
    expect(tables.model_aliases?.[0]?.model).toBe("openai-codex/gpt-5.4");
    expect(result.report.skipped.unsupportedNodes).toHaveLength(1);
  });

  test("skips OAuth connections whose token fields contain an HTML error page", () => {
    const result = convert9RouterBackup({
      ...sampleBackup,
      providerConnections: [{
        provider: "codex",
        name: "bad-codex",
        accessToken: "<html><head><title>Unauthorized</title></head></html>",
        refreshToken: "refresh-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }],
    });
    expect(result.report.imported.accounts).toBe(0);
    expect(result.report.skipped.invalidConnections).toEqual([
      { provider: "codex", name: "bad-codex", reason: "missing or invalid access token, refresh token, or expiry" },
    ]);
  });

  test("rejects non-9router payloads", () => {
    expect(() => convert9RouterBackup({ app: "cartethyia", version: 1 })).toThrow("not a 9router backup");
  });
});

describe("9router restore API", () => {
  test("restores supported data and returns skip report", async () => {
    const cookie = await loginAndGetCookie();
    const response = await app.handle(
      postJson("/console/api/settings/restore/9router", { password: "carte1234", backup: sampleBackup }, { cookie })
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      ok: boolean;
      restored: Record<string, number>;
      compatibility: { imported: { accounts: number; proxies: number }; skipped: { unsupportedProviders: Array<{ provider: string }> } };
    };
    expect(result.ok).toBe(true);
    expect(result.restored.provider_accounts).toBe(2);
    expect(result.restored.proxies).toBe(1);
    expect(result.compatibility.imported.accounts).toBe(2);
    expect(result.compatibility.skipped.unsupportedProviders[0]?.provider).toBe("qwen");
  });

  test("auto-detects raw 9router payload through the native restore button", async () => {
    const cookie = await loginAndGetCookie();
    const response = await app.handle(
      postJson("/console/api/settings/restore", { password: "carte1234", backup: sampleBackup }, { cookie })
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok: boolean; compatibility?: { source: string } };
    expect(result.ok).toBe(true);
    expect(result.compatibility?.source).toBe("9router");
  });
});

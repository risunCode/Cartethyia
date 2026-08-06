import { describe, expect, test } from "bun:test";
import { convert9RouterBackup } from "../../src/console/compat/9router";

describe("convert9RouterBackup", () => {
  test("converts provider connections, proxies, keys, aliases, and combos", () => {
    const { backup, report } = convert9RouterBackup({
      providerConnections: [
        { name: "gpt", provider: "openai", apiKey: "sk-abc", createdAt: "2026-01-01T00:00:00.000Z" },
        { name: "claude", provider: "claude", accessToken: "token-x", isActive: false },
        { name: "legacy", provider: "opencode-free", apiKey: "sk-op", isActive: true },
      ],
      proxyPools: [
        { name: "p1", proxyUrl: "socks5://user:pass@host:1080", isActive: true },
        { name: "p2", proxyUrl: "not-a-url", isActive: true },
        { name: "p3", proxyUrl: "http://bad/path", isActive: true },
      ],
      apiKeys: [{ name: "k1", key: "sk-key-12345" }],
      modelAliases: { fast: "openai/gpt-5", legacy: "opencode/gpt-4o", stale: "unknownprov/x" },
      combos: [{ name: "trio", models: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"] }],
      providerNodes: [{ id: "node-1" }],
    });

    expect(report.imported.accounts).toBe(3);
    expect(report.imported.proxies).toBe(1);
    expect(report.imported.apiKeys).toBe(1);
    expect(report.imported.aliases).toBe(2);
    expect(report.imported.combos).toBe(1);
    expect(report.skipped).toContain("invalid proxy p2");
    expect(report.warnings).toHaveLength(1);

    expect(backup.app).toBe("cartethyia");
    const accounts = (backup.tables as unknown as { provider_accounts: Array<Record<string, unknown>> }).provider_accounts;
    expect(accounts).toHaveLength(3);
    const claude = accounts.find((acc) => acc.name === "claude") as { credential_kind: string; active: boolean };
    expect(claude.credential_kind).toBe("oauth");
    expect(claude.active).toBe(false);
    // Provider prefix remap: opencode-free -> opencodeft
    const legacy = accounts.find((acc) => acc.name === "legacy") as { provider: string };
    expect(legacy.provider).toBe("opencodeft");
  });

  test("throws for a non-object input", () => {
    expect(() => convert9RouterBackup("nope")).toThrowError(/must be an object/);
    expect(() => convert9RouterBackup([1, 2])).toThrowError(/must be an object/);
    expect(() => convert9RouterBackup(null)).toThrowError(/must be an object/);
  });

  test("skips provider connections lacking a mapped provider or credential", () => {
    const { report } = convert9RouterBackup({
      providerConnections: [
        { name: "no-cred", provider: "openai" },
        { name: "no-provider", provider: "zzz", apiKey: "k" },
      ],
    });
    expect(report.imported.accounts).toBe(0);
    expect(report.skipped.length).toBeGreaterThanOrEqual(2);
  });

  test("skips combos with fewer than two resolvable models", () => {
    const { report } = convert9RouterBackup({
      combos: [{ name: "solo", models: ["openai/gpt-5"] }, { name: "empty", models: [] }],
    });
    expect(report.imported.combos).toBe(0);
  });
});

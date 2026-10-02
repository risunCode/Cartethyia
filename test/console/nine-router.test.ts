import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { detectFormat } from "../../src/console/backup/validate";
import { convert9RouterBackup } from "../../src/console/backup/nine-router";
import { decryptCredentialToString, hashSecret } from "../../src/security/crypto";

/**
 * Router-export importer — smoke + refusals only. Full round-trip lives in
 * `backup-roundtrip.test.ts`; here we guard detection and the dangerous cases
 * (unknown provider ids, credential mapping).
 */
describe("router backup detection", () => {
  test("detects native vs nine-router exports", () => {
    expect(
      detectFormat({ app: "cartethyia", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", sections: {} }).kind,
    ).toBe("native");
    expect(
      detectFormat({ providerConnections: [], providerNodes: [], apiKeys: [], combos: [] }).kind,
    ).toBe("nine_router");
    expect(detectFormat({ app: "other", version: 1 }).kind).toBe("unknown");
  });
});

describe("router export conversion (smoke)", () => {
  const tenantId = randomUUID();

  function exportFixture() {
    return {
      providerConnections: [
        {
          id: "c1",
          provider: "claude",
          authType: "oauth",
          name: "Claude main",
          apiKey: "sk-ant-oat-EXAMPLE",
          isActive: true,
          createdAt: "2026-01-02T03:04:05.000Z",
        },
        {
          id: "c2",
          provider: "windsurf",
          authType: "api_key",
          name: "Skip me",
          apiKey: "",
          isActive: true,
        },
      ],
      providerNodes: [],
      apiKeys: [{ id: "k1", name: "router", key: "rk_router_key_123", isActive: true }],
      combos: [],
      modelAliases: {},
      proxyPools: [],
      customModels: [],
      pricing: {},
      mitmAlias: {},
      settings: {},
    };
  }

  test("imports a mapped account with encrypted credential", () => {
    const { payload, report } = convert9RouterBackup(exportFixture(), tenantId);
    expect(report.imported.accounts).toBe(1);
    const claude = payload.sections.config?.provider_accounts?.find((a) => a.provider_id === "claude");
    expect(claude?.tenant_id).toBe(tenantId);
    const bytes = (claude?.credential_ciphertext as { __bytes: string }).__bytes;
    expect(decryptCredentialToString(Buffer.from(bytes, "base64"))).toBe("sk-ant-oat-EXAMPLE");
  });

  test("refuses an unknown provider id instead of importing it verbatim", () => {
    const { payload, report } = convert9RouterBackup(
      {
        providerConnections: [
          { id: "c1", provider: "totally-unknown-router", name: "Mystery", apiKey: "secret" },
        ],
      },
      tenantId,
    );
    expect(report.imported.accounts).toBe(0);
    expect(report.skipped.join("\n")).toContain("totally-unknown-router");
    expect(payload.sections.config?.provider_accounts).toBeUndefined();
  });

  test("stores imported API keys as hashes only", () => {
    const { payload } = convert9RouterBackup(exportFixture(), tenantId);
    const keys = payload.sections.config?.api_keys ?? [];
    expect(keys[0]?.key_hash).toBe(hashSecret("rk_router_key_123"));
    expect(JSON.stringify(keys[0])).not.toContain("rk_router_key_123");
  });

  // A real 9router export nests every per-row payload in a `data` JSON string
  // and stores a combo's members as a JSON-encoded string. Reading those
  // columns off the top level silently imported zero providers.
  test("reads credentials, node URLs and combo members out of the data JSON string", () => {
    const { payload, report } = convert9RouterBackup(
      {
        providerConnections: [
          {
            id: "c1",
            provider: "openai-compatible-chat-abc123",
            name: "My node",
            isActive: 1,
            createdAt: "2026-01-02T03:04:05.000Z",
            data: JSON.stringify({ apiKey: "sk-node-key", defaultModel: "some-model" }),
          },
        ],
        providerNodes: [
          {
            id: "openai-compatible-chat-abc123",
            type: "openai-compatible",
            name: "My node",
            data: JSON.stringify({ prefix: "oa2", apiType: "chat", baseUrl: "https://example.test/v1" }),
          },
        ],
        combos: [
          { id: "k1", name: "my-combo", models: JSON.stringify(["oa2/model-a", "oa2/model-b"]) },
        ],
      },
      tenantId,
    );
    expect(report.skipped).toEqual([]);
    const account = payload.sections.config?.provider_accounts?.find((a) => a.provider_id === "oa2");
    expect(account?.label).toBe("My node");
    const bytes = (account?.credential_ciphertext as { __bytes: string }).__bytes;
    expect(decryptCredentialToString(Buffer.from(bytes, "base64"))).toBe("sk-node-key");
    const provider = payload.sections.config?.providers?.find((p) => p.id === "oa2");
    expect(provider?.base_url).toBe("https://example.test/v1");
    const combo = payload.sections.config?.model_combos?.find((c) => c.name === "my-combo");
    expect((combo?.members as string[]).length).toBe(2);
    const modelIds = (payload.sections.config?.models ?? []).map((m) => m.model_id).sort();
    expect(modelIds).toEqual(["model-a", "model-b"]);
    // The base URL already ends in its version segment, so the endpoint must
    // stay relative or the join produces `/api/v1/v1/chat/completions`.
    expect(payload.sections.config?.models?.[0]?.endpoint_path).toBe("/chat/completions");
  });

  test("keeps the /v1 prefix when a node base URL is a bare host", () => {
    // 9router never persists a node's model list, so the members have to come
    // from a combo — and the endpoint from the node's own base URL.
    const { payload } = convert9RouterBackup(
      {
        providerConnections: [],
        providerNodes: [
          {
            id: "n1",
            type: "openai-compatible",
            name: "Bare",
            data: JSON.stringify({ prefix: "bare", apiType: "chat", baseUrl: "https://bare.test" }),
          },
        ],
        combos: [
          { id: "cb", name: "bare-combo", kind: "fallback", models: JSON.stringify(["bare/m1", "bare/m2"]) },
        ],
      },
      tenantId,
    );
    expect(payload.sections.config?.models?.[0]?.endpoint_path).toBe("/v1/chat/completions");
  });
});

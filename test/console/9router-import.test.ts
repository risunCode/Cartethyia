/**
 * Legacy backup import, against a captured export shape.
 *
 * The provider mapping is exercised here as data: a row is
 * imported, refused, or remapped, and the report says which. The cases are the
 * ones a real file actually contained — measured against an operator's own
 * backup — plus the two defects that shape taught us:
 *
 * - a model reference addresses a BYOK node by its **short prefix** (`oc/model`)
 *   while a connection row names the node by its full generated id. Resolving
 *   only the id form silently dropped every alias and combo member.
 * - `customModels` names its provider `providerAlias`, not `provider`, so
 *   reading `provider` alone reported all 1,329 rows as having no provider.
 *
 * A refused row is asserted as refused. "Import something that looks similar" is
 * how a credential ends up attached to a provider the operator never chose.
 */
import { describe, expect, test } from "bun:test";
import { convert9RouterBackup } from "../../src/console/backup/nine-router";
import { detectFormat, validateRestorePayload } from "../../src/console/backup/validate";
import {
  COMBO_STRATEGIES,
  isNodeProviderId,
  PROXY_KINDS,
  UPSTREAM_PROVIDERS,
} from "../../src/console/backup/9router-map";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = "2026-01-01T00:00:00.000Z";

const NODE_ID = "openai-compatible-chat-b58c53d0-1167-4b17-8d4f-52ba411ea6d9";

function backup(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    providerConnections: [],
    providerNodes: [],
    proxyPools: [],
    apiKeys: [],
    combos: [],
    modelAliases: {},
    customModels: [],
    ...overrides,
  };
}

describe("legacy provider mapping", () => {
  test("maps the upstreams we carry, and refuses the ones we do not", () => {
    // Same upstream, different spelling.
    expect(UPSTREAM_PROVIDERS["grok-cli"]).toBe("grok");
    expect(UPSTREAM_PROVIDERS.xai).toBe("grok");
    // Our own ids, spelled identically. These were previously listed as
    // unsupported while both families ship in `src/providers/integrations/`.
    expect(UPSTREAM_PROVIDERS.github).toBe("github");
    expect(UPSTREAM_PROVIDERS.kiro).toBe("kiro");
    // No counterpart, and the report has to say so rather than guess.
    const { report } = convert9RouterBackup(
      backup({
        providerConnections: [
          { id: "a", provider: "devin", authType: "apikey", apiKey: "sk-1", isActive: true, createdAt: NOW },
          { id: "b", provider: "kiro", authType: "oauth", accessToken: "tok", isActive: true, createdAt: NOW },
        ],
      }),
      TENANT,
    );
    expect(report.imported.accounts).toBe(1);
    expect(report.skipped).toEqual([`connection 1: provider "devin" (no matching provider)`]);
  });

  test("a BYOK node id is its own provider, and its prefix resolves a model reference", () => {
    expect(isNodeProviderId(NODE_ID)).toBe(true);
    expect(isNodeProviderId("devin")).toBe(false);

    const { payload, report } = convert9RouterBackup(
      backup({
        providerNodes: [{ id: NODE_ID, type: "openai-compatible", prefix: "oc", baseUrl: "https://relay.example/v1" }],
        modelAliases: { "flash-free": "oc/deepseek-v4-flash-free" },
        combos: [{ id: "c", name: "pair", kind: null, models: ["oc/a", "oc/b"], createdAt: NOW }],
        customModels: [{ id: "m1", name: "deepseek", providerAlias: "oc" }],
      }),
      TENANT,
    );
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } }).sections.config;
    // The node becomes our provider under its prefix, which is what callers address.
    expect((config.providers ?? []).map((row) => row.id)).toEqual(["oc"]);
    expect((config.providers ?? [])[0]?.base_url).toBe("https://relay.example/v1");
    // Every reference to it resolves, by prefix rather than by generated id.
    expect(report.imported.aliases).toBe(1);
    expect(report.imported.combos).toBe(1);
    expect(report.imported.models).toBe(1);
    expect((config.model_aliases ?? [])[0]?.target_model).toBe("oc/deepseek-v4-flash-free");
  });

  test("a node type we cannot serve is refused, not assumed to be OpenAI-shaped", () => {
    const { report } = convert9RouterBackup(
      backup({
        providerNodes: [{ id: "n1", type: "grpc-bidi", prefix: "gr", baseUrl: "https://x.example" }],
      }),
      TENANT,
    );
    expect(report.imported.providers).toBe(0);
    expect(report.skipped[0]).toContain('type "grpc-bidi"');
  });
});

describe("legacy proxy pools", () => {
  test("a hosted runtime imports as the protocol it speaks", () => {
    // These four are TLS front doors; `isRelayHost` dials them through the relay
    // contract, which is the only way a serverless host answers at all.
    for (const type of ["vercel", "cloudflare", "deno", "netlify"]) {
      expect(PROXY_KINDS[type]).toBe("https");
    }
    expect(PROXY_KINDS.http).toBe("http");
    expect(PROXY_KINDS.socks5).toBe("socks5");
  });

  test("pools import as network pools, and a failing one stays failing", () => {
    const { payload, report } = convert9RouterBackup(
      backup({
        proxyPools: [
          {
            id: "p1",
            name: "sg1",
            type: "vercel",
            proxyUrl: "https://relay.vercel.app",
            noProxy: "localhost",
            isActive: false,
            testStatus: "error",
            lastError: "connect ECONNREFUSED",
            createdAt: NOW,
          },
          {
            id: "p2",
            name: "direct",
            type: "socks5",
            proxyUrl: "socks5://user:hunter2@1.2.3.4:1080",
            isActive: true,
            createdAt: NOW,
          },
        ],
      }),
      TENANT,
    );
    expect(report.imported.pools).toBe(2);
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } }).sections.config;
    const [relay, socks] = config.network_pools ?? [];

    expect(relay?.kind).toBe("https");
    expect(relay?.endpoint_config).toEqual({ endpoint: "https://relay.vercel.app", no_proxy: "localhost" });
    // The router recorded it as unreachable; importing that as healthy would put
    // a dead egress into rotation.
    expect(relay?.status).toBe("disabled");
    expect(relay?.last_error).toBe("connect ECONNREFUSED");

    expect(socks?.kind).toBe("socks5");
    // The credential leaves the URL: the endpoint is logged, and a credential
    // inside a logged string is a credential in a log.
    expect((socks?.endpoint_config as { endpoint: string }).endpoint).toBe("socks5://1.2.3.4:1080");
    expect(socks?.proxy_credential).toBe("user:hunter2");
  });

  test("a pool with no URL is reported, not invented", () => {
    const { report } = convert9RouterBackup(
      backup({ proxyPools: [{ id: "p", name: "empty", type: "http", createdAt: NOW }] }),
      TENANT,
    );
    expect(report.imported.pools).toBe(0);
    expect(report.skipped[0]).toBe('proxy pool "empty": no proxy URL');
  });
});

describe("legacy accounts", () => {
  test("the credential travels under the secret's name and is re-sealed on restore", () => {
    const { payload, report } = convert9RouterBackup(
      backup({
        providerConnections: [
          {
            id: "a",
            provider: "codex",
            name: "main",
            authType: "apikey",
            apiKey: "sk-secret",
            priority: 3,
            email: "ops@example.com",
            providerSpecificData: { region: "ap-southeast-1", clientSecret: "shh" },
            isActive: true,
            createdAt: NOW,
          },
        ],
      }),
      TENANT,
    );
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } }).sections.config;
    const account = (config.provider_accounts ?? [])[0];
    // `access_token`, never `credential_ciphertext`: the payload's only portable
    // form of a sealed column is the plaintext under the secret's own name.
    expect(account?.access_token).toBe("sk-secret");
    expect(account?.credential_ciphertext).toBeUndefined();
    expect(account?.sort_index).toBe(3);
    expect(account?.account_email).toBe("ops@example.com");
    // Non-secret upstream config lands in `auth_state`; the secret beside it does
    // not — it gets its own sealed row.
    expect(account?.auth_state).toEqual({ region: "ap-southeast-1" });
    const state = (config.provider_oauth_states ?? [])[0];
    expect(state?.client_secret).toBe("shh");
    // Carried rather than dropped, and the report says it is inert.
    expect(report.warnings).toContain('account "main": carried a client secret with no refresh token; it cannot authorize a refresh');
  });

  test("a refresh token is a second sealed secret, not part of the credential", () => {
    const { payload } = convert9RouterBackup(
      backup({
        providerConnections: [
          {
            id: "a",
            provider: "claude",
            authType: "oauth",
            accessToken: "at",
            refreshToken: "rt",
            isActive: true,
            createdAt: NOW,
          },
        ],
      }),
      TENANT,
    );
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } }).sections.config;
    expect((config.provider_accounts ?? [])[0]?.access_token).toBe("at");
    expect((config.provider_accounts ?? [])[0]?.credential_kind).toBe("oauth");
    expect((config.provider_oauth_states ?? [])[0]?.refresh_token).toBe("rt");
  });

  test("an api key keeps its bearer and its restriction", () => {
    const { payload, report } = convert9RouterBackup(
      backup({
        apiKeys: [
          { id: "k", key: "sk-live-1234567890", name: "prod", isActive: true, createdAt: NOW, accessRestricted: true, accessAllow: ["claude/*"] },
          { id: "k2", key: "sk-dead", name: "old", isActive: false, createdAt: NOW },
        ],
      }),
      TENANT,
    );
    expect(report.imported.apiKeys).toBe(2);
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } }).sections.config;
    // Stored as the hash, so the imported key authenticates with the same bearer.
    expect((config.api_keys ?? [])[0]?.key_hash).toHaveLength(64);
    expect((config.api_keys ?? [])[0]?.revoked_at).toBeNull();
    // An inactive key is revoked *at import*, not backdated to its creation: the
    // router stopped trusting it at some unknown point, and inventing that
    // instant would be a claim about history nobody has.
    expect((config.api_keys ?? [])[1]?.revoked_at).toMatchObject({ __date: expect.any(String) });
  });
});

describe("legacy combos", () => {
  test("a strategy we do not carry is reported, not silently substituted", () => {
    expect(COMBO_STRATEGIES["round-robin"]).toBe("round_robin");
    // `null` is the router's own unset value, and `fallback` is its default.
    const { payload, report } = convert9RouterBackup(
      backup({
        providerNodes: [{ id: NODE_ID, type: "openai-compatible", prefix: "oc", baseUrl: "https://relay.example/v1" }],
        combos: [{ id: "c", name: "pair", kind: "weighted-random", models: ["oc/a", "oc/b"], createdAt: NOW }],
      }),
      TENANT,
    );
    expect(report.imported.combos).toBe(1);
    expect(report.warnings).toContain('combo "pair": strategy "weighted-random" imported as "fallback"');
    const config = (payload as unknown as { sections: { config: Record<string, Record<string, unknown>[]> } }).sections.config;
    expect((config.model_combos ?? [])[0]?.strategy).toBe("fallback");
    expect((config.model_combos ?? [])[0]?.members).toEqual(["oc/a", "oc/b"]);
  });

  test("a member whose provider is absent is refused, so the combo is refused too", () => {
    const { report } = convert9RouterBackup(
      backup({ combos: [{ id: "c", name: "pair", kind: null, models: ["kr/auto", "oc/x"], createdAt: NOW }] }),
      TENANT,
    );
    expect(report.imported.combos).toBe(0);
    expect(report.skipped.some((entry) => entry.includes("needs at least two resolvable members"))).toBe(true);
  });
});

describe("legacy payload validity", () => {
  test("the converted payload validates against the live schema", () => {
    const { payload } = convert9RouterBackup(
      backup({
        providerNodes: [{ id: NODE_ID, type: "openai-compatible", prefix: "oc", baseUrl: "https://relay.example/v1" }],
        providerConnections: [
          { id: "a", provider: NODE_ID, name: "relay", authType: "apikey", apiKey: "sk-1", isActive: true, createdAt: NOW },
        ],
        proxyPools: [{ id: "p", name: "sg", type: "vercel", proxyUrl: "https://r.vercel.app", isActive: true, createdAt: NOW }],
        apiKeys: [{ id: "k", key: "sk-live-abcdefgh", isActive: true, createdAt: NOW }],
        modelAliases: { fast: "oc/fast" },
        combos: [{ id: "c", name: "pair", kind: null, models: ["oc/a", "oc/b"], createdAt: NOW }],
        customModels: [{ id: "m", name: "fast", providerAlias: "oc" }],
      }),
      TENANT,
    );
    // The store rejects an unknown column, so a clean validation here is what
    // proves the converter writes only real ones.
    const validation = validateRestorePayload(payload, TENANT);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.value.warnings).toEqual([]);
  });

  test("a router export is detected by shape, not by a flag", () => {
    expect(detectFormat(backup({ providerConnections: [], apiKeys: [] })).kind).toBe("nine_router");
    expect(detectFormat({ app: "cartethyia", version: 1, sections: {} }).kind).toBe("native");
    expect(detectFormat({ hello: "world" }).kind).toBe("unknown");
  });
});

import { describe, expect, test } from "bun:test";

import { createModelCatalogOperations } from "../../../src/console/providers/catalog/model-operations";
import { ProviderRegistry, parseProviderId } from "../../../src/providers/provider-registry";
import type { ModelCatalogEntry } from "../../../src/console/providers/catalog/contracts";

function entry(modelId: string, provider: string): ModelCatalogEntry {
  return {
    modelId,
    route: "/v1/chat/completions",
    provider,
    wireFamily: "chat",
    enabled: true,
    contextLimit: 128_000,
    outputLimit: 16_000,
    reasoning: false,
    toolCall: true,
    vision: false,
    document: false,
    audio: false,
    mediaGeneration: false,
    webSearch: false,
    cost: null,
    source: "builtin",
    sourceUpdatedAt: null,
  };
}

const access = {
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
} as never;

function catalog(options: {
  readonly models?: { readonly providerId: string; readonly entries: readonly ModelCatalogEntry[] }[];
  readonly aliases?: readonly { readonly alias: string; readonly targetModel: string }[];
  readonly combos?: readonly { readonly name: string; readonly members: readonly string[] }[];
  readonly activeProviders?: readonly string[];
}) {
  const models = options.models ?? [];
  return createModelCatalogOperations({
    store: {
      async list() {
        return (options.activeProviders ?? models.map((m) => m.providerId)).map((providerId) => ({
          providerId,
          tenantId: "tenant-1",
          enabled: true,
          isBuiltIn: false,
          requiresAccount: true,
        }));
      },
      async listAllAccounts() {
        return (options.activeProviders ?? models.map((m) => m.providerId)).map((providerId, index) => ({
          id: `acc-${index}`,
          providerId,
          tenantId: "tenant-1",
          label: providerId,
          credentialKind: "api_key",
          status: "active",
        }));
      },
      async listModels(_tenantId: string, providerId: string) {
        return models.find((m) => m.providerId === providerId)?.entries ?? [];
      },
    } as never,
    accessResolver: () => access,
    providerRegistry: new ProviderRegistry(),
    listRoutingTargets: async () => ({
      aliases: options.aliases ?? [],
      combos: options.combos ?? [],
    }),
  });
}

describe("listFlatModels", () => {
  test("includes model rows of providers that have an active account", async () => {
    const ops = catalog({
      models: [{ providerId: "hantu", entries: [entry("grok-4.6-high", "hantu")] }],
    });
    const flat = await ops.listFlatModels(access);
    expect(flat.map((e) => e.qualified)).toEqual(["hantu/grok-4.6-high"]);
    expect(flat[0]?.kind).toBe("model");
  });

  test("skips providers without an active account", async () => {
    const ops = catalog({
      models: [{ providerId: "hantu", entries: [entry("grok-4.6-high", "hantu")] }],
      activeProviders: [],
    });
    expect(await ops.listFlatModels(access)).toEqual([]);
  });

  test("lists aliases and combos as selectable targets", async () => {
    const ops = catalog({
      models: [{ providerId: "opencodeft", entries: [entry("muse-spark-1.3-contributor-free", "opencodeft")] }],
      aliases: [{ alias: "muse-spark-1.3", targetModel: "opencodeft/muse-spark-1.3-contributor-free" }],
      combos: [{ name: "websearch", members: ["a/one", "b/two"] }],
    });
    const flat = await ops.listFlatModels(access);
    const alias = flat.find((e) => e.qualified === "muse-spark-1.3");
    const combo = flat.find((e) => e.qualified === "websearch");
    expect(alias?.kind).toBe("alias");
    expect(combo?.kind).toBe("combo");
    // The alias must reuse the real model row so the picker shows real capability
    // metadata instead of empty placeholders.
    expect(alias?.entry.modelId).toBe("muse-spark-1.3-contributor-free");
    expect(alias?.entry.contextLimit).toBe(128_000);
  });

  test("an alias pointing at an unknown target still appears", async () => {
    const ops = catalog({ aliases: [{ alias: "dangling", targetModel: "gone/model" }] });
    const flat = await ops.listFlatModels(access);
    const alias = flat.find((e) => e.qualified === "dangling");
    expect(alias?.kind).toBe("alias");
    expect(alias?.entry.source).toBe("alias");
  });

  test("a real model row wins over an alias with the same name", async () => {
    const ops = catalog({
      models: [{ providerId: "acme", entries: [entry("clash", "acme")] }],
      aliases: [{ alias: "acme/clash", targetModel: "acme/clash" }],
    });
    const flat = await ops.listFlatModels(access);
    expect(flat.filter((e) => e.qualified === "acme/clash")).toHaveLength(1);
    expect(flat.find((e) => e.qualified === "acme/clash")?.kind).toBe("model");
  });

  test("omitting the routing-target reader yields model entries only", async () => {
    const ops = createModelCatalogOperations({
      store: {
        async list() {
          return [
            {
              providerId: parseProviderId("acme"),
              tenantId: "tenant-1",
              enabled: true,
              isBuiltIn: false,
              requiresAccount: true,
            },
          ];
        },
        async listAllAccounts() {
          return [
            {
              id: "acc-1",
              providerId: "acme",
              tenantId: "tenant-1",
              label: "acme",
              credentialKind: "api_key",
              status: "active",
            },
          ];
        },
        async listModels() {
          return [entry("one", "acme")];
        },
      } as never,
      accessResolver: () => access,
      providerRegistry: new ProviderRegistry(),
    });
    const flat = await ops.listFlatModels(access);
    expect(flat.map((e) => e.qualified)).toEqual(["acme/one"]);
  });
});

import { describe, expect, test } from "bun:test";
import { withRoutingRevisionTracking } from "../src/bootstrap/routing";
import type { CartethyiaRuntime } from "../src/bootstrap/composition";
import { catalogRevision } from "../src/middleware/proxy";
import { createRouteSnapshotCache } from "../src/application/routing-snapshot";
import type { ConfigPersistence } from "../src/storage";
import { ProviderRegistry } from "../src/providers/registry";
import { describeOpenAIAdapter, createOpenAIAdapter } from "../src/open-sse/transport/openai-adapter";

function sources(readRevision: () => number, aliases: () => readonly unknown[]) {
  const config = {
    aliases: { list: aliases },
    combos: { list: () => [] },
    accounts: { list: () => [] },
  } as unknown as ConfigPersistence;
  const registry = {
    list: () => [{ metadata: { id: "test" }, models: { list: [] } }],
  } as unknown as ProviderRegistry;
  return { config, registry, readRevision };
}

describe("routing cache", () => {
  test("shares one rebuild across concurrent readers", async () => {
    let aliasReads = 0;
    const cache = createRouteSnapshotCache(sources(() => 0, () => {
      aliasReads += 1;
      return [];
    }));

    const snapshots = await Promise.all([cache.get(), cache.get(), cache.get()]);

    expect(aliasReads).toBe(1);
    expect(snapshots.every((snapshot) => snapshot.revision === 0)).toBe(true);
  });

  test("does not publish a snapshot built from an obsolete revision", async () => {
    let revision = 0;
    let aliasReads = 0;
    const cache = createRouteSnapshotCache(sources(() => revision, () => {
      aliasReads += 1;
      if (aliasReads === 1) revision = 1;
      return [];
    }));

    const snapshot = await cache.get();

    expect(snapshot.revision).toBe(1);
    expect(aliasReads).toBe(2);
  });
});

describe("catalog revision", () => {
  test("reads the runtime revision without querying configuration tables", () => {
    let routingRevisionReads = 0;
    const runtime = {
      routingRevision: () => {
        routingRevisionReads += 1;
        return 42;
      },
    } as unknown as CartethyiaRuntime;

    expect(catalogRevision(runtime)).toBe(42);
    expect(routingRevisionReads).toBe(1);
  });
});

describe("configuration cache invalidation", () => {
  test("filter rule mutations advance the runtime revision", async () => {
    const revision = { value: 0 };
    const config = {
      aliases: {},
      combos: {},
      proxies: {},
      accounts: {},
      customProviders: {},
      providerModels: {},
      filterRules: {
        create: async () => ({ ruleId: "test" }),
        update: async () => null,
        remove: async () => false,
        list: async () => [],
        listSync: () => [],
      },
    } as unknown as ConfigPersistence;
    const registry = { list: () => [] } as unknown as ProviderRegistry;
    const tracked = withRoutingRevisionTracking(config, registry, undefined, revision);

    await tracked.filterRules.create({ pattern: "test", replacement: "", isRegex: false });

    expect(revision.value).toBe(1);
  });
});
describe("lazy provider adapters", () => {
  test("publishes catalog metadata without instantiating transport", async () => {
    const config = {
      id: "lazy-test",
      displayName: "Lazy Test",
      baseUrl: "https://example.test/v1",
      credentialKind: "api_key",
    } as const;
    const registry = new ProviderRegistry();
    let loads = 0;

    registry.registerLazy(describeOpenAIAdapter(config), async () => {
      loads += 1;
      return createOpenAIAdapter(config);
    });

    expect(loads).toBe(0);
    expect(registry.get("lazy-test")?.metadata.displayName).toBe("Lazy Test");
    expect(registry.resolveTarget("unknown-model", "openai-chat").providerId).toBe("lazy-test");
    expect(loads).toBe(0);

    await registry.prewarm(["lazy-test"]);
    expect(loads).toBe(1);
    await registry.prewarm(["lazy-test"]);
    expect(loads).toBe(1);
  });
});

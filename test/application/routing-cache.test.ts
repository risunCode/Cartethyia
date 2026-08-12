import { describe, expect, test } from "bun:test";
import { withRoutingRevisionTracking, routeResolver } from "../../src/bootstrap/routing";
import type { CartethyiaRuntime } from "../../src/bootstrap/composition";
import { catalogRevision } from "../../src/middleware/proxy";
import { createRouteSnapshotCache, type RoutingSnapshot } from "../../src/application/routing-snapshot";
import type { Adapter, NormalizedTool, ProviderCaps, ProviderMeta, ProviderModel, ProviderOutput, ProxyRequest, RouteTarget } from "../../src/application/contracts";
import type { ConfigPersistence } from "../../src/storage";
import { capabilitiesOf, createModelCatalog, modelOf } from "../../src/open-sse/transport/catalog";
import { ProviderRegistry } from "../../src/providers/registry";
import { describeOpenAIAdapter, createOpenAIAdapter } from "../../src/open-sse/transport/openai-adapter";
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
  test("routing config mutations advance the runtime revision", async () => {
    const revision = { value: 0 };
    const config = {
      aliases: {},
      combos: {},
      proxies: {},
      cliModelMappings: {
        setEnabled: () => ({ toolId: "claude", enabled: true, updatedAt: "" }),
        upsert: () => ({ toolId: "claude", slotKey: "mythos", sourceModel: "claude/claude-mythos-5", targetModel: "openai/gpt-5.6-luna", enabled: true, createdAt: "", updatedAt: "" }),
        delete: () => true,
        reset: () => {},
      },
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
    tracked.cliModelMappings.setEnabled("claude", true);
    tracked.cliModelMappings.upsert({
      toolId: "claude",
      slotKey: "mythos",
      sourceModel: "claude/claude-mythos-5",
      targetModel: "openai/gpt-5.6-luna",
      enabled: true,
    });

    expect(revision.value).toBe(3);
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
function makeAdapter(
  providerId: string,
  protocol: ProviderMeta["protocol"],
  modelId: string,
  capabilities: ProviderCaps,
): Adapter {
  const metadata: ProviderMeta = { id: providerId, displayName: providerId, protocol, credentialKind: "none" };
  const model: ProviderModel = modelOf(modelId, modelId, capabilities);
  const models = createModelCatalog([model]);
  const output: ProviderOutput = { mode: "non_stream", body: {} };
  return {
    metadata,
    capabilities,
    models,
    resolveTarget: (resolvedModelId, surface): RouteTarget => ({ providerId, modelId: resolvedModelId, upstreamModelId: resolvedModelId, surface }),
    call: async (): Promise<ProviderOutput> => output,
    mapError: () => ({
      statusCode: 500,
      kind: "internal_error",
      retryable: false,
      routeScope: "provider",
      source: "internal",
      sanitizedMessage: "test adapter error",
      retryAt: null,
    }),
  };
}

function searchRequest(model: string): ProxyRequest {
  const tool: NormalizedTool = { name: "web_search", description: null, inputSchema: {} };
  return {
    model,
    messages: [],
    tools: [tool],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "anthropic-messages",
    signal: new AbortController().signal,
    limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 1_000 },
  };
}

function routeSnapshot(prefixes: ReadonlyMap<string, string>, accountsByProvider: RoutingSnapshot["accountsByProvider"] = new Map()): RoutingSnapshot {
  return {
    revision: 0,
    prefixes,
    aliases: new Map(),
    combos: new Map(),
    cliModelMappings: new Map(),
    accountsByProvider,
    knownModelIds: new Map(),
  };
}

const claudeClient = { name: "claude_code", source: "unknown" } as const;
const affinity = { namespace: "trusted_identity", value: "routing-test" } as const;

describe("web-search route capability policy", () => {
  test("keeps an unsupported mapped route as a non-blocking passthrough", async () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("kimchi", "openai", "deepseek-v4-flash", capabilitiesOf({ surfaces: ["openai-chat"] })));
    const snapshot = routeSnapshot(new Map([["kimchi", "kimchi"]]));
    const resolve = routeResolver(registry, { get: async () => snapshot }, null as never, null as never);

    const plan = await resolve(searchRequest("kimchi/deepseek-v4-flash"), affinity, claudeClient);

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(["kimchi/deepseek-v4-flash"]);
    expect(plan.candidates[0]?.searchRoute).toBe("passthrough");
    expect(plan.webSearchPassthrough).toBe(true);
    expect(plan.unsupportedReason).toBeUndefined();
  });

  test("keeps the original route ahead of configured search providers", async () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("kimchi", "openai", "deepseek-v4-flash", capabilitiesOf({ surfaces: ["openai-chat"] })));
    registry.register(makeAdapter("exa", "exa", "exa-search", capabilitiesOf({ surfaces: ["web-search"], search: true })));
    const snapshot = routeSnapshot(
      new Map([["kimchi", "kimchi"]]),
      new Map([["exa", [{ id: "exa-account", providerId: "exa", credentialKind: "api_key", active: true }]]]),
    );
    const resolve = routeResolver(registry, { get: async () => snapshot }, null as never, null as never);

    const plan = await resolve(searchRequest("kimchi/deepseek-v4-flash"), affinity, claudeClient);

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(["kimchi/deepseek-v4-flash", "exa/exa-search"]);
    expect(plan.candidates[0]?.searchRoute).toBe("passthrough");
    expect(plan.candidates[1]?.searchRoute).toBe("exa");
  });

  test("keeps the mapped native-search route ahead of fallback providers", async () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("codex", "openai", "gpt-5.5", capabilitiesOf({ surfaces: ["openai-responses"], search: true })));
    registry.register(makeAdapter("exa", "exa", "exa-search", capabilitiesOf({ surfaces: ["web-search"], search: true })));
    const snapshot = routeSnapshot(
      new Map([["codex", "codex"]]),
      new Map([["exa", [{ id: "exa-account", providerId: "exa", credentialKind: "api_key", active: true }]]]),
    );
    const resolve = routeResolver(registry, { get: async () => snapshot }, null as never, null as never);

    const plan = await resolve(searchRequest("codex/gpt-5.5"), affinity, claudeClient);

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(["codex/gpt-5.5", "exa/exa-search"]);
    expect(plan.candidates[0]?.searchRoute).toBe("native");
  });

  test("keeps the original route ahead of preferred search providers", async () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter("kimchi", "openai", "deepseek-v4-flash", capabilitiesOf({ surfaces: ["openai-chat"] })));
    registry.register(makeAdapter("codex", "openai", "gpt-5.5", capabilitiesOf({ surfaces: ["openai-responses"], search: true })));
    registry.register(makeAdapter("antigravity", "gemini", "gemini-3-flash", capabilitiesOf({ surfaces: ["openai-chat"], search: true })));
    registry.register(makeAdapter("exa", "exa", "exa-search", capabilitiesOf({ surfaces: ["web-search"], search: true })));
    const snapshot = routeSnapshot(new Map([["kimchi", "kimchi"]]));
    const resolve = routeResolver(registry, { get: async () => snapshot }, null as never, null as never, () => "prefer-exa");

    const plan = await resolve(searchRequest("kimchi/deepseek-v4-flash"), affinity, claudeClient);

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual([
      "kimchi/deepseek-v4-flash",
      "exa/exa-search",
      "codex/gpt-5.5",
      "antigravity/gemini-3-flash",
    ]);
  });
});

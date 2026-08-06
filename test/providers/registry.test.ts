import { describe, expect, test } from "bun:test";
import type { ProviderCallError } from "../../src/domain/contracts";
import type { ContextStats, ProviderAdapter, ProviderModel, ProviderSurface, RouteTarget } from "../../src/domain/contracts";
import { ProviderAdapterError, capabilitiesOf, createModelCatalog, modelOf } from "../../src/providers/shared";
import { ProviderRegistry, createDefaultRegistry } from "../../src/providers/registry";

const openaiChat: ProviderSurface = "openai-chat";

/**
 * Minimal deterministic ProviderAdapter stub. Curated providers reject unknown
 * models (matching OpenAI/Anthropic/Native behavior); catalog-less providers
 * (routers/local/custom) accept arbitrary model ids.
 */
function adapter(
  id: string,
  surfaces: readonly ProviderSurface[],
  models: readonly ProviderModel[] = [],
): ProviderAdapter {
  const catalog = createModelCatalog(models);
  const capabilities = capabilitiesOf({ surfaces });
  return {
    metadata: { id, displayName: id, protocol: "openai", credentialKind: "api_key" },
    capabilities,
    models: catalog,
    resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
      if (!surfaces.includes(surface)) {
        throw new ProviderAdapterError({ kind: "capability_unsupported", message: `no surface ${surface}`, statusCode: 400, routeScope: null });
      }
      if (models.length > 0 && catalog.get(modelId) === null) {
        throw new ProviderAdapterError({ kind: "model_not_found", message: `unknown model ${modelId}`, statusCode: 404, routeScope: "provider" });
      }
      return { providerId: id, modelId, upstreamModelId: modelId, surface };
    },
    async call(): Promise<never> {
      throw new Error("not implemented");
    },
    countTokens(): Promise<ContextStats> {
      return Promise.resolve({ tokens: null, source: "unknown" });
    },
    mapError(error: unknown): ProviderCallError {
      throw error;
    },
  };
}

const openaiModels: readonly ProviderModel[] = [modelOf("gpt-5", "GPT-5", capabilitiesOf({ surfaces: [openaiChat] }))];

describe("ProviderRegistry basic registration", () => {
  test("register, get, list, and unregister round-trip", () => {
    const registry = new ProviderRegistry();
    const openai = adapter("openai", [openaiChat], openaiModels);
    registry.register(openai);
    expect(registry.get("openai")).toBe(openai);
    expect(registry.list()).toEqual([openai]);
    expect(registry.get("missing")).toBeNull();
    expect(registry.unregister("openai")).toBe(true);
    expect(registry.get("openai")).toBeNull();
    expect(registry.unregister("openai")).toBe(false);
  });

  test("duplicate registration of a different adapter throws a typed error", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("openai", [openaiChat], openaiModels));
    expect(() => registry.register(adapter("openai", [openaiChat], openaiModels))).toThrow(ProviderAdapterError);
  });

  test("re-registering the same adapter instance is idempotent", () => {
    const registry = new ProviderRegistry();
    const openai = adapter("openai", [openaiChat], openaiModels);
    registry.register(openai);
    expect(() => registry.register(openai)).not.toThrow();
  });

  test("supportedSurfaces deduplicates across adapters", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("a", ["openai-chat", "native"]));
    registry.register(adapter("b", ["native", "images"]));
    expect([...registry.supportedSurfaces()].sort()).toEqual(["images", "native", "openai-chat"]);
  });
});


describe("ProviderRegistry default provider contract matrix", () => {
  test("every built-in adapter exposes routable metadata and capabilities", async () => {
    const registry = await createDefaultRegistry();
    const adapters = registry.list();
    expect(adapters.length).toBeGreaterThanOrEqual(24);
    expect(adapters.map((provider) => provider.metadata.id)).toEqual(expect.arrayContaining(["groq", "alibaba", "cloudflare", "fireworks"]));
    for (const provider of adapters) {
      expect(provider.metadata.id).toMatch(/^[a-z0-9-]+$/);
      expect(provider.metadata.displayName.length).toBeGreaterThan(0);
      expect(provider.capabilities.surfaces.length).toBeGreaterThan(0);
      expect(typeof provider.resolveTarget).toBe("function");
      expect(typeof provider.call).toBe("function");
      expect(typeof provider.mapError).toBe("function");
    }
  });

  test("built-in provider ids remain unique and deterministic", async () => {
    const first = await createDefaultRegistry();
    const second = await createDefaultRegistry();
    const firstIds = first.list().map((provider) => provider.metadata.id);
    const secondIds = second.list().map((provider) => provider.metadata.id);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(secondIds).toEqual(firstIds);
  });
});

describe("ProviderRegistry default scope (Task 11)", () => {
  test("any explicit adapter id can be registered and routed", () => {
    const registry = new ProviderRegistry();
    for (const id of ["devin", "cursor", "grok"]) {
      const registered = adapter(id, [openaiChat], openaiModels);
      registry.register(registered);
      expect(registry.get(id)).toBe(registered);
      expect(registry.resolveTarget("gpt-5", openaiChat)).toEqual({ providerId: id, modelId: "gpt-5", upstreamModelId: "gpt-5", surface: openaiChat });
      registry.unregister(id);
    }
  });

  test("default registry omits providers that have no active adapter", async () => {
    const registry = await createDefaultRegistry();
    const ids = registry.list().map((item) => item.metadata.id);
    expect(ids).not.toContain("devin");
    expect(ids).not.toContain("cursor");
    expect(ids).not.toContain("grok");
  });
});


describe("ProviderRegistry resolution preserves unknown-model behavior (Task 8)", () => {
  test("unknown model on a supported curated provider throws model_not_found, not success", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("openai", [openaiChat], openaiModels));
    let caughtKind: string | null = null;
    try {
      registry.resolveTarget("gpt-nope", openaiChat);
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProviderAdapterError);
      caughtKind = (caught as ProviderAdapterError).kind;
    }
    expect(caughtKind).toBe("model_not_found");
  });

  test("adapterFor prefers an adapter that knows the model over a first-declared catalog-less one", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("first", [openaiChat]));
    const known = adapter("second", [openaiChat], [modelOf("shared-model", "Shared", capabilitiesOf({ surfaces: [openaiChat] }))]);
    registry.register(known);
    expect(registry.adapterFor("shared-model", openaiChat)).toBe(known);
  });

  test("catalog-less adapters remain permissive and are reachable by unknown model resolution", () => {
    const registry = new ProviderRegistry();
    const router = adapter("router", [openaiChat]);
    registry.register(router);
    expect(registry.resolveTarget("any-upstream-model", openaiChat)).toEqual({ providerId: "router", modelId: "any-upstream-model", upstreamModelId: "any-upstream-model", surface: openaiChat });
  });

  test("translates an Anthropic client surface to an OpenAI chat wire target", () => {
    const registry = new ProviderRegistry();
    registry.register(adapter("openai", [openaiChat], openaiModels));
    expect(registry.resolveTarget("gpt-5", "anthropic-messages")).toEqual({ providerId: "openai", modelId: "gpt-5", upstreamModelId: "gpt-5", surface: "openai-chat" });
  });
});


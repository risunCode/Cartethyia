import { describeOpenAIAdapter, createOpenAIAdapter } from "../open-sse/transport/openai-adapter";
import { describeCursor } from "./cursor/catalog";
import { DEVIN_CATALOG } from "./devin/catalog";
import { ProviderAdapterError, toProviderCallError } from "../open-sse/transport/errors";
import type { ProviderCatalogAdapter } from "../open-sse/transport/contracts";
import type { Adapter, ProviderOutput, ProviderRequest, Surface, RouteTarget } from "../application/contracts";
import { resolveWireSurface } from "../open-sse/translate";

/**
 * Typed ProviderAdapter registry. Registration is id-keyed; resolution
 * prefers adapters whose catalog knows the model, otherwise the first
 * adapter declaring the surface. Unsupported surfaces fail with a typed
 * capability_unsupported error rather than an empty success.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, Adapter>();
  private readonly loaders = new Map<string, () => Promise<Adapter>>();

  register(adapter: Adapter): void {
    const id = adapter.metadata.id;
    const existing = this.adapters.get(id);
    if (existing !== undefined && existing !== adapter) {
      throw new ProviderAdapterError({ kind: "internal_error", message: `Provider "${id}" is already registered`, routeScope: null });
    }
    this.adapters.set(id, adapter);
    this.loaders.delete(id);
  }

  registerLazy(catalog: ProviderCatalogAdapter, loader: () => Promise<Adapter>): void {
    let pending: Promise<Adapter> | null = null;
    const load = (): Promise<Adapter> => {
      if (pending === null) {
        pending = loader().catch((error: unknown) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    };
    const lazy: Adapter = {
      ...catalog,
      async call(input: ProviderRequest): Promise<ProviderOutput> {
        return (await load()).call(input);
      },
      mapError(error: unknown) {
        return toProviderCallError(error);
      },
    };
    this.register(lazy);
    this.loaders.set(catalog.metadata.id, load);
  }

  async prewarm(providerIds: readonly string[]): Promise<void> {
    await Promise.allSettled(providerIds.map((providerId) => this.loaders.get(providerId)?.()));
  }

  get(providerId: string): Adapter | null {
    return this.adapters.get(providerId) ?? null;
  }

  /** Removes a registered adapter (dynamic custom-provider sync). Returns whether it was present. */
  unregister(providerId: string): boolean {
    this.loaders.delete(providerId);
    return this.adapters.delete(providerId);
  }

  list(): readonly Adapter[] {
    return [...this.adapters.values()];
  }

  /** Number of registered adapters — avoids allocating an array just for .length. */
  get size(): number {
    return this.adapters.size;
  }

  supportedSurfaces(): readonly Surface[] {
    const surfaces: Surface[] = [];
    for (const adapter of this.adapters.values()) {
      for (const surface of adapter.capabilities.surfaces) {
        if (!surfaces.includes(surface)) surfaces.push(surface);
      }
    }
    return surfaces;
  }

  adapterFor(modelId: string, surface: Surface): Adapter {
    const declaring = this.list().filter((adapter) => resolveWireSurface(adapter.metadata, adapter.capabilities, surface) !== null);
    if (declaring.length === 0) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `No provider adapter supports surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    const known = declaring.filter((adapter) => adapter.models.get(modelId) !== null);
    const pick = known.length > 0 ? known[0] : declaring[0];
    if (!pick) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `No provider adapter supports surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    return pick;
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    const adapter = this.adapterFor(modelId, surface);
    const wireSurface = resolveWireSurface(adapter.metadata, adapter.capabilities, surface);
    if (wireSurface === null) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${adapter.metadata.id}" cannot translate surface "${surface}"`, statusCode: 400, routeScope: "provider" });
    }
    return adapter.resolveTarget(modelId, wireSurface);
  }
}

/**
 * Composes the default adapter set: OpenAI, Anthropic, the built-in
 * OpenAI-compatible providers. Dynamic imports
 * keep this module free of import cycles with the adapters.
 */
export async function createDefaultRegistry(): Promise<ProviderRegistry> {
  const [
    { OpenAIAdapter },
    { AnthropicAdapter },
    { GeminiAdapter },
    { CloudflareAdapter },
    { OpenCodeFreeAdapter, OpenCodeZenAdapter, OpenCodeGoAdapter },
    { KimchiAdapter },
    { AgentRouterAdapter },
    { ClineAdapter, ClinePassAdapter },
    { AnthropicOAuthAdapter },
    { CodexAdapter },
    { CommandCodeAdapter },
    { QoderAdapter },
    { KiroAdapter },
    { AntigravityAdapter },
    { CodeBuddyAdapter, CodeBuddyChinaAdapter },
    { ExaAdapter },
    { simpleOpenAIConfigs },
    { OllamaAdapter },
    { BlackboxAIAdapter },
  ] = await Promise.all([
    import("./openai"),
    import("./anthropic"),
    import("./gemini"),
    import("./cloudflare"),
    import("./opencode"),
    import("./kimchi"),
    import("./agentrouter"),
    import("./cline"),
    import("./claude-code"),
    import("./codex"),
    import("./commandcode"),
    import("./qoder"),
    import("./kiro"),
    import("./antigravity"),
    import("./codebuddy"),
    import("./exa"),
    import("./openai-compatible"),
    import("./ollama"),
    import("./blackboxai"),
  ]);

  const registry = new ProviderRegistry();
  registry.register(new OpenAIAdapter());
  registry.register(new AnthropicAdapter());
  registry.register(new GeminiAdapter());
  registry.register(new CloudflareAdapter());
  registry.register(new OpenCodeFreeAdapter());
  registry.register(new OpenCodeZenAdapter());
  registry.register(new KimchiAdapter());
  registry.register(new AgentRouterAdapter());
  registry.register(new ClineAdapter());
  registry.register(new ClinePassAdapter());
  registry.register(new AnthropicOAuthAdapter());
  registry.register(new CodexAdapter());
  registry.register(new CommandCodeAdapter());
  registry.register(new QoderAdapter());
  registry.register(new KiroAdapter());
  registry.register(new AntigravityAdapter());
  registry.register(new CodeBuddyAdapter());
  registry.register(new CodeBuddyChinaAdapter());
  registry.register(new ExaAdapter());
  // Keep generated Cursor/Devin protobuf modules out of the baseline process; load them only when a routed request needs the provider.
  registry.registerLazy(DEVIN_CATALOG, async () => {
    const { DevinAdapter } = await import("./devin");
    return new DevinAdapter();
  });
  for (const config of simpleOpenAIConfigs) {
    registry.registerLazy(describeOpenAIAdapter(config), () => Promise.resolve(createOpenAIAdapter(config)));
  }
  registry.register(OllamaAdapter);
  registry.registerLazy(describeCursor(), async () => {
    const { createCursorAdapter } = await import("./cursor");
    return createCursorAdapter();
  });
  registry.register(BlackboxAIAdapter);
  registry.register(OpenCodeGoAdapter);
  return registry;
}
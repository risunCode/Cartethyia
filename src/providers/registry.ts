import { ProviderAdapterError } from "./shared";
import type { ProviderAdapter, ProviderSurface, RouteTarget } from "../domain/contracts";
import { wireSurfaceFor } from "../domain/protocols/translation";

/**
 * Typed ProviderAdapter registry. Registration is id-keyed; resolution
 * prefers adapters whose catalog knows the model, otherwise the first
 * adapter declaring the surface. Unsupported surfaces fail with a typed
 * capability_unsupported error rather than an empty success.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    const id = adapter.metadata.id;
    const existing = this.adapters.get(id);
    if (existing !== undefined && existing !== adapter) {
      throw new ProviderAdapterError({ kind: "internal_error", message: `Provider "${id}" is already registered`, routeScope: null });
    }
    this.adapters.set(id, adapter);
  }

  get(providerId: string): ProviderAdapter | null {
    return this.adapters.get(providerId) ?? null;
  }

  /** Removes a registered adapter (dynamic custom-provider sync). Returns whether it was present. */
  unregister(providerId: string): boolean {
    return this.adapters.delete(providerId);
  }

  list(): readonly ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  /** Number of registered adapters — avoids allocating an array just for .length. */
  get size(): number {
    return this.adapters.size;
  }

  supportedSurfaces(): readonly ProviderSurface[] {
    const surfaces: ProviderSurface[] = [];
    for (const adapter of this.adapters.values()) {
      for (const surface of adapter.capabilities.surfaces) {
        if (!surfaces.includes(surface)) surfaces.push(surface);
      }
    }
    return surfaces;
  }

  adapterFor(modelId: string, surface: ProviderSurface): ProviderAdapter {
    const declaring = this.list().filter((adapter) => wireSurfaceFor(adapter.metadata, adapter.capabilities, surface) !== null);
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

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
    const adapter = this.adapterFor(modelId, surface);
    const wireSurface = wireSurfaceFor(adapter.metadata, adapter.capabilities, surface);
    if (wireSurface === null) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${adapter.metadata.id}" cannot translate surface "${surface}"`, statusCode: 400, routeScope: "provider" });
    }
    return adapter.resolveTarget(modelId, wireSurface);
  }
}

/**
 * Composes the default adapter set: OpenAI, Anthropic, the built-in native
 * (OpenAI-compatible) providers. Dynamic imports
 * keep this module free of import cycles with the adapters.
 */
export async function createDefaultRegistry(): Promise<ProviderRegistry> {
  const [
    { OpenAIAdapter },
    { AnthropicAdapter },
    { GeminiAdapter },
    { NativeAdapter, DEFAULT_NATIVE_PROVIDERS },
    { CloudflareAdapter },
    { OpenCodeFreeAdapter, OpenCodeZenAdapter },
    { KimchiAdapter },
    { AgentRouterAdapter },
    { ClineAdapter, ClinePassAdapter },
    { AnthropicOAuthAdapter },
    { CodexAdapter },
    { CommandCodeAdapter },
    { QoderAdapter },
    { KiroAdapter },
    { GoogleAntigravityAdapter },
    { CodeBuddyAdapter, CodeBuddyChinaAdapter },
    { ExaAdapter },
    { GrokBuildAdapter },
  ] = await Promise.all([
    import("./openai"),
    import("./anthropic"),
    import("./gemini"),
    import("./native"),
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
    import("./google-antigravity"),
    import("./codebuddy"),
    import("./exa"),
    import("./grok-build"),
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
  registry.register(new GoogleAntigravityAdapter());
  registry.register(new CodeBuddyAdapter());
  registry.register(new CodeBuddyChinaAdapter());
  registry.register(new ExaAdapter());
  registry.register(new GrokBuildAdapter());
  for (const config of DEFAULT_NATIVE_PROVIDERS) {
    registry.register(new NativeAdapter(config));
  }
  return registry;
}
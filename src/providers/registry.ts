import { ProviderAdapterError } from "./shared";
import type { Adapter, Surface, RouteTarget } from "../domain/contracts";
import { resolveWireSurface } from "../domain/protocols/translation";

/**
 * Typed ProviderAdapter registry. Registration is id-keyed; resolution
 * prefers adapters whose catalog knows the model, otherwise the first
 * adapter declaring the surface. Unsupported surfaces fail with a typed
 * capability_unsupported error rather than an empty success.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    const id = adapter.metadata.id;
    const existing = this.adapters.get(id);
    if (existing !== undefined && existing !== adapter) {
      throw new ProviderAdapterError({ kind: "internal_error", message: `Provider "${id}" is already registered`, routeScope: null });
    }
    this.adapters.set(id, adapter);
  }

  get(providerId: string): Adapter | null {
    return this.adapters.get(providerId) ?? null;
  }

  /** Removes a registered adapter (dynamic custom-provider sync). Returns whether it was present. */
  unregister(providerId: string): boolean {
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
    { OpenCodeFreeAdapter, OpenCodeZenAdapter },
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
    { GrokBuildAdapter },
    { OpenRouterAdapter },
    { GroqAdapter },
    { AlibabaAdapter },
    { FireworksAdapter },
    { DeepSeekAdapter: DeepSeekNativeAdapter },
    { OllamaAdapter },
    { MistralAdapter },
    { SiliconFlowAdapter },
    { CerebrasAdapter },
    { NvidiaAdapter: NvidiaNativeAdapter },
    { BlackboxAIAdapter },
    { OpenCodeGoAdapter },
    { XiaomiPAYGAdapter },
    { XiaomiTokenPlanAdapter },
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
    import("./grok-build"),
    import("./openrouter"),
    import("./groq"),
    import("./alibaba"),
    import("./fireworks"),
    import("./deepseek"),
    import("./ollama"),
    import("./mistral"),
    import("./siliconflow"),
    import("./cerebras"),
    import("./nvidia"),
    import("./blackboxai"),
    import("./opencodego"),
    import("./xiaomipg"),
    import("./xiaomitp"),
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
  registry.register(new GrokBuildAdapter());
  registry.register(OpenRouterAdapter);
  registry.register(GroqAdapter);
  registry.register(AlibabaAdapter);
  registry.register(FireworksAdapter);
  registry.register(DeepSeekNativeAdapter);
  registry.register(OllamaAdapter);
  registry.register(MistralAdapter);
  registry.register(SiliconFlowAdapter);
  registry.register(CerebrasAdapter);
  registry.register(NvidiaNativeAdapter);
  registry.register(BlackboxAIAdapter);
  registry.register(OpenCodeGoAdapter);
  registry.register(XiaomiPAYGAdapter);
  registry.register(XiaomiTokenPlanAdapter);
  return registry;
}
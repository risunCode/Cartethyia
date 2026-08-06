import { ProviderAdapterError, aggregateCapabilities, capabilitiesOf, createModelCatalog, modelOf, toProviderCallError } from "./shared";
import { callChatCompletionsWire } from "../transport/protocols/openai";
import type {
  ContextStats,
  CredentialKind,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderMetadata,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderSurface,
  RouteTarget,
  TokenCountInput,
} from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";

/**
 * Native adapter: direct fetch-based providers that speak the
 * OpenAI-compatible Chat Completions wire format (OpenRouter, DeepSeek,
 * Ollama, Mistral, SiliconFlow, Cerebras, NVIDIA NIM, Blackbox AI, and
 * configurable custom endpoints). Each instance is configured with its
 * own base URL, auth style, and model catalog.
 */

const NATIVE_SURFACES: readonly ProviderSurface[] = ["openai-chat"];

const NATIVE_FALLBACK_CAPABILITIES: ProviderCapabilities = capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true });

export interface NativeProviderConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly credentialKind: CredentialKind;
  readonly credentialUrl?: string;
  readonly auth?: "bearer" | "x-api-key" | "none";
  readonly models?: readonly ProviderModel[];
  /**
   * Optional mapping applied to the catalog model ID before sending to the
   * upstream API.  Use this when the upstream expects a different ID than
   * what the catalog exposes (e.g. Blackbox catalog uses "gpt-5.4" to avoid
   * routing-prefix collisions, but the Blackbox API needs "openai/gpt-5.4").
   * When unset, the catalog ID is sent as-is.
   */
  readonly mapModelId?: (modelId: string) => string;
}

export class NativeAdapter implements ProviderAdapter {
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  readonly models: ProviderModelCatalog;
  private readonly baseUrl: string;
  private readonly auth: "bearer" | "x-api-key" | "none";
  private readonly mapModelId: ((modelId: string) => string) | null;

  constructor(config: NativeProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    const models = config.models ?? [];
    this.models = createModelCatalog(models);
    this.capabilities = aggregateCapabilities(models, NATIVE_FALLBACK_CAPABILITIES);
    this.metadata = {
      id: config.id,
      displayName: config.displayName,
      protocol: "native",
      credentialKind: config.credentialKind,
      ...(config.credentialUrl ? { credentialUrl: config.credentialUrl } : {}),
    };
    this.auth = config.auth ?? "bearer";
    this.mapModelId = config.mapModelId ?? null;
  }

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    // Native providers accept any model id — the catalog is informational
    // (for /v1/models listing), not a gate. Model ACL and routing already
    // filter ineligible models upstream, so rejecting here only blocks.
    // When a mapModelId is configured, apply it so the upstream API receives
    // the full ID it expects while the catalog keeps short IDs to avoid
    // routing-prefix collisions (e.g. Blackbox: catalog "gpt-5.4" → API "openai/gpt-5.4").
    const upstreamModelId = this.mapModelId ? this.mapModelId(modelId) : modelId;
    return { providerId: this.metadata.id, modelId: upstreamModelId, surface };
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    const { request, credential } = input;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      ...(input.headers?.get("user-agent") ? { "user-agent": input.headers.get("user-agent")! } : {}),
    };
    if (this.auth === "bearer" && credential.length > 0) headers.authorization = `Bearer ${credential}`;
    else if (this.auth === "x-api-key" && credential.length > 0) headers["x-api-key"] = credential;
    // Native providers speak the OpenAI Chat Completions wire format.
    return callChatCompletionsWire(input, this.baseUrl, headers);
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }

  private modelKnown(modelId: string): boolean {
    return this.models.list.length === 0 || this.models.get(modelId) !== null;
  }

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (!this.capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (input.request.stream && !this.capabilities.streaming) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support streaming`,
        statusCode: 400,
        routeScope: null,
      });
    }
  }
}

// ---------------------------------------------------------------- defaults

/**
 * Built-in native provider instances. Empty catalogs (routers, local
 * servers) accept any model id; curated catalogs are advisory for routing.
 */
export const DEFAULT_NATIVE_PROVIDERS: readonly NativeProviderConfig[] = [
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialKind: "api_key",
  },
  {
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    credentialKind: "api_key",
    credentialUrl: "https://console.groq.com/keys",
  },
  {
    id: "alibaba",
    displayName: "Alibaba Cloud / DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    credentialKind: "api_key",
    credentialUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    credentialKind: "api_key",
    credentialUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("deepseek-chat", "DeepSeek V3", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("deepseek-reasoner", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
    ],
  },
  {
    id: "ollama",
    displayName: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("gpt-oss:20b", "GPT-OSS 20B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("gpt-oss:120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("gemma4:31b", "Gemma 4 31B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("minimax-m3", "MiniMax M3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("nemotron-3-super", "Nemotron 3 Super", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    ],
  },
  {
    id: "mistral",
    displayName: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    credentialKind: "api_key",
    models: [
      modelOf("mistral-large-latest", "Mistral Large", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("mistral-small-latest", "Mistral Small", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    ],
  },
  {
    id: "siliconflow",
    displayName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    credentialKind: "api_key",
    models: [
      modelOf("deepseek-ai/DeepSeek-V3", "DeepSeek V3", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("deepseek-ai/DeepSeek-R1", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
      modelOf("Qwen/Qwen3-235B-A22B-Thinking", "Qwen3 Thinking", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    ],
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    credentialKind: "api_key",
    models: [
      modelOf("llama-3.3-70b", "Llama 3.3 70B", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("llama-4-scout-17b-16e-instruct", "Llama 4 Scout", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    ],
  },
  {
    id: "nvidia",
    displayName: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("nvidia/llama-3.1-nemotron-ultra-253b-v1", "Nemotron Ultra 253B", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("deepseek-ai/deepseek-r1", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
    ],
  },
  {
    id: "blackboxai",
    displayName: "Blackbox AI",
    baseUrl: "https://api.blackbox.ai/v1",
    credentialKind: "api_key",
    // Blackbox wraps upstream providers; catalog model IDs for OpenAI models
    // omit the "openai/" prefix to avoid colliding with Cartethyia's routing
    // prefix.  The mapModelId function restores the prefix when sending to
    // the Blackbox API so it routes to the correct upstream.
    mapModelId: (id) => (id.includes("/") ? id : `openai/${id}`),
    models: [
      // Text models — capabilities from models.dev where available.
      modelOf("amazon/nova-2-lite", "Nova 2 Lite", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("amazon/nova-micro", "Nova Micro", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("anthropic/claude-nemotron", "Claude Nemotron", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("arcee-ai/trinity-large-thinking", "Trinity Large Thinking", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("blackbox-pro", "Blackbox Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("google/gemini-3.5-flash", "Gemini 3.5 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("google/gemma-4-31b-it", "Gemma 4 31B IT", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("mistral/codestral", "Codestral", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("minimax/minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("moonshotai/kimi-k3", "Kimi K3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("nvidia/nemotron-3-ultra", "Nemotron 3 Ultra", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("gpt-5.3-codex", "GPT-5.3 Codex", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("gpt-5.4", "GPT-5.4", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("gpt-5.4-nano", "GPT-5.4 Nano", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("gpt-5.5", "GPT-5.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("gpt-nemotron", "GPT Nemotron", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("gpt-oss-120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("x-ai/grok-4.3", "Grok 4.3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("x-ai/grok-build-0.1", "Grok Build 0.1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("z-ai/glm-5.2-vercel", "GLM 5.2 Vercel", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("z-ai/glm-4.7-flash", "GLM 4.7 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("nano-banana-pro/edit", "Nano Banana Pro Edit", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      // Image generation models.
      modelOf("google/imagen-3", "Imagen 3", capabilitiesOf({ surfaces: ["images"] })),
      modelOf("google/imagen-3-fast", "Imagen 3 Fast", capabilitiesOf({ surfaces: ["images"] })),
      modelOf("google/imagen-4", "Imagen 4", capabilitiesOf({ surfaces: ["images"] })),
      modelOf("google/imagen-4-fast", "Imagen 4 Fast", capabilitiesOf({ surfaces: ["images"] })),
      modelOf("google/imagen-4-ultra", "Imagen 4 Ultra", capabilitiesOf({ surfaces: ["images"] })),
      modelOf("google/nano-banana-pro", "Nano Banana Pro", capabilitiesOf({ surfaces: ["images"] })),
    ],
  },
  {
    id: "opencodego",
    displayName: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    credentialKind: "api_key",
    models: [
      modelOf("grok-4.5", "Grok 4.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("kimi-k3", "Kimi K3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
      modelOf("kimi-k2.7-code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("qwen3.7-max", "Qwen 3.7 Max", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("minimax-m3", "MiniMax M3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("hy3", "HY3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    ],
  },
  {
    id: "xiaomipg",
    displayName: "Xiaomi MiMo (PAYG)",
    baseUrl: "https://api.xiaomimimo.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    ],
  },
  {
    id: "xiaomitp",
    displayName: "Xiaomi MiMo (Token Plan)",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    ],
  },
];

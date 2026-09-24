import { GENERIC_API_KEY_SPECS } from "./integrations/configured-openai-providers";
import { createApiKeyAdapter } from "./integrations/configured-provider";
import { ProviderRegistry, toRegistration, type ProviderAuthentication, type ProviderModule } from "./provider-registry";
import type { OAuthLoginClient } from "./authentication/oauth-flow-store";
import type { QuotaFetcher } from "./quota/quota-support";
import { BUNDLED_PROVIDER_METADATA, PROVIDER_COMPATIBILITY_PROFILES, providerRequiresAccount, providerUpstreamHost, providerDefaultWireFamily, type BundledProviderId } from "./provider-metadata";
import { modelsDevCatalog } from "./discovery/models-dev-catalog";
import type { ProviderModelDiscovery } from "./discovery/discovery-types";

/**
 * Builds a lazy OAuth authentication loader from a dynamic module import and the
 * exported client name. The same client usually acts as its own refresher, so
 * `withRefresher` mirrors the client as the refresher.
 */
function oauthCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
  options: { readonly withRefresher?: boolean } = {},
): () => Promise<ProviderAuthentication> {
  return async () => {
    const module = await loader();
    const client = (module as Record<string, unknown>)[exportName as string] as OAuthLoginClient & { refresh: unknown };
    return options.withRefresher
      ? ({ client, refresher: client } as ProviderAuthentication)
      : ({ client } as ProviderAuthentication);
  };
}

/**
 * Builds a lazy quota-collector loader from a dynamic module import and the
 * exported collector function name.
 */
function quotaCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
): () => Promise<QuotaFetcher> {
  return () => loader().then((module) => (module as Record<string, unknown>)[exportName as string] as QuotaFetcher);
}

/** Implementation details merged into the canonical ProviderModule rows. */
type ProviderModuleCapabilities = Partial<Omit<ProviderModule, "loadAdapter">> &
  Pick<ProviderModule, "loadAdapter">;

function configuredProvider(
  providerId: keyof typeof GENERIC_API_KEY_SPECS,
): ProviderModuleCapabilities {
  return {
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS[providerId]),
  };
}

function openAIModelDiscovery(
  providerId: string,
  options?: {
    readonly transformBaseUrl?: (baseUrl: string) => string;
    readonly headers?: (credential: string) => Readonly<Record<string, string>>;
  },
): () => Promise<ProviderModelDiscovery> {
  return async () => async ({ baseUrl, credential, fetcher }) => {
    const { fetchOpenAICompatibleModels } = await import("./discovery/openai-model-discovery");
    return fetchOpenAICompatibleModels({
      baseUrl: options?.transformBaseUrl?.(baseUrl) ?? baseUrl,
      providerId,
      ...(options?.headers ? { headers: options.headers(credential) } : {}),
      ...(fetcher ? { fetcher } : {}),
    });
  };
}

/**
 * Adapter, model, OAuth, and quota behavior keyed by canonical provider ID.
 *
 * Adapter and model references use dynamic `import()` so a provider's module
 * graph — including bespoke protobuf adapters and their large generated
 * declarations — is evaluated on first use rather than at startup. Model
 * catalogs are declared inline in each `api-key/` provider module, so a
 * catalog load evaluates the same module the adapter uses; the dynamic import
 * still keeps that evaluation off the startup path.
 */
export const PROVIDER_CAPABILITIES = {
  openai: {
    endpointPathsByWireFamily: { chat: "/v1/chat/completions", responses: "/v1/responses" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/openai")).OPENAI_SPEC),
    loadModels: async () => (await import("./integrations/openai")).OPENAI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("openai", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  anthropic: {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("./integrations/anthropic")).createAnthropicAdapter(),
    loadModels: async () => (await import("./integrations/anthropic")).ANTHROPIC_MODELS,
    loadModelDiscovery: openAIModelDiscovery("anthropic", { headers: (credential) => ({ "x-api-key": credential, "anthropic-version": "2023-06-01" }) }),
  },
  claude: {
    loadAdapter: async () => (await import("./integrations/claude-code/claude")).claudeAdapter,
    loadModels: async () => (await import("./integrations/claude-code/claude")).CLAUDE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/claude-code/claude-oauth"), "claudeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/claude-code/claude-quota"), "fetchClaudeQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverClaudeModels } = await import("./integrations/claude-code/claude-oauth");
      const { modelIds } = await discoverClaudeModels(credential, ...(fetcher ? [fetcher] : []));
      return modelIds.map((modelId) => ({
        modelId,
        wireFamily: "messages",
        endpointPath: "/v1/messages",
        contextLimit: null,
        outputLimit: null,
        modalities: { input: ["text"], output: ["text"] },
        reasoning: true,
        toolCall: true,
        webSearch: true,
        cost: modelsDevCatalog.costFor("claude", modelId),
      }));
    },
  },
  codex: {
    loadAdapter: async () => (await import("./integrations/codex/codex")).createCodexAdapter({ provider_id: "codex" }),
    loadModels: async () => (await import("./integrations/codex/codex")).CODEX_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/codex/codex-oauth"), "codexOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/codex/codex-quota"), "fetchCodexQuota"),
  },
  grok: {
    loadAdapter: async () => (await import("./integrations/grok/grok")).GrokAdapter,
    loadModels: async () => (await import("./integrations/grok/grok")).GROK_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/grok/grok-oauth"), "grokOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/grok/grok-quota"), "fetchGrokQuota"),
    loadModelDiscovery: async () => async ({ baseUrl, credential, fetcher }) => {
      const discovery = await openAIModelDiscovery("grok", { headers: (token) => ({ authorization: `Bearer ${token}` }) })();
      const models = await discovery({ baseUrl, credential, ...(fetcher ? { fetcher } : {}) });
      if (!models) return null;
      // The advertised allowlist is derived from `GROK_MODELS` rather than
      // restated as a regex here. A second hand-maintained list previously
      // omitted `grok-4.7` while the catalog and the request builder both
      // accepted it, so live discovery silently dropped a model the gateway
      // was willing to serve. Deriving from the catalog keeps one source of
      // truth: a model the adapter serves is a model discovery may advertise.
      const { GROK_MODELS } = await import("./integrations/grok/grok");
      const advertised = new Set(GROK_MODELS.map((model) => model.modelId.toLowerCase()));
      return models.filter((model) => advertised.has(model.modelId.toLowerCase()));
    },
  },
  cursor: {
    loadAdapter: async () => (await import("./integrations/cursor/cursor")).cursorAdapter,
    loadModels: async () => (await import("./integrations/cursor/catalog")).CURSOR_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/cursor/cursor-oauth"), "cursorOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/cursor/cursor-quota"), "fetchCursorQuota"),
  },
  devin: {
    loadAdapter: async () => (await import("./integrations/devin/devin")).devinAdapter,
    loadModels: async () => (await import("./integrations/devin/catalog")).DEVIN_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/devin/devin-oauth"), "devinOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("./integrations/devin/devin-quota"), "fetchDevinQuota"),
  },
  antigravity: {
    loadAdapter: async () => (await import("./integrations/antigravity/antigravity")).antigravityAdapter,
    loadModels: async () => (await import("./integrations/antigravity/antigravity")).ANTIGRAVITY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/antigravity/antigravity-oauth"), "antigravityOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/antigravity/antigravity-quota"), "fetchAntigravityQuota"),
    loadModelDiscovery: async () => async ({ baseUrl, credential, fetcher }) => {
      const { discoverAntigravityModels } = await import("./integrations/antigravity/antigravity-protocol");
      return discoverAntigravityModels(credential, { baseUrl, ...(fetcher ? { fetcher } : {}) });
    },
  },
  muse: {
    loadAdapter: async () => (await import("./integrations/muse/muse")).museCodeAdapter,
    loadModels: async () => (await import("./integrations/muse/muse")).MUSE_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/muse/muse-oauth"), "museCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/muse/muse-quota"), "fetchMuseQuota"),
  },
  kimi: {
    loadAdapter: async () => (await import("./integrations/kimi/kimi")).kimiCodeAdapter,
    loadModels: async () => (await import("./integrations/kimi/kimi")).KIMI_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/kimi/kimi-oauth"), "kimiCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/kimi/kimi-quota"), "fetchKimiQuota"),
  },
  cerebras: {
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/cerebras")).CEREBRAS_SPEC),
    loadModels: async () => (await import("./integrations/cerebras")).CEREBRAS_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/cerebras"), "fetchCerebrasQuota"),
    loadModelDiscovery: openAIModelDiscovery("cerebras", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  groq: configuredProvider("groq"),
  mistral: configuredProvider("mistral"),
  siliconflow: configuredProvider("siliconflow"),
  fireworks: configuredProvider("fireworks"),
  nvidia: configuredProvider("nvidia"),
  gmi: configuredProvider("gmi"),
  opencodeft: {
    // No `messages` path: the adapter declares `supported_wire_families`
    // ["chat", "responses"] and no catalog row uses it, so a probe resolving
    // `messages` would name a family dispatch rejects.
    endpointPathsByWireFamily: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_FREE_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_FREE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencodeft", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/v1` }),
    modelDiscoveryRequiresCredential: false,
  },
  opencodezen: {
    endpointPathsByWireFamily: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_ZEN_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_ZEN_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencodezen", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  opencodego: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_GO_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_GO_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencodego", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/go/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  agentrouter: {
    loadAdapter: async () => (await import("./integrations/agentrouter")).createAgentRouterAdapter(),
    loadModels: async () => (await import("./integrations/agentrouter")).AGENTROUTER_MODELS,
  },
  gemini: {
    loadAdapter: async () => (await import("./integrations/gemini")).createGeminiAdapter(),
    loadModels: async () => (await import("./integrations/gemini")).GEMINI_MODELS,
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/gemini")).discoverGeminiModels({ credential }),
  },
  cloudflare: {
    loadAdapter: async () => (await import("./integrations/cloudflare")).createCloudflareAdapter(),
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/cloudflare")).discoverCloudflareModels({ credential }),
  },
  aihubmix: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/aihubmix")).AIHUBMIX_SPEC),
    loadModels: async () => (await import("./integrations/aihubmix")).AIHUBMIX_FALLBACK_MODELS,
  },
  bai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/bai")).BAI_SPEC),
    loadModels: async () => (await import("./integrations/bai")).BAI_FALLBACK_MODELS,
  },
  tokenharbor: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/tokenharbor")).TOKENHARBOR_SPEC),
    loadModels: async () => (await import("./integrations/tokenharbor")).TOKENHARBOR_FALLBACK_MODELS,
  },
  cline: {
    loadAdapter: async () => (await import("./integrations/cline/cline")).createClineAdapter(),
    loadModels: async () => (await import("./integrations/cline/cline")).CLINE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/cline/cline-oauth"), "clineOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/cline/cline-quota"), "fetchClineQuota"),
    loadModelDiscovery: async () => async ({ fetcher }) => {
      const { fetchClineRecommendedModels } = await import("./integrations/cline/cline");
      return fetchClineRecommendedModels(undefined, true, fetcher ?? globalThis.fetch);
    },
    modelDiscoveryRequiresCredential: false,
  },
  cb: {
    loadAdapter: async () => (await import("./integrations/buddy/codebuddy")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./integrations/buddy/codebuddy")).CODEBUDDY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/codebuddy-oauth"), "codeBuddyOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/codebuddy-quota"), "fetchCodeBuddyIntlQuota"),
  },
  cbcn: {
    loadAdapter: async () => (await import("./integrations/buddy/codebuddy-cn")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./integrations/buddy/codebuddy-cn")).CODEBUDDY_CN_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/codebuddy-oauth"), "codeBuddyCnOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/codebuddy-quota"), "fetchCodeBuddyCnQuota"),
  },
  workbuddy: {
    loadAdapter: async () => (await import("./integrations/buddy/workbuddy")).createWorkBuddyAdapter(),
    loadModels: async () => (await import("./integrations/buddy/workbuddy")).WORKBUDDY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/workbuddy-oauth"), "workBuddyOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/workbuddy-quota"), "fetchWorkBuddyQuota"),
  },
  commandcode: {
    loadAdapter: async () => (await import("./integrations/commandcode")).createCommandCodeAdapter(),
    loadModels: async () => (await import("./integrations/commandcode")).COMMANDCODE_MODELS,
  },
  qoder: {
    loadAdapter: async () => (await import("./integrations/qoder")).createQoderAdapter(),
    loadModels: async () => (await import("./integrations/qoder")).QODER_MODELS,
  },
  inferhub: {
    loadAdapter: async () => (await import("./integrations/inferhub")).createInferhubAdapter(),
    loadModels: async () => (await import("./integrations/inferhub")).INFERHUB_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/inferhub"), "fetchInferhubQuota"),
  },
  hermes: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/hermes")).HERMES_SPEC),
    loadModels: async () => (await import("./integrations/hermes")).HERMES_MODELS,
  },
  openrouter: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/openrouter")).OPENROUTER_SPEC),
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/openrouter")).discoverOpenrouterModels({ credential }),
  },
  xiaomipg: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi")).XIAOMIPG_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi")).XIAOMI_MODELS,
  },
  xiaomitp: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi")).XIAOMITP_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi")).XIAOMI_MODELS,
  },
  zai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/zai/spec")).ZAI_SPEC),
    loadQuotaCollector: quotaCapability(() => import("./integrations/zai/zai-quota"), "fetchZaiQuota"),
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/zai/spec")).discoverZaiModels({ credential }),
  },
  perplexity: {
    loadAdapter: async () => (await import("./integrations/perplexity")).createPerplexityAdapter(),
    loadModels: async () => (await import("./integrations/perplexity")).PERPLEXITY_MODELS,
  },
  ollamacloud: {
    // Only the two families its adapter spec declares. `native` and `messages`
    // were listed here with no catalog row and no support in the adapter, so
    // the probe resolved a wire family that would have been rejected with
    // `capability_unsupported` had a request ever reached dispatch.
    endpointPathsByWireFamily: {
      chat: "/v1/chat/completions",
      responses: "/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS.ollamacloud),
    loadQuotaCollector: quotaCapability(() => import("./integrations/ollama-cloud-quota"), "fetchOllamaQuota"),
    loadModelDiscovery: openAIModelDiscovery("ollamacloud", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
} satisfies Readonly<Record<BundledProviderId, ProviderModuleCapabilities>>;

/** Canonical provider registry; every provider subsystem consumes these rows. */
export const BUNDLED_PROVIDER_MODULES: readonly ProviderModule[] = BUNDLED_PROVIDER_METADATA.map((definition) => {
  const implementation = PROVIDER_CAPABILITIES[definition.id];
  if (implementation === undefined) throw new Error(`Missing provider implementation: ${definition.id}`);
  const compatibility = PROVIDER_COMPATIBILITY_PROFILES[definition.id];
  return {
    id: definition.id,
    displayName: definition.displayName,
    baseUrl: definition.baseUrl,
    defaultBypassProxy: definition.defaultBypassProxy,
    ...implementation,
    upstreamHost: providerUpstreamHost(definition.id),
    ...(compatibility === undefined ? {} : { compatibility }),
    wireFamilyDefault: providerDefaultWireFamily(definition.id),
    requiresAccount: providerRequiresAccount(definition.id),
  };
});

/**
 * Eagerly composes the default provider registry from the canonical
 * bundled module. Registration itself is direct and synchronous; each
 * provider's adapter and model catalog still load lazily through
 * capability loader, so protobuf-heavy adapters stay out of the
 * startup path.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of BUNDLED_PROVIDER_MODULES) {
    registry.register(toRegistration(provider));
  }
  return registry;
}

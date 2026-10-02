import { GENERIC_API_KEY_SPECS } from "./integrations/configured-openai-providers";
import { createApiKeyAdapter } from "./integrations/configured-provider";
import { ProviderRegistry, toRegistration, type ProviderAuthentication, type ProviderModule } from "./provider-registry";
import type { OAuthLoginClient } from "./authentication/oauth-flow-store";
import type { QuotaFetcher } from "./quota/quota-support";
import { BUNDLED_PROVIDER_METADATA, PROVIDER_COMPATIBILITY_PROFILES, providerRequiresAccount, providerUpstreamHost, providerDefaultWireFamily, type BundledProviderId } from "./provider-metadata";
import { defineModel } from "./model-definition";
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
    loadAdapter: async () => (await import("./integrations/claude/claude")).claudeAdapter,
    loadModels: async () => (await import("./integrations/claude/claude")).CLAUDE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/claude/claude-oauth"), "claudeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/claude/claude-quota"), "fetchClaudeQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverClaudeModels } = await import("./integrations/claude/claude-oauth");
      const { modelIds } = await discoverClaudeModels(credential, ...(fetcher ? [fetcher] : []));
      // `defineModel` resolves limits/pricing by model name: an exact catalog
      // row first, then the bare id, then the most-agreed row for that name
      // (date suffixes stripped). The live listing carries dated ids
      // (`claude-sonnet-4-5-20250929`) the catalog files undated, so a name
      // match is what fills their limits — a hardcoded `null` here is what
      // rendered "n/a ctx · n/a out".
      return modelIds.map((modelId) =>
        defineModel({
          id: modelId,
          providerId: "claude",
          wireFamily: "messages",
          endpoint: "/v1/messages",
          vision: true,
          reasoning: true,
          toolCall: true,
          webSearch: true,
        }),
      );
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
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/grok/grok")).fetchGrokModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
  },
  xai: {
    endpointPathsByWireFamily: { responses: "/responses" },
    loadAdapter: async () => (await import("./integrations/xai/xai")).xaiAdapter,
    loadModels: async () => (await import("./integrations/xai/xai")).XAI_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/xai/xai-oauth"), "xaiOAuthClient", { withRefresher: true }),
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/xai/xai-discovery")).discoverXaiModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
  },
  devin: {
    loadAdapter: async () => (await import("./integrations/devin/devin")).devinAdapter,
    loadModels: async () => (await import("./integrations/devin/devin-catalog")).DEVIN_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/devin/devin-oauth"), "devinOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("./integrations/devin/devin-quota"), "fetchDevinQuota"),
    // Devin's catalog is per-account: `GetCliModelConfigs` answers with the
    // models the credential's plan reaches, so the static row is only the
    // offline seed and discovery needs the credential.
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/devin/devin")).fetchDevinModels(
        credential,
        ...(fetcher === undefined ? [] : [fetcher as typeof fetch]),
      ),
    modelDiscoveryRequiresCredential: true,
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
  meta: {
    loadAdapter: async () => (await import("./integrations/meta/meta")).metaAdapter,
    loadModels: async () => (await import("./integrations/meta/meta")).META_MODELS,
    // No `loadAuthentication`: the Model API is a plain API key pasted from the
    // Meta developer dashboard, so the default key-only credential path applies
    // and `probeApiKeyConnectivity` is the account test.
  },
  kiro: {
    loadAdapter: async () => (await import("./integrations/kiro/kiro")).kiroAdapter,
    loadModels: async () => (await import("./integrations/kiro/kiro-catalog")).KIRO_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/kiro/kiro-oauth"), "kiroOAuthClient", {
      withRefresher: true,
    }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/kiro/kiro-quota"), "fetchKiroQuota"),
    // Kiro's model list is per-account: which models a credential reaches
    // depends on the plan it is bound to, so discovery needs the credential and
    // the account's region.
    loadModelDiscovery: async () => async ({ credential, fetcher, authState }) =>
      (await import("./integrations/kiro/kiro-discovery")).fetchKiroModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
        ...(authState === undefined ? {} : { authState }),
      }),
    modelDiscoveryRequiresCredential: true,
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
  mistral: configuredProvider("mistral"),
  fireworks: configuredProvider("fireworks"),
  nvidia: configuredProvider("nvidia"),
  deepseek: {
    ...configuredProvider("deepseek"),
    // The host serves a standard `/v1/models`, verified live, so the shared
    // fetcher reads it as-is and the base catalog supplies limits and pricing
    // for the ids it already files under `deepseek`.
    loadModelDiscovery: openAIModelDiscovery("deepseek", {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  huggingface: {
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/huggingface")).HUGGINGFACE_SPEC),
    // The router listing nests limits and capability under `providers[]`, so it
    // cannot go through the shared OpenAI `/models` fetcher.
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/huggingface")).discoverHuggingfaceModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
  },
  gmi: configuredProvider("gmi"),
  opencodeft: {
    // Only the two families this provider's catalog actually serves. The
    // registry map is what discovery and probing read, so listing `messages`
    // here would resolve a probe onto a wire with no endpoint path and no
    // catalog row behind it.
    endpointPathsByWireFamily: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_FREE_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_FREE_MODELS,
    // Free-tier filtered, unlike the generic OpenAI discovery: this provider
    // serves the free tier only, and the shared Zen listing publishes the whole
    // billed catalog alongside it.
    loadModelDiscovery: async () => async ({ baseUrl, fetcher }) => {
      const { discoverOpenCodeFreeModels } = await import("./integrations/opencode");
      return discoverOpenCodeFreeModels({
        baseUrl: `${baseUrl.replace(/\/+$/, "")}/zen/v1`,
        ...(fetcher === undefined ? {} : { fetcher }),
      });
    },
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
    // The billed Go tier serves the same two wire families as the shared Zen
    // base, under its own `/zen/go/v1` prefix. Declaring them here is what the
    // endpoint-parity test guards against the catalog's own rows: without the
    // map this provider declared no paths at all, so its gate was a no-op.
    endpointPathsByWireFamily: {
      chat: "/zen/go/v1/chat/completions",
      responses: "/zen/go/v1/responses",
    },
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
      // `pass: false` reads only `recommended` + `free`. This gateway carries
      // Cline as one provider, and discovery persists whatever the resolver
      // returns for every account of it, so asking for the pass roster wrote
      // subscription rows into the catalog of an operator who may hold no pass
      // — rows whose dispatch can only 401. The free tier is what this
      // discovery is for; a pass account reconciles the rest through the same
      // "Fetch models" action once the roster has a home of its own.
      return fetchClineRecommendedModels(undefined, false, fetcher ?? globalThis.fetch);
    },
    modelDiscoveryRequiresCredential: false,
  },
  cb: {
    loadAdapter: async () => (await import("./integrations/buddy/codebuddy")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./integrations/buddy/codebuddy")).CODEBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) => (await import("./integrations/buddy/codebuddy")).discoverCodeBuddyModels({ credential, ...(fetcher === undefined ? {} : { fetcher }) }),
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/codebuddy-oauth"), "codeBuddyOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/codebuddy-quota"), "fetchCodeBuddyIntlQuota"),
  },
  cbcn: {
    loadAdapter: async () => (await import("./integrations/buddy/codebuddy-cn")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./integrations/buddy/codebuddy-cn")).CODEBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) => (await import("./integrations/buddy/codebuddy-cn")).discoverCodeBuddyCnModels({ credential, ...(fetcher === undefined ? {} : { fetcher }) }),
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/codebuddy-oauth"), "codeBuddyCnOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/codebuddy-quota"), "fetchCodeBuddyCnQuota"),
  },
  workbuddy: {
    loadAdapter: async () => (await import("./integrations/buddy/workbuddy")).createWorkBuddyAdapter(),
    loadModels: async () => (await import("./integrations/buddy/workbuddy")).WORKBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) => (await import("./integrations/buddy/workbuddy")).discoverWorkBuddyModels({ credential, ...(fetcher === undefined ? {} : { fetcher }) }),
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/workbuddy-oauth"), "workBuddyOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/workbuddy-quota"), "fetchWorkBuddyQuota"),
  },
  kilo: {
    loadAdapter: async () => (await import("./integrations/kilo/kilo")).kiloAdapter,
    loadModels: async () => (await import("./integrations/kilo/kilo")).KILO_MODELS,
    // No `withRefresher`: Kilo Code has no refresh grant, so this client
    // declares no refresher and the stored token is used exactly as issued.
    // Registering one would make the 401 retry path call a method that always
    // throws, turning a recoverable auth failure into a permanent one.
    loadAuthentication: oauthCapability(() => import("./integrations/kilo/kilo-oauth"), "kiloOAuthClient"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/kilo/kilo-discovery")).discoverKiloModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
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
    loadModels: async () => (await import("./integrations/openrouter")).OPENROUTER_MODELS,
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/openrouter")).discoverOpenrouterModels({ credential }),
    // No `withRefresher`: the PKCE exchange returns a durable API key rather
    // than an access token, so there is no refresh grant to register. The key
    // is stored as an ordinary credential and forwarded as the bearer, which is
    // why the same adapter serves the pasted-key and signed-in cases.
    loadAuthentication: oauthCapability(() => import("./integrations/openrouter-oauth"), "openrouterOAuthClient"),
  },
  xiaomipg: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMIPG_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMI_MODELS,
  },
  xiaomitp: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMITP_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi-mimo/xiaomi")).XIAOMI_MODELS,
  },
  mimodesktop: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi-mimo/mimodesktop")).MIMODESKTOP_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi-mimo/mimodesktop")).MIMODESKTOP_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/xiaomi-mimo/mimodesktop-oauth"), "mimoDesktopOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/xiaomi-mimo/mimodesktop-quota"), "fetchMimoDesktopQuota"),
  },
  mimostudio: {
    loadAdapter: async () => (await import("./integrations/xiaomi-mimo/mimostudio")).createMimoStudioAdapter(),
    loadModels: async () => (await import("./integrations/xiaomi-mimo/mimostudio")).MIMOSTUDIO_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/xiaomi-mimo/mimostudio-oauth"), "mimoStudioOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/xiaomi-mimo/mimostudio-quota"), "fetchMimoStudioQuota"),
  },
  zai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/zai/zai")).ZAI_SPEC),
    loadQuotaCollector: quotaCapability(() => import("./integrations/zai/zai-quota"), "fetchZaiQuota"),
    loadModelDiscovery: async () => async ({ credential }) => (await import("./integrations/zai/zai")).discoverZaiModels({ credential }),
  },
  zcode: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/zcode")).ZCODE_SPEC),
    loadModels: async () => (await import("./integrations/zcode")).ZCODE_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/zcode")).discoverZcodeModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    // No `withRefresher`: the sign-in flow ends by minting a durable API key,
    // and Z.AI publishes no refresh grant for it (`refresh "none"` upstream).
    loadAuthentication: oauthCapability(() => import("./integrations/zcode-oauth"), "zcodeOAuthClient"),
  },
  perplexity: {
    loadAdapter: async () => (await import("./integrations/perplexity")).createPerplexityAdapter(),
    loadModels: async () => (await import("./integrations/perplexity")).PERPLEXITY_MODELS,
  },
  // Web-search providers: a `createSearchAdapter` over their spec, and a single
  // `serviceKind: "websearch"` catalog row served by the `/v1/search` route.
  exa: {
    loadAdapter: async () =>
      (await import("./search/search-provider")).createSearchAdapter(
        (await import("./search/search-providers")).SEARCH_PROVIDER_SPECS.exa,
      ),
    loadModels: async () => (await import("./search/search-catalog")).EXA_SEARCH_MODELS,
  },
  tavily: {
    loadAdapter: async () =>
      (await import("./search/search-provider")).createSearchAdapter(
        (await import("./search/search-providers")).SEARCH_PROVIDER_SPECS.tavily,
      ),
    loadModels: async () => (await import("./search/search-catalog")).TAVILY_SEARCH_MODELS,
  },
  brave: {
    loadAdapter: async () =>
      (await import("./search/search-provider")).createSearchAdapter(
        (await import("./search/search-providers")).SEARCH_PROVIDER_SPECS.brave,
      ),
    loadModels: async () => (await import("./search/search-catalog")).BRAVE_SEARCH_MODELS,
  },
  "github": {
    // Chat only. Copilot also serves some SKUs on `/responses`, but those arrive
    // through discovery, which carries its own endpoint path with the wire
    // family it read from `supported_endpoints` — this map is the static floor,
    // and the static catalog is all chat.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => (await import("./integrations/github/github")).githubAdapter,
    loadModels: async () => (await import("./integrations/github/github")).GITHUB_MODELS,
    // The Copilot token is short-lived and re-minted from the GitHub token the
    // device flow issued, so this provider registers a real refresher.
    loadAuthentication: oauthCapability(() => import("./integrations/github/github-oauth"), "githubOAuthClient", { withRefresher: true }),
    // The account's own `/models` is authoritative: it names the SKUs the
    // subscription may use and the surface each answers on.
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/github/github-discovery")).discoverGithubModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/github/github-quota"), "fetchGithubQuota"),
  },
  ollamacloud: {
    // Only the two families this provider's catalog actually serves. The
    // registry map is what discovery and probing read, so listing `messages`
    // here would resolve a probe onto a wire with no endpoint path and no
    // catalog row behind it.
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

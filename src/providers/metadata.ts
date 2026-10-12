import type { ServiceKind, WireFamily } from "../protocol/canonical-model";

/** [OI]-compatible wire overrides persisted for bundled and BYOK providers. */
export interface CompatibilityProfile {
  readonly extra_headers?: Readonly<Record<string, string>>;
  readonly extra_query_params?: Readonly<Record<string, string>>;
  readonly endpoint_paths_by_wire_family?: Partial<Record<WireFamily, string>>;
  readonly streaming_usage_mode?: "include_usage" | "none";
  readonly structured_output?: { readonly mode: "json_object" | "json_schema"; readonly enabled: boolean; readonly schema?: Record<string, unknown> };
  readonly model_wire_families?: ReadonlyArray<{
    readonly pattern: string;
    readonly wire_family: WireFamily;
  }>;
  /** Whether requests to [OI]/Anthropic-compatible upstream should send official CLI headers. Defaults to true. */
  readonly cli_identity?: boolean;
  /**
   * Opts this provider into the gateway identity (`user-agent:
   * `Cartethyia/<version>`) instead of official CLI cloaking. Explicit only:
   * Codex/Claude-Code-shaped traffic can never take this path, and unsetting
   * it restores CLI headers. Persisted on the provider row for BYOK rows;
   * bundled specs declare it on `ApiKeyProviderSpec.gatewayUserAgent`.
   */
  readonly gateway_user_agent?: boolean;
}

/** Identity and routing defaults for every builtin provider. */
const RAW_BUNDLED_PROVIDER_METADATA = [
  { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com", credentialUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", wireFamilyDefault: "messages", credentialUrl: "https://console.anthropic.com/settings/keys" },
  {
    id: "claude",
    displayName: "Claude Code",
    baseUrl: "https://api.anthropic.com",
    wireFamilyDefault: "messages",
    hasAdapterUserAgent: true,
    credentialUrl: "https://claude.ai",
    credentialHint: "Signed in with a Claude subscription account; there is no key to paste.",
  },
  {
    id: "codex",
    displayName: "Codex ChatGPT",
    baseUrl: "https://chatgpt.com",
    serviceKinds: ["llm", "websearch", "imageGeneration"],
    wireFamilyDefault: "responses",
    hasAdapterUserAgent: true,
    credentialUrl: "https://chatgpt.com",
    credentialHint: "Signed in with a ChatGPT account; there is no key to paste.",
  },
  {
    id: "grok",
    displayName: "Grok Build",
    baseUrl: "https://cli-chat-proxy.grok.com",
    hasAdapterUserAgent: true,
    credentialUrl: "https://x.ai",
    credentialHint: "Signed in with an xAI account; the CLI uses subscription credits rather than a key.",
    // Published by xAI at https://auth.x.ai/.well-known/openid-configuration;
    // access tokens that are JWTs are verified against these before an account
    // is persisted. Opaque tokens pass through and are validated by the issuer.
    jwtVerification: {
      issuer: "https://auth.x.ai",
      jwksUrl: "https://auth.x.ai/.well-known/jwks.json",
    },
  },
  {
    // The paid xAI API reached with a SuperGrok / X Premium+ subscription token.
    // Distinct from `grok`, which is the Grok Build free CLI surface: different
    // base URL, different header set, different model roster. Same issuer and
    // therefore the same JWKS.
    id: "xai",
    displayName: "xAI Grok Subscription",
    baseUrl: "https://api.x.ai/v1",
    wireFamilyDefault: "responses",
    credentialUrl: "https://console.x.ai/account/api-keys",
    jwtVerification: {
      issuer: "https://auth.x.ai",
      jwksUrl: "https://auth.x.ai/.well-known/jwks.json",
    },
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    hasAdapterUserAgent: true,
    serviceKinds: ["llm", "websearch", "imageGeneration"],
    credentialUrl: "https://antigravity.google",
    credentialHint: "Signed in with a Google account through the Antigravity login flow.",
  },
  { id: "muse", displayName: "Muse Code", baseUrl: "https://api.meta.ai" },
  {
    // Meta's first-party Model API reached with a direct API key — distinct
    // from `muse` (Muse Code), which is the same `api.meta.ai/v1` Responses
    // wire behind a subscription-minted key from an OAuth device login. The
    // Model API is authenticated with an operator-supplied key from the Meta
    // developer dashboard, so it is an API-key provider, not an OAuth one.
    id: "meta",
    displayName: "Meta Model API",
    baseUrl: "https://api.meta.ai",
    wireFamilyDefault: "responses",
    credentialUrl: "https://developer.meta.com/ai/",
    credentialHint: "Create or copy a Model API key from the Meta developer dashboard.",
  },
  {
    // Kiro frames its own conversation ledger over an AWS EventStream wire and
    // has no chat-shaped endpoint to route through.
    id: "kiro",
    displayName: "Kiro",
    baseUrl: "https://q.us-east-1.amazonaws.com",
    bespokeWire: true,
    hasAdapterUserAgent: true,
    credentialUrl: "https://kiro.dev",
    credentialHint: "Sign in with Google or GitHub in the browser, or use the device-code login with an Identity Center organization, then paste a Kiro API key if you prefer. Prompt caching is not reliably working for Kiro: the upstream recomputes the prompt on every turn, so cached-token savings should not be expected.",
  },
  { id: "kimi", displayName: "Kimi Code", baseUrl: "https://api.kimi.com/coding", credentialUrl: "https://platform.moonshot.ai/console/api-keys" },
  { id: "opencodeft", displayName: "OpenCode Free", baseUrl: "https://opencode.ai", requiresAccount: false, ipScopedRateLimit: true, hasAdapterUserAgent: true },
  { id: "opencodezen", displayName: "OpenCode Zen", baseUrl: "https://opencode.ai", hasAdapterUserAgent: true, credentialUrl: "https://opencode.ai/auth" },
  { id: "opencodego", displayName: "OpenCode Go", baseUrl: "https://opencode.ai", credentialUrl: "https://opencode.ai/auth" },
  { id: "cerebras", displayName: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", credentialUrl: "https://cloud.cerebras.ai/platform" },
  { id: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", credentialUrl: "https://openrouter.ai/settings/keys" },
  { id: "mistral", displayName: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", credentialUrl: "https://console.mistral.ai/api-keys" },
  { id: "fireworks", displayName: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", credentialUrl: "https://fireworks.ai/account/api-keys" },
  { id: "nvidia", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", credentialUrl: "https://build.nvidia.com/settings/api-keys" },
  // DeepSeek serves the Anthropic Messages wire at its own `/anthropic` root;
  // the base URL stays the OpenAI-compatible host for `/v1/models` discovery,
  // and the registry pins the Messages endpoint separately.
  { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", wireFamilyDefault: "messages", credentialUrl: "https://platform.deepseek.com/api_keys" },
  { id: "gmi", displayName: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1", credentialUrl: "https://console.gmicloud.ai" },

  // OpenAI-compatible bearer aggregators. Each is a bare host already rooted at
  // its own version prefix, so the `/v1`-prefixed wire paths stay pinned by the
  // shared generic spec. Every one of these carries live `/v1/models` discovery
  // instead of a hand-maintained catalog — see `default-registry.ts` — so the
  // model list tracks upstream rather than this file.
  { id: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", credentialUrl: "https://console.groq.com/keys" },
  { id: "together", displayName: "Together AI", baseUrl: "https://api.together.xyz/v1", credentialUrl: "https://api.together.ai/settings/api-keys" },
  { id: "deepinfra", displayName: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", credentialUrl: "https://deepinfra.com/api_keys" },
  { id: "siliconflow", displayName: "SiliconFlow", baseUrl: "https://api.siliconflow.com/v1", credentialUrl: "https://cloud.siliconflow.cn/account/ak" },
  { id: "siliconflowcn", displayName: "SiliconFlow CN", baseUrl: "https://api.siliconflow.cn/v1", credentialUrl: "https://cloud.siliconflow.cn/account/ak" },
  { id: "novita", displayName: "Novita AI", baseUrl: "https://api.novita.ai/v3/openai", credentialUrl: "https://novita.ai/dashboard/key" },
  { id: "venice", displayName: "Venice AI", baseUrl: "https://api.venice.ai/api/v1", credentialUrl: "https://venice.ai/api-keys" },
  { id: "nanogpt", displayName: "NanoGPT", baseUrl: "https://api.nano-gpt.com/v1", credentialUrl: "https://nanogpt.com/api-keys" },
  { id: "baseten", displayName: "Baseten", baseUrl: "https://inference.baseten.co/v1", credentialUrl: "https://app.baseten.co/settings/api_keys" },
  { id: "synthetic", displayName: "Synthetic", baseUrl: "https://api.synthetic.new/v1", credentialUrl: "https://app.synthetic.new/api-keys" },
  { id: "stepfun", displayName: "StepFun", baseUrl: "https://api.stepfun.com/v1", credentialUrl: "https://platform.stepfun.com/console/keys" },
  { id: "sakana", displayName: "Sakana AI", baseUrl: "https://api.sakana.ai/v1", credentialUrl: "https://console.sakana.ai/api-keys" },
  { id: "helmcode", displayName: "HelmCode", baseUrl: "https://api.helmcode.com/v1", credentialUrl: "https://helmcode.com/dashboard" },
  { id: "coralbricks", displayName: "CoralBricks", baseUrl: "https://api.coralbricks.com/v1", credentialUrl: "https://coralbricks.com/api-keys" },
  { id: "aiand", displayName: "ai&", baseUrl: "https://api.aiand.com/v1", credentialUrl: "https://console.aiand.com/api-keys" },
  { id: "wafer", displayName: "Wafer Serverless", baseUrl: "https://pass.wafer.ai/v1", credentialUrl: "https://app.wafer.ai/usage" },

  // Providers that are plain bearers on the wire but need one thing the shared
  // spec cannot express.
  {
    // CoreWeave rejects every request that omits `OpenAI-Project: <team>/<project>`,
    // so a bearer key alone is never sufficient. The value is per-account, so it
    // is persisted in the account's `auth_state` and injected per dispatch
    // rather than declared as a static header — one deployment may hold
    // accounts on different teams. See the registry row.
    id: "coreweave",
    displayName: "CoreWeave Serverless",
    baseUrl: "https://api.inference.wandb.ai/v1",
    credentialUrl: "https://wandb.ai/settings",
    credentialHint:
      "Also set your CoreWeave project as <team>/<project> on the account; every request without the OpenAI-Project header is refused.",
  },
  {
    // Routes at Zhipu's dedicated coding-plan surface rather than the general
    // BigModel endpoint, so calls bill against plan quota and not account
    // balance. Same base URL as the general product, different path prefix.
    id: "zhipucoding",
    displayName: "Zhipu Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    credentialUrl: "https://bigmodel.cn/coding-plan/personal/overview",
  },
  {
    // Fireworks' Fire Pass subscription tier: the same host and wire as
    // `fireworks`, reached with a Fire Pass key. Registered separately so the
    // two tiers can hold different accounts and different model rosters.
    id: "firepass",
    displayName: "Fireworks Fire Pass",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    credentialUrl: "https://fireworks.ai/account/api-keys",
    credentialHint: "Requires a Fire Pass subscription key, not a pay-as-you-go key.",
  },
  {
    // Qwen Portal rejects a request carrying more than one system message with a
    // 500 from its default chat template, so the registry coalesces them.
    id: "qwen-portal",
    displayName: "Qwen Portal",
    baseUrl: "https://portal.qwen.ai/v1",
    credentialUrl: "https://chat.qwen.ai",
  },
  {
    // MiniMax serves its models over the Anthropic Messages wire at an
    // `/anthropic` root, not the OpenAI chat wire. The token plans are the same
    // surface with a subscription key rather than a pay-as-you-go one, so they
    // are separate ids rather than one provider with two key kinds — their
    // quotas and their rosters are reported separately.
    id: "minimax",
    displayName: "MiniMax",
    baseUrl: "https://api.minimax.io/anthropic",
    wireFamilyDefault: "messages",
    credentialUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    id: "minimaxcode",
    displayName: "MiniMax Token Plan",
    baseUrl: "https://api.minimax.io/anthropic",
    wireFamilyDefault: "messages",
    credentialUrl: "https://platform.minimax.io/subscribe/token-plan",
    credentialHint: "Requires a Token Plan subscription key, not a pay-as-you-go key.",
  },
  {
    id: "minimaxcodecn",
    displayName: "MiniMax Token Plan (China)",
    baseUrl: "https://api.minimaxi.com/anthropic",
    wireFamilyDefault: "messages",
    credentialUrl: "https://platform.minimaxi.com/subscribe/token-plan",
    credentialHint: "Mainland China endpoint; keys are not interchangeable with the international plan.",
  },
  {
    // Umans is an Anthropic-Messages gateway that authenticates with
    // `x-api-key` rather than a bearer envelope.
    id: "umans",
    displayName: "UMANS Coding Plan",
    baseUrl: "https://api.code.umans.ai",
    wireFamilyDefault: "messages",
    credentialUrl: "https://umans.ai",
  },
  {
    // Baidu's OpenAI-compatible surface is rooted at `/v2`, not `/v1`, so its
    // chat path is `/chat/completions` below that root. It therefore cannot use
    // the shared generic spec; the registry row pins the paths explicitly.
    id: "qianfan",
    displayName: "Qianfan",
    baseUrl: "https://qianfan.baidubce.com/v2",
    credentialUrl: "https://console.bce.baidu.com/qianfan/ais/console/apiKey",
  },
  {
    // The Z.AI Coding Plan subscription endpoint is a dedicated coding-plan
    // surface: different base path, a durable key minted by the sign-in flow,
    // and a different catalog.
    id: "zcode",
    displayName: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    credentialUrl: "https://chat.z.ai",
  },
  {
    // Factory Droid's LLM proxy. The base URL is the global residency host; an
    // EU account resolves to `api.eu.factory.ai` from the region recorded in
    // account state, because the two hosts serve different accounts.
    id: "factory",
    displayName: "Factory Droid",
    baseUrl: "https://api.factory.ai",
    credentialUrl: "https://app.factory.ai",
  },
  {
    // A gateway rather than a model host: the account and gateway slugs are
    // path segments of the base URL and are stored with the token, so the
    // origin below is the root the per-account URL is built from.
    id: "cloudflareai",
    displayName: "Cloudflare AI Gateway",
    baseUrl: "https://gateway.ai.cloudflare.com",
    credentialUrl: "https://dash.cloudflare.com/ai-gateway",
  },
  {
    // Alibaba DashScope, the mainland host. Distinct from `alibabacp` (the
    // Token Plan, on `token-plan.*.maas.aliyuncs.com`); the international
    // DashScope host is `coding-intl.dashscope.aliyuncs.com`. Both are
    // `/v1`-rooted, so the chat path is declared below that root.
    id: "dashscope",
    displayName: "Alibaba DashScope",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    credentialUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    // Alibaba Token Plan. Two plans exist — international and mainland China —
    // on different hosts whose keys are not interchangeable. The region travels
    // with the token; the default below is the international host.
    id: "alibabacp",
    displayName: "Alibaba Coding Plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    credentialUrl: "https://bailian.console.aliyun.com/",
  },
  { id: "hermes", displayName: "Nous Research", baseUrl: "https://inference-api.nousresearch.com/v1", credentialUrl: "https://portal.nousresearch.com" },
  { id: "bai", displayName: "B.AI", baseUrl: "https://api.b.ai/v1", credentialUrl: "https://b.ai" },
  { id: "inferhub", displayName: "InferHub", baseUrl: "https://api.inferhub.dev/v1", defaultSkipProxy: true },
  { id: "aihubmix", displayName: "AiHubMix", baseUrl: "https://aihubmix.com/v1", credentialUrl: "https://aihubmix.com/token" },
  { id: "tokenharbor", displayName: "TokenHarbor", baseUrl: "https://tokenharbor.ai/v1", credentialUrl: "https://tokenharbor.ai" },
  { id: "agentrouter", displayName: "AgentRouter", baseUrl: "https://agentrouter.org", hasAdapterUserAgent: true, credentialUrl: "https://agentrouter.org" },
  { id: "cline", displayName: "Cline", baseUrl: "https://api.cline.bot/api/v1", hasAdapterUserAgent: true, defaultSkipProxy: true, credentialUrl: "https://app.cline.bot" },
  { id: "cb", displayName: "CodeBuddy", baseUrl: "https://www.codebuddy.ai/v2", hasAdapterUserAgent: true, serviceKinds: ["llm", "imageGeneration", "videoGeneration"], credentialUrl: "https://www.codebuddy.ai", credentialHint: "Sign in with the same CodeBuddy account you use in the desktop app." },
  { id: "cbcn", displayName: "CodeBuddy CN", baseUrl: "https://copilot.tencent.com/v2", hasAdapterUserAgent: true, credentialUrl: "https://copilot.tencent.com", credentialHint: "Sign in with the same CodeBuddy China account you use in the desktop app." },
  { id: "workbuddy", displayName: "WorkBuddy", baseUrl: "https://www.workbuddy.ai", hasAdapterUserAgent: true, serviceKinds: ["llm", "imageGeneration", "videoGeneration"], credentialUrl: "https://www.workbuddy.ai", credentialHint: "Sign in with the same WorkBuddy account you use in the desktop app." },
  {
    // Kilo Code resells the OpenRouter catalog. The base URL carries the API's
    // path prefix (`/api/openrouter`) and every model row carries only the wire
    // suffix, matching how Cline's `/api/v1` base is declared — the alternative
    // (origin base, absolute path on each row) would put the same path in two
    // declarations that can drift.
    id: "kilo",
    displayName: "Kilo Code",
    baseUrl: "https://api.kilo.ai/api/openrouter",
    credentialUrl: "https://app.kilo.ai/device-auth",
  },
  {
    // Command Code's adapter stamps its own client identity headers
    // (`x-command-code-version`, `x-cli-environment`, `x-session-id`) and never
    // reads the route User-Agent, so the Routing Strategy panel must not offer
    // a custom User-Agent for it — the field would be silently ignored.
    id: "commandcode",
    displayName: "Command Code",
    baseUrl: "https://api.commandcode.ai/alpha/generate",
    hasAdapterUserAgent: true,
    credentialUrl: "https://commandcode.ai/studio",
    credentialHint: "Use the API key from the Command Code CLI, or create one in the studio.",
  },
  { id: "qoder", displayName: "Qoder", baseUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1", hasAdapterUserAgent: true, credentialUrl: "https://qoder.com/account/integrations", credentialHint: "Paste a Personal Access Token (pt-...) from the Qoder integrations page, or sign in with your Qoder account." },
  { id: "ollamacloud", displayName: "Ollama Cloud", baseUrl: "https://ollama.com/v1", credentialUrl: "https://ollama.com/settings/keys" },
  { id: "gemini", displayName: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", serviceKinds: ["llm", "websearch", "imageGeneration"], credentialUrl: "https://aistudio.google.com/app/apikey" },
  { id: "xiaomipg", displayName: "Xiaomi MiMo (PAYG)", baseUrl: "https://api.xiaomimimo.com/v1", credentialUrl: "https://platform.xiaomimimo.com" },
  { id: "xiaomitp", displayName: "Xiaomi MiMo (Token Plan)", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", credentialUrl: "https://platform.xiaomimimo.com" },
  { id: "mimodesktop", displayName: "MiMo Desktop", baseUrl: "https://api.xiaomimimo.com/v1", credentialUrl: "https://platform.xiaomimimo.com" },
  { id: "mimostudio", displayName: "MiMo Studio", baseUrl: "https://aistudio.xiaomimimo.com", credentialUrl: "https://aistudio.xiaomimimo.com", credentialHint: "Paste the browser cookies exported from a signed-in MiMo Studio session." },
  {
    // GitHub Copilot. The registered base URL is the Individual API host and is
    // only a fallback: the account's real host is read out of the Copilot
    // token's `proxy-ep` claim at dispatch, because an enterprise account is
    // served from a different host than an Individual one.
    id: "github",
    displayName: "GitHub Copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    hasAdapterUserAgent: true,
    credentialUrl: "https://github.com/settings/copilot",
  },
  { id: "perplexity", displayName: "Perplexity", baseUrl: "https://api.perplexity.ai", credentialUrl: "https://www.perplexity.ai/settings/api" },
  // Native web-search providers expose only the search service. Their catalog
  // rows are served by `/v1/search`, never by the canonical chat pipeline.
  { id: "exa", displayName: "Exa", baseUrl: "https://mcp.exa.ai", serviceKinds: ["websearch"], requiresAccount: false, credentialHint: "No API key. Search goes through the public MCP." },
  { id: "parallel", displayName: "Parallel", baseUrl: "https://search.parallel.ai", serviceKinds: ["websearch"], requiresAccount: false, credentialUrl: "https://platform.parallel.ai/settings?tab=api-keys", credentialHint: "Optional. Leave empty for the public MCP, or paste an API key for the higher-limit search API." },
] as const;

/**
 * Providers whose adapter drives a provider-side web-search tool itself.
 *
 * Search capability is a property of the *provider*, not of a model row: the
 * adapter either frames a hosted `web_search` tool or it does not, and every
 * model it serves inherits that. Membership is manual and only for a provider
 * whose hosted search has been proven. An untested provider is not native:
 * its chat route runs the configured search fallback.
 *
 * Membership here is what marks a route `search_route: "native"`.
 */
const WEB_SEARCH_CAPABLE_PROVIDER_IDS: Readonly<Record<string, true>> = {
  // Codex Responses hosted search, proven through the search fallback path.
  codex: true,
};

/**
 * True when this provider serves a proven provider-side web-search tool.
 *
 * A provider that is *only* a search provider (`serviceKinds: ["websearch"]`,
 * e.g. Exa) answers `POST /v1/search` but never a chat turn, so it is not a
 * native chat search route — it is a fallback source instead. A chat provider
 * is native only when it is named above. Service kinds do not grant it.
 */
export function providerSupportsWebSearch(providerId: string): boolean {
  return WEB_SEARCH_CAPABLE_PROVIDER_IDS[providerId.toLowerCase()] === true;
}

export type BundledProviderId = (typeof RAW_BUNDLED_PROVIDER_METADATA)[number]["id"];

/**
 * The Buddy family: CodeBuddy, its China tenant, and WorkBuddy.
 *
 * They share one billing and credit system, so several layers need to ask "is
 * this a Buddy provider" — the health recorder, the request preparer, and the
 * daily check-in. Each had its own list, which is how a fourth sibling would
 * get added in one place and silently missed in the others. Declared here
 * beside the identities it names; the layers keep their own *policies*.
 */
export const BUDDY_PROVIDER_IDS: ReadonlySet<string> = new Set(["cb", "cbcn", "workbuddy"]);

/**
 * Per-provider JWT verification defaults for issued OAuth access tokens. An
 * empty object means registered-claim validation only (the issuer's TLS token
 * endpoint is the trust boundary); a `jwksUrl` additionally verifies signatures.
 */
export interface ProviderJwtVerification {
  /** JWKS endpoint used to verify the provider's token signatures. */
  readonly jwksUrl?: string;
  /** Expected `iss` claim, when the provider publishes a stable issuer. */
  readonly issuer?: string;
  /** Expected `aud` claim, when the provider publishes a stable audience. */
  readonly audience?: string;
}

/** Shared normalized identity shape consumed by registry and dashboard code. */
export interface BundledProviderMetadata {
  readonly id: BundledProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Service surfaces this provider exposes; omitted declarations normalize to LLM. */
  readonly serviceKinds: readonly ServiceKind[];
  /**
   * Where an operator obtains or authorizes this provider's credential.
   * Presentation-only: the dashboard renders it as an outbound link, and no
   * dispatch path reads it.
   */
  readonly credentialUrl?: string;
  /**
   * One line of guidance shown beside {@link credentialUrl} when the provider's
   * sign-in is not a plain paste-a-key flow. Omitted where the link alone is
   * self-explanatory.
   */
  readonly credentialHint?: string;
  /** Presentation-only limitation shown on the provider detail page. */
  readonly operatorNotice?: string;
  readonly wireFamilyDefault: WireFamily;
  readonly requiresAccount: boolean;
  readonly defaultSkipProxy: boolean;
  /**
   * Whether this provider's rate limits are keyed on the *egress address*
   * rather than on a credential.
   *
   * An account-keyed provider (the ordinary case) answers 429 for the
   * credential that ran out, so the remedy is to back that account off and
   * route the next request to a sibling — the pool the request dialed through
   * is not at fault, and cooling it down sidelines every healthy account on
   * it. An IP-keyed provider (a credential-less free tier) answers 429 for the
   * address the request came from, so the pool IS the thing that must back
   * off: retrying from the same address reproduces the refusal no matter which
   * account is selected.
   *
   * This flag is the single statement of that difference. It is what
   * `shouldCooldownPool` reads to decide whether a provider-scoped 429 cools
   * the pool; every other provider leaves the pool alone and lets the account
   * health machine carry the failure.
   */
  readonly ipScopedRateLimit: boolean;
  readonly jwtVerification: ProviderJwtVerification;
  /**
   * The provider's adapter frames its own wire protocol instead of going
   * through one of the gateway's canonical codecs (chat / responses /
   * messages). Kiro is the bundled case: it encodes requests
   * by hand, so a part their codec does not handle is dropped rather than
   * encoded, and generation controls reach them raw.
   */
  readonly bespokeWire: boolean;
  /** True when the provider adapter builds its own User-Agent header. */
  readonly hasAdapterUserAgent: boolean;
}

/** Normalizes optional identity defaults once before any provider lookup. */
export const BUNDLED_PROVIDER_METADATA: readonly BundledProviderMetadata[] = RAW_BUNDLED_PROVIDER_METADATA.map((definition) => {
  const wireFamilyDefault: WireFamily = "wireFamilyDefault" in definition ? definition.wireFamilyDefault : "chat";
  const requiresAccount = "requiresAccount" in definition ? definition.requiresAccount : true;
  const defaultSkipProxy = Boolean("defaultSkipProxy" in definition && definition.defaultSkipProxy);
  const ipScopedRateLimit = Boolean("ipScopedRateLimit" in definition && definition.ipScopedRateLimit);
  const jwtVerification: ProviderJwtVerification =
    "jwtVerification" in definition ? definition.jwtVerification : {};
  const bespokeWire = Boolean("bespokeWire" in definition && definition.bespokeWire);
  const hasAdapterUserAgent = "hasAdapterUserAgent" in definition && definition.hasAdapterUserAgent === true;
  const serviceKinds: readonly ServiceKind[] = "serviceKinds" in definition ? definition.serviceKinds : ["llm"];
  return {
    ...definition,
    serviceKinds,
    wireFamilyDefault,
    requiresAccount,
    defaultSkipProxy,
    ipScopedRateLimit,
    jwtVerification,
    bespokeWire,
    hasAdapterUserAgent,
  };
});

const ADAPTER_USER_AGENT_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((provider) => provider.hasAdapterUserAgent).map((provider) => provider.id),
);

/** Whether the bundled adapter provides its own upstream User-Agent. */
export function providerHasAdapterUserAgent(providerId: string): boolean {
  return ADAPTER_USER_AGENT_PROVIDER_IDS.has(providerId);
}

/**
 * Where an operator obtains this provider's credential, or `undefined` when the
 * provider publishes no such page (a BYOK provider, or one whose credential is
 * minted inside a device/browser flow with no dedicated key page).
 */
export function providerCredentialUrl(providerId: string): string | undefined {
  return BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.credentialUrl;
}

/**
 * Short guidance for a provider whose sign-in is not a plain paste-a-key flow.
 * `undefined` where the link alone is self-explanatory.
 */
export function providerCredentialHint(providerId: string): string | undefined {
  return BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.credentialHint;
}

/** Presentation-only limitation for the provider detail page. */
export function providerOperatorNotice(providerId: string): string | undefined {
  return BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.operatorNotice;
}

/** Canonical builtin display name; falls back to the provider id for unknowns. */
export function providerDisplayName(providerId: string): string {
  return (
    BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.displayName ??
    providerId
  );
}

/**
 * Canonical service surfaces a provider can serve.
 *
 * A bundled provider gets exactly what its manifest declares. A custom/BYOK
 * provider has no manifest row, and this is where its capability comes from:
 * `llm` alone is read as "every media surface this gateway knows", so a
 * third-party provider can serve image and video generation without the
 * gateway having to be taught its id.
 *
 * That widening is deliberate rather than a default of `["llm"]`, because a
 * BYOK provider points at an operator-chosen base URL — the operator already
 * decided what it is, and the alternative silently locked every custom provider
 * out of the generation routes no matter what its upstream actually answers.
 * The upstream still decides: a request for a capability the remote does not
 * have comes back as that remote's own error, not a gateway-side refusal.
 */
export function providerServiceKinds(providerId: string): readonly ServiceKind[] {
  const declared = BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)
    ?.serviceKinds;
  // Bundled providers are explicit: they say which surfaces they serve, and a
  // bundled provider without the declaration serves LLM only.
  if (declared !== undefined) return declared;
  return ["llm", "imageGeneration", "videoGeneration"];
}


/** Canonical builtin base URL used by adapters, discovery, and quota clients. */
export function providerBaseUrl(providerId: string): string {
  const entry = BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId);
  if (!entry) throw new Error(`Unknown builtin provider "${providerId}"`);
  return entry.baseUrl.replace(/\/+$/, "");
}

/** Wire-path compatibility overrides owned by the canonical provider registry. */
export const PROVIDER_COMPATIBILITY_PROFILES: Record<string, CompatibilityProfile> = {
  opencodeft: {
    endpoint_paths_by_wire_family: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
    },
    model_wire_families: [{ pattern: "^muse-spark", wire_family: "responses" }],
  },
  opencodezen: {
    endpoint_paths_by_wire_family: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
    },
    model_wire_families: [{ pattern: "^muse-spark", wire_family: "responses" }],
  },
  opencodego: {
    endpoint_paths_by_wire_family: {
      chat: "/zen/go/v1/chat/completions",
      responses: "/zen/go/v1/responses",
    },
    model_wire_families: [{ pattern: "^muse-spark", wire_family: "responses" }],
  },
};

/** Default wire family for a builtin provider. */
export function providerDefaultWireFamily(providerId: string): WireFamily {
  return BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.wireFamilyDefault ?? "chat";
}

/**
 * Whether a builtin provider's adapter frames its own wire protocol, so no
 * canonical codec serves its rows. Unknown ids answer `false`: only a bundled
 * module can declare this, and a BYOK row always uses the shared
 * OpenAI-compatible adapter.
 */
export function providerUsesBespokeWire(providerId: string): boolean {
  return BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.bespokeWire ?? false;
}

/** Whether a builtin provider requires a persisted account row. */
export function providerRequiresAccount(providerId: string): boolean {
  return BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.requiresAccount ?? true;
}

/**
 * JWT verification defaults for a builtin provider. Providers without a
 * published JWKS/issuer return `{}`, so their tokens get registered-claim
 * validation only.
 */
export function providerJwtVerification(providerId: string): ProviderJwtVerification {
  return (
    BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.jwtVerification ?? {}
  );
}

/** Static upstream host derived from the canonical base URL. */
export function providerUpstreamHost(providerId: string): { readonly hostname: string; readonly port: number } {
  const url = new URL(providerBaseUrl(providerId));
  return { hostname: url.hostname, port: url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443 };
}

/** Default proxy-skip providers. */
export const DEFAULT_PROXY_SKIP_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((entry) => entry.defaultSkipProxy === true).map((entry) => entry.id),
);

/** Providers whose rate limits follow the egress address, not a credential. */
const IP_SCOPED_RATE_LIMIT_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((entry) => entry.ipScopedRateLimit === true).map((entry) => entry.id),
);

/**
 * Whether a provider-scoped 429 should cool the proxy pool down.
 *
 * Only an IP-keyed provider warrants it: the pool is the resource that ran out
 * of allowance, so backing it off is the fix. For every other provider the 429
 * belongs to the account that was dialed — the account health machine already
 * records it, and cooling the pool as well would sideline every healthy sibling
 * sharing that egress. Unknown ids (a BYOK provider) are account-keyed: a
 * configurable upstream states nothing about IP scoping, so the pool is left
 * alone.
 */
export function providerRateLimitIsIpScoped(providerId: string | undefined): boolean {
  return providerId !== undefined && IP_SCOPED_RATE_LIMIT_PROVIDER_IDS.has(providerId);
}

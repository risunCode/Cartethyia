import type { WireFamily } from "../transport/canonical-model";

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
    // Devin frames its own gRPC chat protocol over a bespoke wire.
    id: "devin",
    displayName: "Devin",
    baseUrl: "https://server.codeium.com",
    bespokeWire: true,
    hasAdapterUserAgent: true,
    credentialUrl: "https://devin.ai",
    credentialHint: "Signed in with a Devin account; there is no key to paste.",
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    hasAdapterUserAgent: true,
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
    credentialHint: "Sign in with AWS Builder ID, an Identity Center organization, Google/GitHub, or paste a Kiro API key.",
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
  { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", credentialUrl: "https://platform.deepseek.com/api_keys" },
  // The base URL carries `/v1`: the Hugging Face router serves `/v1/models` and
  // `/v1/chat/completions`, and the bare host answers 404 on both.
  { id: "huggingface", displayName: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", credentialUrl: "https://huggingface.co/settings/tokens" },
  { id: "gmi", displayName: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1", credentialUrl: "https://console.gmicloud.ai" },
  { id: "zai", displayName: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", credentialUrl: "https://z.ai/manage-apikey/apikey-list" },
  {
    // The Z.AI Coding Plan subscription endpoint, distinct from the `zai`
    // pay-as-you-go host above: different base path, a durable key minted by
    // the sign-in flow, and a different catalog.
    id: "zcode",
    displayName: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    credentialUrl: "https://chat.z.ai",
  },
  { id: "hermes", displayName: "Nous Research", baseUrl: "https://inference-api.nousresearch.com/v1", credentialUrl: "https://portal.nousresearch.com" },
  { id: "bai", displayName: "B.AI", baseUrl: "https://api.b.ai/v1", credentialUrl: "https://b.ai" },
  { id: "inferhub", displayName: "InferHub", baseUrl: "https://api.inferhub.dev/v1", defaultBypassProxy: true, hasAdapterUserAgent: true },
  { id: "aihubmix", displayName: "AiHubMix", baseUrl: "https://aihubmix.com/v1", credentialUrl: "https://aihubmix.com/token" },
  { id: "tokenharbor", displayName: "TokenHarbor", baseUrl: "https://tokenharbor.ai/v1", credentialUrl: "https://tokenharbor.ai" },
  { id: "agentrouter", displayName: "AgentRouter", baseUrl: "https://agentrouter.org", hasAdapterUserAgent: true, credentialUrl: "https://agentrouter.org" },
  { id: "cline", displayName: "Cline", baseUrl: "https://api.cline.bot/api/v1", hasAdapterUserAgent: true, credentialUrl: "https://app.cline.bot" },
  { id: "cb", displayName: "CodeBuddy", baseUrl: "https://www.codebuddy.ai/v2", hasAdapterUserAgent: true, credentialUrl: "https://www.codebuddy.ai", credentialHint: "Sign in with the same CodeBuddy account you use in the desktop app." },
  { id: "cbcn", displayName: "CodeBuddy CN", baseUrl: "https://copilot.tencent.com/v2", hasAdapterUserAgent: true, credentialUrl: "https://copilot.tencent.com", credentialHint: "Sign in with the same CodeBuddy China account you use in the desktop app." },
  { id: "workbuddy", displayName: "WorkBuddy", baseUrl: "https://www.workbuddy.ai", hasAdapterUserAgent: true, credentialUrl: "https://www.workbuddy.ai", credentialHint: "Sign in with the same WorkBuddy account you use in the desktop app." },
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
  { id: "commandcode", displayName: "Command Code", baseUrl: "https://api.commandcode.ai/alpha/generate", credentialUrl: "https://commandcode.ai/studio", credentialHint: "Use the API key from the Command Code CLI, or create one in the studio." },
  { id: "qoder", displayName: "Qoder", baseUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1", hasAdapterUserAgent: true, credentialUrl: "https://qoder.com", credentialHint: "Signed in with a Qoder account; there is no key to paste." },
  { id: "ollamacloud", displayName: "Ollama Cloud", baseUrl: "https://ollama.com/v1", credentialUrl: "https://ollama.com/settings/keys" },
  { id: "gemini", displayName: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", credentialUrl: "https://aistudio.google.com/app/apikey" },
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
  // Web-search providers: their catalog carries a single `serviceKind:
  // "websearch"` model, served by the `/v1/search` native route rather than a
  // chat wire. `baseUrl` is the API origin the search spec builds requests from.
  { id: "exa", displayName: "Exa", baseUrl: "https://api.exa.ai", credentialUrl: "https://dashboard.exa.ai/api-keys", credentialHint: "Create an API key in the Exa dashboard." },
  { id: "tavily", displayName: "Tavily", baseUrl: "https://api.tavily.com", credentialUrl: "https://app.tavily.com/home", credentialHint: "Copy the API key from the Tavily dashboard." },
  { id: "brave", displayName: "Brave Search", baseUrl: "https://api.search.brave.com", credentialUrl: "https://api-dashboard.search.brave.com/app/keys", credentialHint: "Subscribe to the Search API and copy the subscription token." },
] as const;

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
  readonly wireFamilyDefault: WireFamily;
  readonly requiresAccount: boolean;
  readonly defaultBypassProxy: boolean;
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
   * messages). Devin and Kiro are the bundled cases: they encode requests
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
  const defaultBypassProxy = Boolean("defaultBypassProxy" in definition && definition.defaultBypassProxy);
  const ipScopedRateLimit = Boolean("ipScopedRateLimit" in definition && definition.ipScopedRateLimit);
  const jwtVerification: ProviderJwtVerification =
    "jwtVerification" in definition ? definition.jwtVerification : {};
  const bespokeWire = Boolean("bespokeWire" in definition && definition.bespokeWire);
  const hasAdapterUserAgent = "hasAdapterUserAgent" in definition && definition.hasAdapterUserAgent === true;
  return {
    ...definition,
    wireFamilyDefault,
    requiresAccount,
    defaultBypassProxy,
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

/** Canonical builtin display name; falls back to the provider id for unknowns. */
export function providerDisplayName(providerId: string): string {
  return (
    BUNDLED_PROVIDER_METADATA.find((candidate) => candidate.id === providerId)?.displayName ??
    providerId
  );
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

/** Default proxy bypass providers. */
export const DEFAULT_PROXY_BYPASS_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_METADATA.filter((entry) => entry.defaultBypassProxy === true).map((entry) => entry.id),
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

// ---------------------------------------------------------------------------
// Third-party response validation
//
// Provider adapters decode payloads from external services. Even when a
// transport schema validates *structure*, the *content* is untrusted: a
// compromised or misbehaving upstream can return oversized arrays, control
// characters, non-finite numbers, or a base URL that redirects authenticated
// follow-up traffic to an attacker-controlled host. These helpers bound and
// sanitize that data before it reaches routing, storage, or the next outbound
// request (OWASP API10:2023 — Unsafe Consumption of APIs).
// ---------------------------------------------------------------------------

/** Default cap for a single upstream-provided label or identifier. */
export const MAX_UPSTREAM_LABEL_LENGTH = 256;
/** Default cap for an upstream-provided list (models, accounts, tools). */
export const MAX_UPSTREAM_LIST_ITEMS = 10_000;

// All C0/C1 controls including newlines — for labels/identifiers.
const LABEL_UNSAFE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

function clean(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(pattern, "").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Sanitizes an upstream identifier/label: removes every control character
 * (including newlines), trims, and caps length. Returns `undefined` when
 * nothing usable remains.
 */
export function sanitizeUpstreamLabel(
  value: unknown,
  maxLength = MAX_UPSTREAM_LABEL_LENGTH,
): string | undefined {
  return clean(value, LABEL_UNSAFE_CONTROL, maxLength);
}

export interface UpstreamNumberBounds {
  readonly min?: number;
  readonly max?: number;
}

/**
 * Parses and range-checks an upstream numeric field. Returns `undefined` for
 * non-numeric, non-finite, or out-of-range values so callers apply their own
 * fallback instead of trusting an attacker-controlled number.
 */
export function boundedUpstreamNumber(
  value: unknown,
  bounds: UpstreamNumberBounds = {},
): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const min = bounds.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds.max ?? Number.POSITIVE_INFINITY;
  if (parsed < min || parsed > max) return undefined;
  return parsed;
}

/**
 * Bounds an upstream array to `maxItems`. An over-long array is truncated
 * rather than rejected so a single unexpected entry cannot discard an
 * otherwise usable catalog. The typed overload preserves the element type for
 * callers that already decoded a schema; the untyped overload returns
 * `undefined` when the value is not an array.
 */
export function boundedUpstreamArray<T>(value: readonly T[], maxItems?: number): readonly T[];
export function boundedUpstreamArray(
  value: unknown,
  maxItems?: number,
): readonly unknown[] | undefined;
export function boundedUpstreamArray(
  value: unknown,
  maxItems = MAX_UPSTREAM_LIST_ITEMS,
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value as readonly unknown[];
  return items.length > maxItems ? items.slice(0, maxItems) : items;
}

export interface UpstreamBaseUrlOptions {
  /** Allow `http:` in addition to `https:` (private/dev upstreams only). */
  readonly allowHttp?: boolean;
  /** When set, the URL host must be one of these exact hosts. */
  readonly allowedHosts?: readonly string[];
}

/**
 * Validates an upstream-supplied absolute base URL. Only `https:` (or `http:`
 * when explicitly allowed) is accepted; embedded credentials and fragments are
 * rejected so a malicious upstream cannot redirect authenticated requests to a
 * different origin or downgrade transport. Returns the normalized URL without a
 * trailing slash, or `undefined` when invalid.
 */
export function validateUpstreamBaseUrl(
  value: unknown,
  options: UpstreamBaseUrlOptions = {},
): string | undefined {
  const raw = sanitizeUpstreamLabel(value, 2_048);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  if (url.protocol !== "https:" && !(options.allowHttp === true && url.protocol === "http:")) {
    return undefined;
  }
  if (options.allowedHosts && !options.allowedHosts.includes(url.hostname)) return undefined;
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

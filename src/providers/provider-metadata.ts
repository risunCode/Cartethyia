import type { WireFamily } from "../transport/canonical-model";

/** OpenAI-compatible wire overrides persisted for bundled and BYOK providers. */
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
  readonly credentialUrl?: string;
  /** Whether requests to OpenAI/Anthropic-compatible upstream should send official CLI headers. Defaults to true. */
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
  { id: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com" },
  { id: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", wireFamilyDefault: "messages" },
  { id: "claude", displayName: "Claude Code", baseUrl: "https://api.anthropic.com", wireFamilyDefault: "messages" },
  { id: "codex", displayName: "Codex ChatGPT", baseUrl: "https://chatgpt.com", wireFamilyDefault: "responses" },
  {
    id: "grok",
    displayName: "Grok Build",
    baseUrl: "https://cli-chat-proxy.grok.com",
    // Published by xAI at https://auth.x.ai/.well-known/openid-configuration;
    // access tokens that are JWTs are verified against these before an account
    // is persisted. Opaque tokens pass through and are validated by the issuer.
    jwtVerification: {
      issuer: "https://auth.x.ai",
      jwksUrl: "https://auth.x.ai/.well-known/jwks.json",
    },
  },
  { id: "cursor", displayName: "Cursor", baseUrl: "https://api2.cursor.sh" },
  { id: "devin", displayName: "Devin", baseUrl: "https://server.codeium.com" },
  { id: "antigravity", displayName: "Antigravity", baseUrl: "https://daily-cloudcode-pa.googleapis.com" },
  { id: "muse", displayName: "Muse Code", baseUrl: "https://api.meta.ai" },
  { id: "kimi", displayName: "Kimi Code", baseUrl: "https://api.kimi.com/coding" },
  { id: "opencodeft", displayName: "OpenCode Free", baseUrl: "https://opencode.ai", requiresAccount: false },
  { id: "opencodezen", displayName: "OpenCode Zen", baseUrl: "https://opencode.ai" },
  { id: "opencodego", displayName: "OpenCode Go", baseUrl: "https://opencode.ai" },
  { id: "cerebras", displayName: "Cerebras", baseUrl: "https://api.cerebras.ai/v1" },
  { id: "groq", displayName: "Groq", baseUrl: "https://api.groq.com/openai/v1", credentialUrl: "https://console.groq.com/keys" },
  { id: "openrouter", displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "mistral", displayName: "Mistral AI", baseUrl: "https://api.mistral.ai/v1" },
  { id: "siliconflow", displayName: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "fireworks", displayName: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { id: "nvidia", displayName: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "gmi", displayName: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1" },
  { id: "zai", displayName: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4" },
  { id: "hermes", displayName: "Nous Research", baseUrl: "https://inference-api.nousresearch.com/v1" },
  { id: "bai", displayName: "B.AI", baseUrl: "https://api.b.ai/v1" },
  { id: "inferhub", displayName: "InferHub", baseUrl: "https://api.inferhub.dev/v1", defaultBypassProxy: true },
  { id: "aihubmix", displayName: "AiHubMix", baseUrl: "https://aihubmix.com/v1" },
  { id: "tokenharbor", displayName: "TokenHarbor", baseUrl: "https://tokenharbor.ai/v1" },
  { id: "agentrouter", displayName: "AgentRouter", baseUrl: "https://agentrouter.org" },
  { id: "cline", displayName: "Cline", baseUrl: "https://api.cline.bot/api/v1" },
  { id: "cb", displayName: "CodeBuddy", baseUrl: "https://www.codebuddy.ai/v2" },
  { id: "cbcn", displayName: "CodeBuddy CN", baseUrl: "https://copilot.tencent.com/v2" },
  { id: "workbuddy", displayName: "WorkBuddy", baseUrl: "https://www.workbuddy.ai" },
  { id: "cloudflare", displayName: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts" },
  { id: "commandcode", displayName: "Command Code", baseUrl: "https://api.commandcode.ai/alpha/generate" },
  { id: "qoder", displayName: "Qoder", baseUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1" },
  { id: "ollamacloud", displayName: "Ollama Cloud", baseUrl: "https://ollama.com/v1" },
  { id: "gemini", displayName: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "xiaomipg", displayName: "Xiaomi MiMo (PAYG)", baseUrl: "https://api.xiaomimimo.com/v1" },
  { id: "xiaomitp", displayName: "Xiaomi MiMo (Token Plan)", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
  { id: "perplexity", displayName: "Perplexity", baseUrl: "https://api.perplexity.ai" },
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
  readonly credentialUrl?: string;
  readonly wireFamilyDefault: WireFamily;
  readonly requiresAccount: boolean;
  readonly defaultBypassProxy: boolean;
  readonly jwtVerification: ProviderJwtVerification;
}

/** Normalizes optional identity defaults once before any provider lookup. */
export const BUNDLED_PROVIDER_METADATA: readonly BundledProviderMetadata[] = RAW_BUNDLED_PROVIDER_METADATA.map((definition) => {
  const wireFamilyDefault: WireFamily = "wireFamilyDefault" in definition ? definition.wireFamilyDefault : "chat";
  const requiresAccount = "requiresAccount" in definition ? definition.requiresAccount : true;
  const defaultBypassProxy = Boolean("defaultBypassProxy" in definition && definition.defaultBypassProxy);
  const jwtVerification: ProviderJwtVerification =
    "jwtVerification" in definition ? definition.jwtVerification : {};
  return {
    ...definition,
    wireFamilyDefault,
    requiresAccount,
    defaultBypassProxy,
    jwtVerification,
  };
});

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
/** Default cap for an upstream-provided free-text error/message field. */
export const MAX_UPSTREAM_TEXT_LENGTH = 2_048;

// C0/C1 controls except tab (\u0009), newline (\u000A), and CR (\u000D).
const TEXT_UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
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

/**
 * Sanitizes upstream free text (error/detail fields): removes control
 * characters while preserving tabs/newlines, trims, and caps length.
 */
export function sanitizeUpstreamText(
  value: unknown,
  maxLength = MAX_UPSTREAM_TEXT_LENGTH,
): string | undefined {
  return clean(value, TEXT_UNSAFE_CONTROL, maxLength);
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

/**
 * Unified upstream provider module — provider registry (Cartethyia-managed
 * providers) plus pass-through OpenAI/Anthropic fetch wrappers (legacy BYOK
 * path). Single import point for all upstream dispatch concerns.
 */

import { getRequestTransformSettings } from "../../console/runtime";
import type { RouteTarget } from "../../routing/types";
import type { StreamEvent } from "../bridge";
import { UpstreamError } from "../error";
import { prepareOutboundRequest } from "../outbound";
import type { ProviderModelCatalog } from "./models";
import { commandCodeProvider } from "./commandcode/index";
import { kimchiProvider } from "./kimchi/index";
import { openCodeFreeProvider } from "./opencode-free/index";
import { openCodeZenProvider } from "./opencode-zen/index";
import { devinProvider } from "./devin/index";
import { qoderProvider } from "./qoder/index";
import { dynamicProviderRouter } from "./dynamic";
import { cursorProvider } from "./cursor/index";
import { anthropicProvider } from "./anthropic/index";
import { agentRouterProvider } from "./agentrouter/index";
import { createOpenAICompatibleProvider } from "./openai-compatible";

export { UpstreamError } from "../error";

// ── Provider registry (Cartethyia-managed providers) ─────────────────────

export interface ResolvedCredential {
  kind: "none" | "provider-bearer" | "devin-session" | "qoder-pat";
  value: string;
}

export type ProviderRequest =
  | { surface: "openai-chat"; body: Record<string, unknown> }
  | { surface: "openai-responses"; body: Record<string, unknown> }
  | { surface: "anthropic-messages"; body: Record<string, unknown> };

export interface ProviderStreamResult {
  type: "stream";
  events: AsyncGenerator<StreamEvent>;
}

export interface ProviderJsonResult {
  type: "json";
  body: Record<string, unknown>;
}

export type ProviderResult = ProviderStreamResult | ProviderJsonResult;

/**
 * How a provider is presented in the console. Each provider owns its own
 * entry so adding a provider never means editing a central display table.
 *
 * `authKind` drives both the console grouping and the credential copy:
 *   none    — usable with no credential at all
 *   session — an exchanged/derived session credential, not a user-issued key
 *   api-key — a key the user obtains and pastes
 */
export interface ProviderDisplay {
  /** Human label, e.g. "OpenCode Free". */
  readonly name: string;
  /** Icon file id under `/console/providers/<icon>.png`. */
  readonly icon: string;
  readonly authKind: "none" | "session" | "api-key";
  /** One sentence telling the operator where the credential comes from. */
  readonly authHint: string;
  /** Where to obtain the credential, when the provider publishes one. */
  readonly credentialUrl?: string;
}

export interface Provider {
  readonly id: "opencode-free" | "opencode-zen" | "commandcode" | "kimchi" | "devin" | "qoder" | "custom" | "cursor" | "openai" | "anthropic" | "xmimo" | "openrouter" | "ollama" | "cerebras" | "deepseek" | "siliconflow" | "mistral" | "opencode-go" | "agentrouter" | "xiaomi-tokenplan";
  readonly display: ProviderDisplay;
  readonly models: ProviderModelCatalog;

  resolveTarget(modelId: string): Promise<RouteTarget | undefined> | RouteTarget | undefined;

  call(
    target: RouteTarget,
    request: ProviderRequest,
    credential: ResolvedCredential,
    signal: AbortSignal,
    proxy?: string
  ): Promise<ProviderResult>;
}

export class ProviderCallError extends Error {
  status: number;
  kind: "authentication" | "invalid_request" | "rate_limited" | "unavailable" | "malformed_response";

  constructor(
    status: number,
    kind: "authentication" | "invalid_request" | "rate_limited" | "unavailable" | "malformed_response",
    message: string
  ) {
    super(message);
    this.status = status;
    this.kind = kind;
  }

  toUpstreamError(): UpstreamError {
    return new UpstreamError(this.message, this.status, "");
  }
}

/**
 * Canonical HTTP status → `ProviderCallError` kind mapping. Every provider
 * transport hits the same upstream failure classes (auth, rate limit,
 * generic 4xx, everything else); this is the single place that decides how
 * a raw status maps to one.
 */
export function classifyUpstreamStatus(status: number): "authentication" | "invalid_request" | "rate_limited" | "unavailable" {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

/**
 * Canonical provider HTTP failure factory. Every simple provider transport
 * (Kimchi, Qoder, Command Code, OpenCode Zen) threw the same four-branch
 * template with only the provider name — and occasionally the auth
 * message — varying; this is the single source for that shape.
 */
export function providerHttpError(status: number, provider: string, authMessage?: string): ProviderCallError {
  const kind = classifyUpstreamStatus(status);
  if (kind === "authentication") return new ProviderCallError(status, kind, authMessage ?? `${provider} rejected the supplied credential.`);
  if (kind === "rate_limited") return new ProviderCallError(status, kind, `${provider} is rate-limiting this request.`);
  if (kind === "invalid_request") return new ProviderCallError(status, kind, `${provider} rejected this request.`);
  return new ProviderCallError(502, kind, `${provider} is unavailable.`);
}

const OPENAI_COMPATIBLE_PROVIDERS = [
  createOpenAICompatibleProvider({
    id: "openai",
    name: "OpenAI",
    icon: "openai",
    baseUrl: "https://api.openai.com/v1",
    credentialUrl: "https://platform.openai.com/api-keys",
    authHint: "Paste your official OpenAI API key (starts with sk-...) from platform.openai.com.",
    // Display-only — official BYOK provider, routing accepts any model id since
    // OpenAI's catalog moves faster than a curated list can (matches prior dedicated impl).
    // GPT-5.6 family (Sol/Terra/Luna) released 2026-07-09; GPT-5.5 (2026-04) and
    // GPT-5.4 mini (2026-03-17) remain live in the API and are kept as prior-gen options
    // (developers.openai.com/api/docs/models).
    models: [
      { id: "gpt-5.6-sol", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 400000, maxOutputTokens: 128000, description: "Flagship — frontier coding, knowledge work, cybersecurity, science." },
      { id: "gpt-5.6-terra", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 400000, maxOutputTokens: 128000, description: "Balanced — lower cost per performance." },
      { id: "gpt-5.6-luna", capabilities: ["text", "streaming", "json", "tools", "reasoning"], contextWindow: 400000, maxOutputTokens: 128000, description: "Fastest, most cost-efficient tier." },
      { id: "gpt-5.5", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 1000000, maxOutputTokens: 128000, description: "Prior-gen frontier — complex professional and agentic work." },
      { id: "gpt-5.4-mini", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 400000, maxOutputTokens: 128000, description: "Strongest mini tier — coding, computer use, high-volume subagents." },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "xmimo",
    name: "Xiaomi MiMo (PAYG)",
    icon: "mimo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    credentialUrl: "https://xiaomimimo.com",
    authHint: "Paste your Xiaomi MiMo pay-as-you-go API key from xiaomimimo.com.",
    // Pay-as-you-go tier, distinct from Token Plan (`xiaomi-tokenplan` below).
    // Strict: gated to exactly this curated pair per operator preference —
    // unlike the other entries here, an unlisted model id must be rejected.
    strict: true,
    models: [
      { id: "mimo-v2.5-pro", capabilities: ["text", "streaming", "json", "tools"], contextWindow: 1000000, maxOutputTokens: 128000 },
      { id: "mimo-v2.5", capabilities: ["text", "streaming", "json", "tools"], contextWindow: 1000000, maxOutputTokens: 128000 },
    ],
  }),
  createOpenAICompatibleProvider({ id: "openrouter", name: "OpenRouter", icon: "openrouter", baseUrl: "https://openrouter.ai/api/v1", credentialUrl: "https://openrouter.ai/settings/keys", models: [{ id: "openai/gpt-4.1", capabilities: ["text", "vision", "tools", "streaming", "json"] }] }),
  createOpenAICompatibleProvider({
    id: "ollama",
    name: "Ollama",
    icon: "ollama",
    baseUrl: "https://ollama.com/v1",
    credentialUrl: "https://ollama.com/settings/keys",
    // gpt-oss + cloud-offloaded large open-weight models (docs.ollama.com/cloud).
    models: [
      { id: "gpt-oss:20b", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "gpt-oss:120b", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "gpt-oss:20b-cloud", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "gpt-oss:120b-cloud", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "qwen3-coder:480b-cloud", capabilities: ["text", "tools", "streaming", "json"] },
      { id: "deepseek-v3.1:671b-cloud", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "cerebras",
    name: "Cerebras",
    icon: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    credentialUrl: "https://cloud.cerebras.ai/platform/",
    // Free-tier public endpoint catalog (inference-docs.cerebras.ai/models/overview) —
    // curated down to gpt-oss-120b and zai-glm-4.7 per operator preference.
    models: [
      { id: "gpt-oss-120b", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "zai-glm-4.7", capabilities: ["text", "tools", "streaming", "json"] },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    icon: "deepseek",
    baseUrl: "https://api.deepseek.com",
    credentialUrl: "https://platform.deepseek.com/api_keys",
    // deepseek-chat/deepseek-reasoner were discontinued 2026-07-24 in favor of
    // V4 (api-docs.deepseek.com/updates) — v4-flash covers both non-thinking
    // and thinking mode (former -chat/-reasoner split), v4-pro is the frontier tier.
    models: [
      { id: "deepseek-v4-pro", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "deepseek-v4-flash", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "siliconflow",
    name: "SiliconFlow",
    icon: "siliconflow",
    baseUrl: "https://api.siliconflow.com/v1",
    credentialUrl: "https://cloud.siliconflow.cn/account/ak",
    // Free-tier models (docs.siliconflow.com/en/userguide/rate-limits) — free
    // versions use the bare id; "Pro/" prefix is the paid tier of the same model.
    models: [
      { id: "Qwen/Qwen3-8B", capabilities: ["text", "tools", "streaming", "json"] },
      { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", capabilities: ["text", "reasoning", "streaming"] },
      { id: "deepseek-ai/DeepSeek-V3", capabilities: ["text", "tools", "streaming", "json"] },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "mistral",
    name: "Mistral",
    icon: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    credentialUrl: "https://console.mistral.ai/api-keys/",
    // Latest generation only, via Mistral's "-latest" rolling aliases
    // (docs.mistral.ai/models) — always resolves to the newest release per tier.
    models: [
      { id: "mistral-large-latest", capabilities: ["text", "vision", "tools", "streaming", "json"] },
      { id: "mistral-medium-latest", capabilities: ["text", "vision", "tools", "streaming", "json"] },
      { id: "mistral-small-latest", capabilities: ["text", "tools", "streaming", "json"] },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "xiaomi-tokenplan",
    name: "Xiaomi MiMo (Token Plan)",
    icon: "mimo",
    // Token Plan keys are cluster-specific; Singapore is the default region
    // (matches the reference registry). Operators on a different region can
    // reach it via a Custom Provider entry pointed at their cluster's base URL.
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    credentialUrl: "https://mimo.xiaomi.com",
    models: [
      { id: "mimo-v2.5-pro", capabilities: ["text", "tools", "streaming", "json"], contextWindow: 1000000, maxOutputTokens: 128000 },
      { id: "mimo-v2.5", capabilities: ["text", "tools", "streaming", "json"], contextWindow: 1000000, maxOutputTokens: 128000 },
      { id: "mimo-v2-pro", capabilities: ["text", "tools", "streaming", "json"] },
      { id: "mimo-v2-omni", capabilities: ["text", "vision", "tools", "streaming", "json"] },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "opencode-go",
    name: "OpenCode Go",
    icon: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    credentialUrl: "https://opencode.ai/auth",
    // Curated subset of the live Go catalog (opencode.ai/docs/go) — the full,
    // current list is always available via the console's "Fetch models" action.
    models: [
      { id: "grok-4.5", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "glm-5.2", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "kimi-k3", capabilities: ["text", "vision", "tools", "streaming", "json", "reasoning"] },
      { id: "kimi-k2.7-code", capabilities: ["text", "tools", "streaming", "json"] },
      { id: "mimo-v2.5-pro", capabilities: ["text", "tools", "streaming", "json"] },
      { id: "qwen3.7-max", capabilities: ["text", "tools", "streaming", "json"] },
      { id: "minimax-m3", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "deepseek-v4-pro", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "deepseek-v4-flash", capabilities: ["text", "tools", "streaming", "json", "reasoning"] },
      { id: "hy3", capabilities: ["text", "tools", "streaming", "json"] },
    ],
  }),
] as const;

const PROVIDERS = new Map<Provider["id"], Provider>([
  ["commandcode", commandCodeProvider],
  ["kimchi", kimchiProvider],
  ["opencode-free", openCodeFreeProvider],
  ["agentrouter", agentRouterProvider],
  ["opencode-zen", openCodeZenProvider],
  ["devin", devinProvider],
  ["qoder", qoderProvider],
  ["custom", dynamicProviderRouter],
  ["cursor", cursorProvider],
  ["anthropic", anthropicProvider],
  ...OPENAI_COMPATIBLE_PROVIDERS.map((provider) => [provider.id, provider] as const),
]);

export const providerRegistry = {
  get(provider: Provider["id"]): Provider | undefined {
    return PROVIDERS.get(provider);
  },
  /** Every registered provider — used to build the cross-provider known-model metadata index. */
  all(): Provider[] {
    return [...PROVIDERS.values()];
  },
};

// ── Provider selection (legacy pass-through routing) ─────────────────────

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export type PassThroughProvider = "openai" | "anthropic";

export function selectProvider(model: string): PassThroughProvider {
  return model.startsWith("claude") ? "anthropic" : "openai";
}

export interface InboundHeaders {
  authorization?: string;
  "x-api-key"?: string;
}

/** For the core build, forward the caller's OpenAI credential unchanged. */
export function resolveOpenAIAuth(headers: InboundHeaders): string | undefined {
  return headers.authorization;
}

/** For Anthropic, accept x-api-key or adapt an OpenAI-style bearer credential. */
export function resolveAnthropicAuth(headers: InboundHeaders): string | undefined {
  if (headers["x-api-key"]) return headers["x-api-key"];
  if (headers.authorization?.startsWith("Bearer ")) return headers.authorization.slice(7);
  return undefined;
}

// ── OpenAI pass-through ──────────────────────────────────────────────────

export interface UpstreamCallOptions {
  authorizationHeader: string | undefined;
}

async function callOpenAI(path: string, body: unknown, opts: UpstreamCallOptions): Promise<Response> {
  const apiKey = opts.authorizationHeader;
  if (!apiKey) throw new UpstreamError("no OpenAI credential supplied", 401, "");
  const outboundBody = prepareOutboundRequest(body, "openai", getRequestTransformSettings());

  const res = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify(outboundBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new UpstreamError(`OpenAI upstream ${path} returned ${res.status}`, res.status, errBody);
  }
  return res;
}

export async function callChatCompletions(body: unknown, opts: UpstreamCallOptions): Promise<Response> {
  return callOpenAI("/chat/completions", body, opts);
}

export async function callResponses(body: unknown, opts: UpstreamCallOptions): Promise<Response> {
  return callOpenAI("/responses", body, opts);
}

export async function listOpenAIModels(opts: UpstreamCallOptions): Promise<Response> {
  const apiKey = opts.authorizationHeader;
  if (!apiKey) throw new UpstreamError("no OpenAI credential supplied", 401, "");

  const res = await fetch(`${OPENAI_BASE_URL}/models`, { headers: { authorization: apiKey } });
  if (!res.ok) throw new UpstreamError(`OpenAI upstream /models returned ${res.status}`, res.status, await res.text());
  return res;
}

// ── Anthropic pass-through ───────────────────────────────────────────────

export interface AnthropicUpstreamCallOptions {
  apiKeyHeader: string | undefined;
}

async function callAnthropic(path: string, body: unknown, opts: AnthropicUpstreamCallOptions): Promise<Response> {
  const apiKey = opts.apiKeyHeader;
  if (!apiKey) throw new UpstreamError("no Anthropic credential supplied", 401, "");
  const outboundBody = prepareOutboundRequest(body, "anthropic", getRequestTransformSettings());

  const res = await fetch(`${ANTHROPIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(outboundBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new UpstreamError(`Anthropic upstream ${path} returned ${res.status}`, res.status, errBody);
  }
  return res;
}

export async function callMessages(body: unknown, opts: AnthropicUpstreamCallOptions): Promise<Response> {
  return callAnthropic("/messages", body, opts);
}

export async function listAnthropicModels(opts: AnthropicUpstreamCallOptions): Promise<Response> {
  const apiKey = opts.apiKeyHeader;
  if (!apiKey) throw new UpstreamError("no Anthropic credential supplied", 401, "");

  const res = await fetch(`${ANTHROPIC_BASE_URL}/models`, {
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
  });
  if (!res.ok) throw new UpstreamError(`Anthropic upstream /models returned ${res.status}`, res.status, await res.text());
  return res;
}

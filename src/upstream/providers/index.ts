/**
 * Unified upstream provider module. The provider registry for every
 * Cartethyia-managed provider (built-in API-key, session-based, and custom).
 * Single import point for all upstream dispatch concerns; every model, bare
 * or provider-qualified, resolves and dispatches through this registry, not
 * a direct fetch to an upstream API.
 */

import type { RouteTarget } from "../../routing/types";
import type { StreamEvent } from "../bridge";
import { UpstreamError } from "../error";
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
import { openaiProvider } from "./openai/index";
import { opencodeGoProvider } from "./opencode-go/index";
import { xiaomiPaygProvider } from "./xiaomi-payg/index";
import { xiaomiTokenPlanProvider } from "./xiaomi-tokenplan/index";
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
  readonly id: "opencode-free" | "opencode-zen" | "commandcode" | "kimchi" | "devin" | "qoder" | "custom" | "cursor" | "openai" | "anthropic" | "pgxiaomi" | "openrouter" | "ollama" | "cerebras" | "deepseek" | "siliconflow" | "mistral" | "opencode-go" | "agentrouter" | "tpxiaomi";
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
 * Reads a Response body for error-message extraction without ever throwing —
 * a body can legitimately fail to read (already consumed, connection reset
 * mid-stream, a test double reusing one Response instance across calls) and
 * that failure must never mask the real HTTP status/error being reported.
 */
export async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Best-effort extraction of the actual error text an upstream API returned,
 * so a caller sees e.g. "Insufficient balance" instead of a generic
 * "<Provider> rejected this request." wrapper that hides what's actually
 * wrong. Handles the common OpenAI/Anthropic-style `{error:{message}}`
 * shape, a bare `{message}`/`{error:"..."}}`, and falls back to the raw
 * body text (truncated) for a plain-text error response.
 */
export function extractUpstreamErrorMessage(bodyText: string, maxLen = 300): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === "string" && err.trim()) return err.trim().slice(0, maxLen);
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, maxLen);
      }
      if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim().slice(0, maxLen);
      if (typeof obj.detail === "string" && obj.detail.trim()) return obj.detail.trim().slice(0, maxLen);
    }
  } catch {
    // Not JSON — fall through to the raw text below.
  }
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}\u2026` : trimmed;
}

/**
 * Canonical provider HTTP failure factory. Every simple provider transport
 * (Kimchi, Qoder, Command Code, OpenCode Zen) threw the same four-branch
 * template with only the provider name — and occasionally the auth
 * message — varying; this is the single source for that shape. Prefers the
 * upstream's own error text (from `bodyText`) over the generic wrapper
 * whenever the response body actually says something.
 */
export function providerHttpError(status: number, provider: string, authMessage?: string, bodyText?: string): ProviderCallError {
  const kind = classifyUpstreamStatus(status);
  const upstreamMessage = bodyText ? extractUpstreamErrorMessage(bodyText) : undefined;
  if (kind === "authentication") return new ProviderCallError(status, kind, authMessage ?? upstreamMessage ?? `${provider} rejected the supplied credential.`);
  if (kind === "rate_limited") return new ProviderCallError(status, kind, upstreamMessage ?? `${provider} is rate-limiting this request.`);
  if (kind === "invalid_request") return new ProviderCallError(status, kind, upstreamMessage ?? `${provider} rejected this request.`);
  // Preserve the upstream's own status (500, 503, ...) instead of collapsing
  // every non-4xx failure to a hardcoded 502 — callers checking for a
  // specific relayed status (retry logic, tests) rely on it coming through.
  return new ProviderCallError(status, kind, upstreamMessage ?? `${provider} is unavailable.`);
}

const OPENAI_COMPATIBLE_PROVIDERS = [
  createOpenAICompatibleProvider({
    id: "openrouter",
    name: "OpenRouter",
    icon: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialUrl: "https://openrouter.ai/settings/keys",
    models: [{ id: "openai/gpt-4.1", vision: true, contextWindow: 1047576, maxOutputTokens: 32768, pricing: { input: 2, output: 8, cacheRead: 0.5 } }],
  }),
  createOpenAICompatibleProvider({
    id: "ollama",
    name: "Ollama",
    icon: "ollama",
    baseUrl: "https://ollama.com/v1",
    credentialUrl: "https://ollama.com/settings/keys",
    // gpt-oss + cloud-offloaded large open-weight models (docs.ollama.com/cloud).
    // Reference vendor pricing per 1M tokens (USD).
    models: [
      { id: "gpt-oss:20b", reasoning: true, contextWindow: 131072, pricing: { input: 0.1, output: 0.3 } },
      { id: "gpt-oss:120b", reasoning: true, contextWindow: 131072, pricing: { input: 0.35, output: 0.75 } },
      { id: "gemma4:31b", reasoning: true, contextWindow: 131072, pricing: { input: 0.075, output: 0.3 } },
      { id: "minimax-m2.5", reasoning: true, contextWindow: 1000000, pricing: { input: 0.2, output: 0.8 } },
      { id: "minimax-m3", reasoning: true, contextWindow: 1000000, pricing: { input: 0.3, output: 1.2 } },
      { id: "nemotron-3-super", reasoning: true, contextWindow: 131072, pricing: { input: 0.15, output: 0.6 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "cerebras",
    name: "Cerebras",
    icon: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    credentialUrl: "https://cloud.cerebras.ai/platform/",
    // Free-tier public endpoint catalog, curated down to gpt-oss-120b and
    // zai-glm-4.7 per operator preference. Verified against models.dev
    // (cerebras) 2026-07-30.
    models: [
      { id: "gpt-oss-120b", reasoning: true, contextWindow: 131072, maxOutputTokens: 40960, pricing: { input: 0.35, output: 0.75 } },
      { id: "zai-glm-4.7", reasoning: true, contextWindow: 131072, maxOutputTokens: 40960, pricing: { input: 2.25, output: 2.75, cacheRead: 2.25 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    icon: "deepseek",
    baseUrl: "https://api.deepseek.com",
    credentialUrl: "https://platform.deepseek.com/api_keys",
    // deepseek-chat/deepseek-reasoner were discontinued 2026-07-24 in favor of
    // V4, v4-flash covers both non-thinking and thinking mode (former
    // -chat/-reasoner split), v4-pro is the frontier tier. Verified against
    // models.dev (deepseek) 2026-07-30.
    models: [
      { id: "deepseek-v4-pro", reasoning: true, contextWindow: 1000000, maxOutputTokens: 384000, pricing: { input: 0.435, output: 0.87, cacheRead: 0.003625 } },
      { id: "deepseek-v4-flash", reasoning: true, contextWindow: 1000000, maxOutputTokens: 384000, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "siliconflow",
    name: "SiliconFlow",
    icon: "siliconflow",
    baseUrl: "https://api.siliconflow.com/v1",
    credentialUrl: "https://cloud.siliconflow.cn/account/ak",
    // Free-tier models, free versions use the bare id; "Pro/" prefix is the
    // paid tier of the same model. Pricing verified against models.dev
    // (siliconflow) 2026-07-30 where a matching entry exists.
    models: [
      { id: "Qwen/Qwen3-8B", reasoning: true, contextWindow: 131000, maxOutputTokens: 131000, pricing: { input: 0.06, output: 0.06 } },
      { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", reasoning: true, contextWindow: 131000, maxOutputTokens: 16384, pricing: { input: 0.07, output: 0.07 } },
      { id: "deepseek-ai/DeepSeek-V3", reasoning: true, contextWindow: 164000, maxOutputTokens: 164000, pricing: { input: 0.25, output: 1 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "mistral",
    name: "Mistral",
    icon: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    credentialUrl: "https://console.mistral.ai/api-keys/",
    // Latest generation only, via Mistral's "-latest" rolling aliases, always
    // resolves to the newest release per tier. Verified against models.dev
    // (mistral) 2026-07-30.
    models: [
      { id: "mistral-large-latest", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 262144, pricing: { input: 0.5, output: 1.5 } },
      { id: "mistral-medium-latest", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 262144, pricing: { input: 1.5, output: 7.5 } },
      { id: "mistral-small-latest", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 256000, pricing: { input: 0.15, output: 0.6 } },
      { id: "codestral-latest", reasoning: true, contextWindow: 256000, maxOutputTokens: 256000, pricing: { input: 0.3, output: 0.9 } },
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
  ["openai", openaiProvider],
  ["opencode-go", opencodeGoProvider],
  ["pgxiaomi", xiaomiPaygProvider],
  ["tpxiaomi", xiaomiTokenPlanProvider],
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



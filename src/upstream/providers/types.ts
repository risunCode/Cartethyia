/**
 * Provider type definitions — the public contract every provider implements
 * and every consumer imports. Zero runtime code; pure types.
 */

import type { RouteTarget } from "../../routing/types";
import type { StreamEvent } from "../bridge";
import type { ProviderModelCatalog } from "./models";

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

  /**
   * Counts input tokens for an Anthropic-shaped request (`model`, `messages`,
   * `system?`, `tools?`, `tool_choice?`) without generating a completion.
   * Only implemented by providers whose upstream natively exposes Anthropic's
   * `/messages/count_tokens` endpoint (the built-in "anthropic" provider and
   * "anthropic-compatible" custom providers) - absent everywhere else, since
   * no other provider's wire protocol has an equivalent operation.
   */
  countTokens?(
    target: RouteTarget,
    body: Record<string, unknown>,
    credential: ResolvedCredential,
    signal: AbortSignal,
    proxy?: string
  ): Promise<{ inputTokens: number }>;
}

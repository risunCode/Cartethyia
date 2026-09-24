import type { CredentialKind } from "../../provider-registry";
import { GatewayError, capabilityUnsupported } from "../../../transport/gateway-error";

export type AnthropicBetaInput = string | readonly string[] | undefined;

/** Policy applied when a requested beta is not declared by the target route. */
export type AnthropicBetaUnsupportedPolicy = "drop" | "reject";

/** A requested beta that was intentionally not forwarded to the target. */
interface AnthropicBetaDowngrade {
  readonly beta: string;
  readonly capability: string;
  readonly reason: "target_capability_missing" | "credential_mismatch";
}

/** Result of independently negotiating every requested beta value. */
export interface AnthropicBetaNegotiation {
  readonly requested: readonly string[];
  readonly accepted: readonly string[];
  readonly dropped: readonly string[];
  readonly downgraded: readonly AnthropicBetaDowngrade[];
  readonly rejected: readonly AnthropicBetaDowngrade[];
  /** Serialized accepted values, or undefined when none remain. */
  readonly header?: string;
}

/** Optional target facts used by the beta capability resolver. */
export interface AnthropicBetaNegotiationOptions {
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly unsupported?: AnthropicBetaUnsupportedPolicy;
  readonly credential_kind?: CredentialKind;
  readonly target_provider?: string;
}

/**
 * Representative Anthropic beta names and their provider capability aliases.
 * The map is intentionally additive: unknown beta names are still parsed and
 * can be accepted when a catalog explicitly declares the exact name.
 */
export const ANTHROPIC_BETA_CAPABILITIES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "claude-code-20250219": ["claude_code", "claude-code"],
    "oauth-2025-04-20": ["oauth", "oauth_authentication"],
    "interleaved-thinking-2025-05-14": ["interleaved_thinking", "thinking.interleaved"],
    "context-1m-2025-08-07": ["context_1m", "long_context"],
    "context-management-2025-06-27": ["context_management", "server_context_management"],
    "prompt-caching-scope-2026-01-05": ["prompt_caching", "prompt_caching_scope"],
    "fast-mode-2026-02-01": ["fast_mode", "speed.fast"],
    "effort-2025-11-24": ["effort", "reasoning_effort"],
    "redact-thinking-2026-02-12": ["redacted_thinking", "thinking.redacted"],
    "token-counting-2024-11-01": ["token_counting", "usage.token_counting"],
    "web-search-2025-03-05": ["server_tool_use", "web_search"],
    "advanced-tool-use-2025-11-20": ["advanced_tool_use", "tools.advanced"],
    "fine-grained-tool-streaming-2025-05-14": ["fine_grained_tool_streaming", "tool_streaming"],
    "structured-outputs-2025-12-15": ["structured_outputs", "response_format.json_schema"],
    "thinking-token-count-2026-05-13": ["thinking_token_count", "usage.thinking_tokens"],
    "extended-cache-ttl-2025-04-11": ["extended_cache_ttl", "prompt_caching.ttl"],
    "mid-conversation-system-2026-04-07": [
      "mid_conversation_system",
      "messages.mid_conversation_system",
    ],
    "task-budgets-2026-03-13": ["task_budgets", "budgets"],
    "server-side-fallback-2026-06-01": ["server_side_fallback", "fallback"],
    "fallback-credit-2026-06-01": ["fallback_credit", "fallback-credit", "credit.fallback"],
  });

const BETA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function invalidBeta(message: string, value: unknown): GatewayError {
  return new GatewayError("invalid_request", 400, message, { field: "anthropic-beta", value });
}

/**
 * Parses one or more comma-separated beta values into a stable, de-duplicated
 * list. Empty separators are ignored; malformed values are rejected rather
 * than forwarded as an opaque header.
 */
export function parseAnthropicBeta(value: AnthropicBetaInput | null): readonly string[] {
  if (value == null || value === "") return [];
  const rawValues = typeof value === "string" ? [value] : value;
  if (!Array.isArray(rawValues))
    throw invalidBeta("anthropic-beta must be a string or string array", value);

  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    if (typeof raw !== "string") throw invalidBeta("anthropic-beta values must be strings", raw);
    for (const item of raw.split(",")) {
      const beta = item.trim();
      if (beta.length === 0) continue;
      if (!BETA_TOKEN.test(beta)) throw invalidBeta(`invalid anthropic-beta value: ${beta}`, beta);
      const identity = beta.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      parsed.push(beta);
    }
  }
  return parsed;
}

function capabilityLookup(
  capabilities: Readonly<Record<string, boolean>> | undefined,
): Map<string, boolean> {
  const normalized = new Map<string, boolean>();
  if (!capabilities) return normalized;
  for (const [name, enabled] of Object.entries(capabilities)) {
    normalized.set(name.toLowerCase(), enabled === true);
  }
  return normalized;
}

function aliasesFor(beta: string): readonly string[] {
  return ANTHROPIC_BETA_CAPABILITIES[beta.toLowerCase()] ?? [];
}

function capabilityName(beta: string): string {
  return aliasesFor(beta)[0] ?? `anthropic-beta:${beta}`;
}

function credentialSupportsOauth(kind: CredentialKind | undefined): boolean {
  return kind === "oauth" || kind === "scoped_access_token";
}

function baselineSupports(beta: string, options: AnthropicBetaNegotiationOptions): boolean {
  const normalized = beta.toLowerCase();
  if (normalized === "oauth-2025-04-20") return credentialSupportsOauth(options.credential_kind);
  if (normalized === "claude-code-20250219")
    return options.target_provider?.toLowerCase() === "claude";
  // Claude Code OAuth fingerprint betas are baseline-supported when using OAuth
  // against the official Anthropic endpoint — the reference sends them unconditionally
  // for OAuth agent requests (buildClaudeCodeBetas). Treat as default-supported so
  // defaultBetaInput's expanded list doesn't require explicit catalog capabilities.
  const oauthBaselineBetas: Readonly<Record<string, true>> = {
    "interleaved-thinking-2025-05-14": true,
    "thinking-token-count-2026-05-13": true,
    "context-management-2025-06-27": true,
    "prompt-caching-scope-2026-01-05": true,
    "structured-outputs-2025-12-15": true,
    "mid-conversation-system-2026-04-07": true,
    "fallback-credit-2026-06-01": true,
    "effort-2025-11-24": true,
  };
  if (oauthBaselineBetas[normalized] === true) {
    return credentialSupportsOauth(options.credential_kind);
  }
  return false;
}

function targetSupports(
  beta: string,
  options: AnthropicBetaNegotiationOptions,
  capabilities: Map<string, boolean>,
): boolean {
  const keys = [beta, `anthropic-beta:${beta}`, ...aliasesFor(beta)];
  const declaredKey = keys.find((key) => capabilities.has(key.toLowerCase()));
  if (declaredKey !== undefined) return capabilities.get(declaredKey.toLowerCase()) === true;
  return baselineSupports(beta, options);
}

/**
 * Negotiates every beta independently against the selected route capability
 * profile. Rejected/dropped values are returned explicitly so callers can
 * surface a typed error or an operator-visible downgrade; no unsupported beta
 * is ever forwarded accidentally.
 */
export function negotiateAnthropicBetas(
  value: AnthropicBetaInput | null,
  options: AnthropicBetaNegotiationOptions = {},
): AnthropicBetaNegotiation {
  const requested = parseAnthropicBeta(value);
  const policy = options.unsupported ?? "reject";
  const capabilities = capabilityLookup(options.capabilities);
  const accepted: string[] = [];
  const dropped: string[] = [];
  const downgraded: AnthropicBetaDowngrade[] = [];
  const rejected: AnthropicBetaDowngrade[] = [];

  for (const beta of requested) {
    if (targetSupports(beta, options, capabilities)) {
      accepted.push(beta);
      continue;
    }
    const downgrade: AnthropicBetaDowngrade = {
      beta,
      capability: capabilityName(beta),
      reason:
        beta.toLowerCase() === "oauth-2025-04-20" &&
        !credentialSupportsOauth(options.credential_kind)
          ? "credential_mismatch"
          : "target_capability_missing",
    };
    if (policy === "drop") {
      dropped.push(beta);
      downgraded.push(downgrade);
    } else {
      rejected.push(downgrade);
    }
  }

  return {
    requested,
    accepted,
    dropped,
    downgraded,
    rejected,
    ...(accepted.length > 0 ? { header: accepted.join(",") } : {}),
  };
}

/** Throws the shared typed capability error when negotiation rejected a beta. */
export function assertAnthropicBetaNegotiation(
  negotiation: AnthropicBetaNegotiation,
): AnthropicBetaNegotiation {
  const first = negotiation.rejected[0];
  if (!first) return negotiation;
  throw capabilityUnsupported(first.capability, {
    beta: first.beta,
    rejected_betas: negotiation.rejected.map((item) => item.beta),
    requested_betas: negotiation.requested,
  });
}

// Cross-module re-exports of ./system-prompt, ./ingress, ./beta dissolved:
// those symbols now live in this module directly.

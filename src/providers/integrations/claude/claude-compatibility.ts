import type { CredentialKind } from "../../provider-registry";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { allParts, hasExtension, hasKind, hasOpaqueReasoning } from "../../../transport/canonical-model";
import { capabilityUnsupported } from "../../../transport/gateway-error";
import { negotiateAnthropicBetas, type AnthropicBetaNegotiation, type AnthropicBetaUnsupportedPolicy } from "./claude-betas";

/** A semantic capability required by a Claude Code request. */
type ClaudeRequestCapability =
  | "tools"
  | "reasoning"
  | "redacted_thinking"
  | "server_tool_use"
  | "image"
  | "prompt_caching"
  | "response_format"
  | "parallel_tool_calls";

/** One explicit loss decision for a target route. */
interface ClaudeCapabilityIssue {
  readonly capability: ClaudeRequestCapability | string;
  readonly reason: "target_capability_missing" | "policy_disallows_loss";
  readonly action: "downgrade" | "reject";
}

/** Capability assessment retained for operator-visible downgrade reporting. */
interface ClaudeCompatibilityAssessment {
  readonly accepted: readonly string[];
  readonly downgraded: readonly ClaudeCapabilityIssue[];
  readonly rejected: readonly ClaudeCapabilityIssue[];
  readonly betas: AnthropicBetaNegotiation;
}

/**
 * Folds a capability name to its comparison form.
 *
 * The route profile this is matched against is built by
 * `buildCapabilityProfile`, which spells its keys in camelCase
 * (`promptCaching`, `parallelToolCalls`, `reasoningEncryptedContent`,
 * `responseJsonObject`), while this module's vocabulary is snake_case
 * (`prompt_caching`, `parallel_tool_calls`) and the Anthropic beta map mixes
 * both. Comparing them literally matched nothing — `promptcaching` never
 * equals `prompt_caching` — so `prompt_caching`, `response_format`,
 * `redacted_thinking`, and `server_tool_use` were rejected on *every* Claude
 * route, live traffic included, not just probes. Case and separators carry no
 * meaning here, so both sides drop them before comparing.
 */
function canonicalCapabilityName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

function capabilityAliases(
  capability: ClaudeRequestCapability,
): readonly string[] {
  const aliases: Readonly<Record<ClaudeRequestCapability, readonly string[]>> =
    {
      tools: ["tools", "tool_use"],
      reasoning: ["reasoning", "thinking"],
      // `reasoningEncryptedContent` is the profile's spelling of the same
      // capability (an opaque/redacted thinking block the route can carry).
      redacted_thinking: [
        "redacted_thinking",
        "thinking.redacted",
        "reasoningEncryptedContent",
      ],
      server_tool_use: ["server_tool_use", "web_search", "server_tools"],
      image: ["image", "vision"],
      prompt_caching: ["prompt_caching", "prompt-caching", "cache"],
      // The profile declares structured output per shape
      // (`responseJsonObject` / `responseJsonSchema`), so either satisfies the
      // single `response_format` requirement.
      response_format: [
        "response_format",
        "structured_outputs",
        "response_format.json_schema",
        "responseJsonObject",
        "responseJsonSchema",
      ],
      parallel_tool_calls: ["parallel_tool_calls", "parallelToolCalls"],
    };
  return aliases[capability];
}

function supportsCapability(
  capability: ClaudeRequestCapability,
  capabilities: Readonly<Record<string, boolean>> | undefined,
): boolean {
  if (!capabilities) return false;
  const normalized = new Map<string, boolean>();
  for (const [key, enabled] of Object.entries(capabilities))
    normalized.set(canonicalCapabilityName(key), enabled === true);
  return capabilityAliases(capability).some(
    (key) => normalized.get(canonicalCapabilityName(key)) === true,
  );
}

function requiredCapabilities(
  request: CanonicalRequest,
): readonly ClaudeRequestCapability[] {
  const parts = allParts(request);
  const required: ClaudeRequestCapability[] = [];
  if (
    request.tools?.length ||
    parts.some((part) => part.kind === "toolCall" || part.kind === "toolResult")
  )
    required.push("tools");
  if (request.reasoning && request.reasoning.thinking_type !== "disabled")
    required.push("reasoning");
  if (hasKind(parts, "reasoning")) required.push("reasoning");
  if (hasOpaqueReasoning(parts)) required.push("redacted_thinking");
  if (
    hasExtension(parts, "server_tool_use") ||
    hasExtension(parts, "search_result")
  )
    required.push("server_tool_use");
  if (parts.some((part) => part.kind === "image")) required.push("image");
  if (request.cache_hint) required.push("prompt_caching");
  if (request.response_format) required.push("response_format");
  if (request.generation_controls.parallel_tool_calls === true)
    required.push("parallel_tool_calls");
  return [...new Set(required)];
}

/**
 * Whether a request declares tool definitions or continues an in-progress
 * tool-call turn — mirrors `requiredCapabilities`'s "tools" signal. Selects
 * the agent vs. utility Claude Code beta profile (`defaultBetaInput`).
 */
export function requestHasClaudeTools(request: CanonicalRequest): boolean {
  return (
    (request.tools?.length ?? 0) > 0 ||
    allParts(request).some(
      (part) => part.kind === "toolCall" || part.kind === "toolResult",
    )
  );
}

/**
 * Checks Claude Code semantics before a provider/account lease. Unsupported
 * features become explicit rejections by default; callers may opt into an
 * operator-visible downgrade result, but this function never mutates content
 * or invents a replacement thinking/attestation block.
 */
export function assessClaudeCodeCompatibility(
  request: CanonicalRequest,
  options: {
    readonly capabilities?: Readonly<Record<string, boolean>>;
    readonly allow_downgrade?: boolean;
    readonly beta_header?: string | undefined;
    readonly beta_policy?: AnthropicBetaUnsupportedPolicy;
    readonly credential_kind?: CredentialKind;
    readonly target_provider?: string;
  } = {},
): ClaudeCompatibilityAssessment {
  const betaOptions = {
    unsupported: options.beta_policy ?? "reject",
    target_provider: options.target_provider ?? "claude",
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    ...(options.credential_kind === undefined
      ? {}
      : { credential_kind: options.credential_kind }),
  };
  const betas = negotiateAnthropicBetas(options.beta_header, betaOptions);
  const rejected: ClaudeCapabilityIssue[] = betas.rejected.map((beta) => ({
    capability: beta.capability,
    reason: "target_capability_missing",
    action: "reject",
  }));
  const downgraded: ClaudeCapabilityIssue[] = betas.downgraded.map((beta) => ({
    capability: beta.capability,
    reason: "target_capability_missing",
    action: "downgrade",
  }));
  for (const capability of requiredCapabilities(request)) {
    if (supportsCapability(capability, options.capabilities)) continue;
    const issue: ClaudeCapabilityIssue = {
      capability,
      reason:
        options.allow_downgrade === true
          ? "target_capability_missing"
          : "policy_disallows_loss",
      action: options.allow_downgrade === true ? "downgrade" : "reject",
    };
    if (issue.action === "downgrade") downgraded.push(issue);
    else rejected.push(issue);
  }
  return {
    accepted: [...betas.accepted],
    downgraded,
    rejected,
    betas,
  };
}

/** Throws one typed capability error for a failed Claude Code assessment. */
export function assertClaudeCodeCompatibility(
  assessment: ClaudeCompatibilityAssessment,
): ClaudeCompatibilityAssessment {
  const first = assessment.rejected[0];
  if (!first) return assessment;
  throw capabilityUnsupported(first.capability, {
    rejected_capabilities: assessment.rejected.map((issue) => issue.capability),
    downgraded_capabilities: assessment.downgraded.map(
      (issue) => issue.capability,
    ),
  });
}

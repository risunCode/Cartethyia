import { classifyProviderFailure, type ProviderCallError, type ProviderFailureCode, type ProviderRequest } from "../../application/contracts";
import type { CompatibilityRejection } from "./context";
import { isRecord } from "../../application/protocols";

/** Reasons returned by the bounded provider-local retry policy. */
export type ProviderRetryReason =
  | ProviderFailureCode
  | "retry_exhausted"
  | "semantic_output"
  | "post_semantic_failure";

/** Attempt phase used by the provider-local retry policy. */
export type ProviderRetryPhase = "pre_response" | "pre_content" | "streaming" | "post_semantic" | "post_content" | "terminal";

/** Output state used by the provider-local retry policy. */
export type ProviderRetryOutputState = "none" | "lifecycle" | "semantic" | "terminal";

/**
 * Bounded, side-effect-free state supplied to {@link decideProviderRetry}.
 *
 * `retryCount` is the number of provider-local retries already consumed. The
 * optional aliases keep the helper easy to use with existing stream lifecycle
 * state while retaining a conservative default of no output.
 */
export interface ProviderRetryState {
  readonly phase: ProviderRetryPhase;
  readonly output?: ProviderRetryOutputState;
  readonly outputState?: ProviderRetryOutputState;
  readonly semanticOutput?: boolean;
  readonly terminalSeen?: boolean;
  readonly retryCount?: number;
  readonly retries?: number;
}

/** Result of a provider-local retry policy evaluation. */
export interface ProviderRetryDecision {
  readonly retryable: boolean;
  readonly reason: ProviderRetryReason;
}

const PROVIDER_LOCAL_RETRY_CODES: readonly ProviderFailureCode[] = [
  "stale_response_state",
  "empty_provider_body",
  "provider_finish_error",
  "optional_parameter_rejected",
];

/**
 * Decides whether a provider failure can be retried locally without replaying
 * semantic output. The policy permits at most one retry and never inspects or
 * returns an upstream body.
 */
export function decideProviderRetry(error: ProviderCallError, state: ProviderRetryState): ProviderRetryDecision {
  const output = state.outputState ?? state.output;
  const semanticOutput = state.semanticOutput === true || output === "semantic";
  const terminalSeen = state.terminalSeen === true || output === "terminal";
  const retryCount = state.retryCount ?? state.retries ?? 0;
  const code = providerFailureCode(error);

  if (semanticOutput || terminalSeen) {
    return { retryable: false, reason: terminalSeen ? "post_semantic_failure" : "semantic_output" };
  }
  if (!Number.isFinite(retryCount) || retryCount < 0 || retryCount >= 1) {
    return { retryable: false, reason: "retry_exhausted" };
  }
  if (state.phase !== "pre_response" && state.phase !== "pre_content") {
    return { retryable: false, reason: "post_semantic_failure" };
  }
  if ((PROVIDER_LOCAL_RETRY_CODES as readonly ProviderFailureCode[]).includes(code)) {
    return { retryable: true, reason: code };
  }
  return { retryable: false, reason: code };
}

function providerFailureCode(error: ProviderCallError): ProviderFailureCode {
  if (error.failureCode !== undefined) return error.failureCode;
  return classifyProviderFailure({
    statusCode: error.statusCode,
    message: error.sanitizedMessage,
    kind: error.kind,
  });
}

/** Classifies explicit optional-parameter rejections for a bounded fallback. */
export function classifyCompatibilityRejection(error: ProviderCallError): CompatibilityRejection | null {
  const stableCode = error.failureCode;
  if (stableCode !== undefined && stableCode !== "optional_parameter_rejected") return null;
  if (stableCode === undefined && error.statusCode !== 400) return null;
  const message = error.sanitizedMessage.toLowerCase();
  const fieldPath = extractRejectedField(message);
  if (fieldPath === null) return null;
  const category = compatibilityCategory(fieldPath, message);
  const optional = isOptionalProjectionPath(fieldPath);
  return { category, fieldPath, optional, retryable: optional };
}

/** Records a secret-free compatibility retry decision for request metadata. */
export function recordCompatibilityFallback(request: ProviderRequest, rejection: CompatibilityRejection): void {
  const fieldPath = isOptionalProjectionPath(rejection.fieldPath) ? normalizeFieldPath(rejection.fieldPath) : "optional provider projection";
  request.recordDiagnostic?.({
    stage: "policy",
    sourceFormat: request.request.sourceSurface,
    targetSurface: request.target.surface,
    fieldCategory: rejection.category,
    action: "fallback",
    reason: `retried without ${fieldPath}`,
  });
}

/** Removes one allowlisted optional projection while preserving semantic content. */
export function removeCompatibilityProjection(payload: Record<string, unknown>, rejection: CompatibilityRejection): boolean {
  if (!rejection.optional || !rejection.retryable) return false;
  const path = normalizeFieldPath(rejection.fieldPath);
  if (!isOptionalProjectionPath(path)) return false;
  if (path === "prompt_cache_options") {
    delete payload.prompt_cache_options;
    removeNestedField(payload.input, "prompt_cache_breakpoint");
    removeNestedField(payload.messages, "prompt_cache_breakpoint");
    return true;
  }
  if (path.startsWith("prompt_cache_options.")) {
    return removeNestedField(payload.prompt_cache_options, path.slice("prompt_cache_options.".length));
  }
  if (path === "prompt_cache_breakpoint") {
    return removeNestedField(payload.input, "prompt_cache_breakpoint") || removeNestedField(payload.messages, "prompt_cache_breakpoint");
  }
  if (path === "reasoning") return deletePayloadField(payload, "reasoning");
  if (path.startsWith("reasoning.")) return removeNestedField(payload.reasoning, path.slice("reasoning.".length));
  if (path === "reasoning_effort" || path === "thinking") return deletePayloadField(payload, path);
  if (path === "output_config") return deletePayloadField(payload, path);
  if (path.startsWith("output_config.")) return removeNestedField(payload.output_config, path.slice("output_config.".length));
  if (path === "response_format" || path === "parallel_tool_calls" || path === "tool_choice" || path === "stream_options") {
    return deletePayloadField(payload, path);
  }
  return false;
}

function compatibilityCategory(fieldPath: string, message: string): CompatibilityRejection["category"] {
  if (/cache|prompt_cache/.test(fieldPath) || /cache/.test(message)) return "unsupported-cache";
  if (/reasoning|effort|thinking/.test(fieldPath) || /reasoning|effort|thinking/.test(message)) return "unsupported-reasoning";
  if (/tool/.test(fieldPath) || /tool/.test(message)) return "unsupported-tool";
  if (/response|format|json/.test(fieldPath) || /response|format|json/.test(message)) return "unsupported-response";
  return "unsupported-field";
}

function isOptionalProjectionPath(value: string): boolean {
  const path = normalizeFieldPath(value);
  if (path === "prompt_cache_options" || path === "prompt_cache_breakpoint") return true;
  if (path.startsWith("prompt_cache_options.")) return true;
  if (path === "reasoning" || path === "reasoning_effort" || path === "thinking") return true;
  if (/^reasoning\.(?:effort|max_tokens|summary|exclude|enabled|mode)$/.test(path)) return true;
  if (path === "output_config" || /^output_config\.effort$/.test(path)) return true;
  return path === "response_format" || path === "parallel_tool_calls" || path === "tool_choice" || path === "stream_options";
}

function normalizeFieldPath(value: string): string {
  return value.trim().toLowerCase().replace(/^["'`]|["'`]$/g, "");
}

function extractRejectedField(message: string): string | null {
  const match = message.match(/(?:unsupported parameter|parameter unsupported|unknown parameter|invalid parameter|unsupported field|unknown field)[:\s]+["'`]?([a-z][a-z0-9_.-]*)/i);
  if (match?.[1] !== undefined) return normalizeFieldPath(match[1]);
  const known = ["prompt_cache_options", "prompt_cache_breakpoint", "reasoning.max_tokens", "reasoning.effort", "output_config.effort", "response_format", "parallel_tool_calls", "tool_choice", "stream_options"];
  return known.find((field) => message.includes(field)) ?? null;
}

function removeNestedField(value: unknown, field: string): boolean {
  let removed = false;
  if (Array.isArray(value)) {
    for (const item of value) removed ||= removeNestedField(item, field);
    return removed;
  }
  if (!isRecord(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, field)) {
    delete value[field];
    removed = true;
  }
  for (const child of Object.values(value)) removed ||= removeNestedField(child, field);
  return removed;
}

function deletePayloadField(payload: Record<string, unknown>, field: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) return false;
  delete payload[field];
  return true;
}

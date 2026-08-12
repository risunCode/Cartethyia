import type { ProviderCallError, ProviderRequest } from "../../application/contracts";
import type { CompatibilityRejection } from "./context";
import { isRecord } from "../../application/protocols";

/** Classifies only explicit optional-parameter rejections eligible for one retry. */
export function classifyCompatibilityRejection(error: ProviderCallError): CompatibilityRejection | null {
  if (error.statusCode !== 400) return null;
  const message = error.sanitizedMessage.toLowerCase();
  const fieldPath = extractRejectedField(message);
  if (fieldPath === null) return null;
  if (/cache|prompt_cache/.test(fieldPath) || /cache/.test(message)) {
    return { category: "unsupported-cache", fieldPath, optional: true, retryable: true };
  }
  if (/reasoning|effort|thinking/.test(fieldPath) || /reasoning|effort|thinking/.test(message)) {
    return { category: "unsupported-reasoning", fieldPath, optional: true, retryable: true };
  }
  if (/tool/.test(fieldPath) || /tool/.test(message)) {
    return { category: "unsupported-tool", fieldPath, optional: true, retryable: true };
  }
  if (/response|format|json/.test(fieldPath) || /response|format|json/.test(message)) {
    return { category: "unsupported-response", fieldPath, optional: true, retryable: true };
  }
  return { category: "unsupported-field", fieldPath, optional: true, retryable: true };
}

/** Records a secret-free compatibility retry decision for request metadata. */
export function recordCompatibilityFallback(request: ProviderRequest, rejection: CompatibilityRejection): void {
  request.recordDiagnostic?.({
    stage: "policy",
    sourceFormat: request.request.sourceSurface,
    targetSurface: request.target.surface,
    fieldCategory: rejection.category,
    action: "fallback",
    reason: `retried without ${rejection.fieldPath}`,
  });
}

/** Removes one allowlisted optional projection while preserving semantic content. */
export function removeCompatibilityProjection(payload: Record<string, unknown>, rejection: CompatibilityRejection): boolean {
  const path = rejection.fieldPath.toLowerCase();
  if (path.includes("prompt_cache_options") || path.includes("prompt_cache_breakpoint")) {
    delete payload.prompt_cache_options;
    removeNestedField(payload.input, "prompt_cache_breakpoint");
    removeNestedField(payload.messages, "prompt_cache_breakpoint");
    return true;
  }
  if (path.includes("reasoning.max_tokens")) {
    return removeNestedField(payload.reasoning, "max_tokens");
  }
  if (path.includes("output_config.effort")) {
    return removeNestedField(payload.output_config, "effort");
  }
  if (path.includes("reasoning")) {
    delete payload.reasoning;
    delete payload.reasoning_effort;
    delete payload.thinking;
    delete payload.output_config;
    return true;
  }
  if (path.includes("response_format")) return deletePayloadField(payload, "response_format");
  if (path.includes("parallel_tool_calls")) return deletePayloadField(payload, "parallel_tool_calls");
  return deletePayloadField(payload, rejection.fieldPath);
}

function extractRejectedField(message: string): string | null {
  const match = message.match(/(?:unsupported parameter|unknown parameter|invalid parameter|unsupported field|unknown field)[:\s]+["'`]?([a-z][a-z0-9_.-]*)/i);
  if (match?.[1] !== undefined) return match[1];
  const known = ["prompt_cache_options", "prompt_cache_breakpoint", "reasoning.max_tokens", "output_config.effort", "response_format", "parallel_tool_calls"];
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

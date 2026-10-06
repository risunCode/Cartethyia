// Provider-neutral generation-controls normalization, used only after
// capability preflight.
import type { GenerationControls } from "../../protocol/canonical-model";

/** Normalizes the output-token control family onto `max_output_tokens`. */
export function normalizeGenerationControls(controls: GenerationControls): GenerationControls {
  const normalized: GenerationControls = { ...controls };
  if (
    normalized.max_output_tokens === undefined &&
    normalized.max_completion_tokens !== undefined
  ) {
    normalized.max_output_tokens = normalized.max_completion_tokens;
  }
  if (normalized.max_output_tokens === undefined && normalized.max_tokens !== undefined) {
    normalized.max_output_tokens = normalized.max_tokens;
  }
  return normalized;
}

/** Normalizes maximum output tokens for wires that only accept `max_tokens`. */
export function normalizeWireMaxTokens(controls: GenerationControls): GenerationControls {
  const normalized = normalizeGenerationControls(controls);
  if (normalized.max_tokens === undefined && normalized.max_output_tokens !== undefined) {
    normalized.max_tokens = normalized.max_output_tokens;
  }
  return normalized;
}

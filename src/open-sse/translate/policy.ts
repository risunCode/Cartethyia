import type { ProxyRequest, Surface } from "../../application/contracts";

/** Global decision for source-wire preservation versus protocol adaptation. */
export type TranslationAction = "preserve" | "adapt";

export function translationAction(sourceSurface: Surface, targetSurface: Surface): TranslationAction {
  return sourceSurface === targetSurface ? "preserve" : "adapt";
}

/**
 * Preserves source-protocol fields that have no canonical representation only
 * when the target surface is identical. Cross-protocol adapters remain the
 * sole authority for adapting those fields.
 */
export function preserveWireFields(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  targetSurface: Surface,
  canonicalFields: readonly string[],
): void {
  if (translationAction(request.sourceSurface, targetSurface) !== "preserve" || request.wirePayload === undefined) return;
  for (const [key, value] of Object.entries(request.wirePayload)) {
    if (!canonicalFields.includes(key)) payload[key] = value;
  }
}

/** Restores a canonical field from the exact source wire payload on same-surface routes. */
export function preserveWireField(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  targetSurface: Surface,
  field: string,
): void {
  if (translationAction(request.sourceSurface, targetSurface) !== "preserve" || request.wirePayload === undefined) return;
  if (Object.prototype.hasOwnProperty.call(request.wirePayload, field)) payload[field] = request.wirePayload[field];
}

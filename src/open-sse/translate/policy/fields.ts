import type { ProxyRequest, Surface } from "../../../application/contracts";

/** Global decision for source-wire preservation versus protocol adaptation. */
export type TranslationAction = "preserve" | "adapt";

export function translationAction(sourceSurface: Surface, targetSurface: Surface): TranslationAction {
  return sourceSurface === targetSurface ? "preserve" : "adapt";
}

/**
 * Preserves source-protocol fields on same-surface payloads and restores
 * canonical fields from the exact source body. Cross-surface payloads receive
 * only the explicit target adapter output.
 */
export function preserveWirePayload(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  targetSurface: Surface,
  canonicalFields: readonly string[],
): void {
  if (translationAction(request.sourceSurface, targetSurface) !== "preserve" || request.wirePayload === undefined) return;
  for (const [key, value] of Object.entries(request.wirePayload)) {
    if (!canonicalFields.includes(key)) payload[key] = value;
  }
  for (const field of canonicalFields) {
    if (Object.prototype.hasOwnProperty.call(request.wirePayload, field)) payload[field] = request.wirePayload[field];
  }
}

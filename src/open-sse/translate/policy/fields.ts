import type { ProxyRequest, Surface } from "../../../application/contracts";
import { preserveWireExtensions } from "./extensions";

/** Global decision for source-wire preservation versus protocol adaptation. */
export type TranslationAction = "preserve" | "adapt";

export function translationAction(sourceSurface: Surface, targetSurface: Surface): TranslationAction {
  return sourceSurface === targetSurface ? "preserve" : "adapt";
}

/**
 * Preserves only bounded, explicitly registered source-wire extensions while
 * restoring canonical fields that were deliberately normalized.
 */
export function preserveWirePayload(
  payload: Record<string, unknown>,
  request: ProxyRequest,
  targetSurface: Surface,
  canonicalFields: readonly string[],
): void {
  if (translationAction(request.sourceSurface, targetSurface) !== "preserve") return;
  preserveWireExtensions(payload, request, targetSurface, canonicalFields);
}

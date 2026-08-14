import type { Surface } from "../../application/contracts";
import type { ResponseDocument } from "./contracts";

export interface ResponseTranslationContext {
  readonly sourceSurface: Surface;
  readonly targetSurface: Surface;
  readonly model: string;
}

export type ResponseProjector = (
  document: ResponseDocument,
  context: ResponseTranslationContext,
) => ResponseDocument;

const registry = new Map<Surface, Map<Surface, ResponseProjector>>();

/** Registers one direct semantic response projection edge. */
export function registerResponseTranslation(from: Surface, to: Surface, projector: ResponseProjector): void {
  let targets = registry.get(from);
  if (targets === undefined) {
    targets = new Map<Surface, ResponseProjector>();
    registry.set(from, targets);
  }
  targets.set(to, projector);
}

/** Looks up a direct semantic response projection edge. */
export function lookupResponseTranslation(from: Surface, to: Surface): ResponseProjector | undefined {
  return registry.get(from)?.get(to);
}

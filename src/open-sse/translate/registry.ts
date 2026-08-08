import type { Surface } from "../../application/contracts";

export type BodyConverter = (body: Record<string, unknown>) => Record<string, unknown>;

const registry = new Map<Surface, Map<Surface, BodyConverter>>();

/** Registers one cross-surface body conversion. Later registrations replace the same edge. */
export function registerTranslation(from: Surface, to: Surface, converter: BodyConverter): void {
  let targets = registry.get(from);
  if (targets === undefined) {
    targets = new Map<Surface, BodyConverter>();
    registry.set(from, targets);
  }
  targets.set(to, converter);
}

/** Looks up a direct conversion edge. */
export function lookupTranslation(from: Surface, to: Surface): BodyConverter | undefined {
  return registry.get(from)?.get(to);
}

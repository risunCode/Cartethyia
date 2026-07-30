/**
 * Combo rotation strategy — single source of truth. Previously redefined
 * inline as `"fallback" | "round-robin"` in `routing/resolve.ts`,
 * `console/db/repos/combos.ts`, and `console/api/combos.ts` (REQ-2).
 *
 * Not to be confused with `RoutingStrategy` in `console/db/repos/routing.ts`
 * (`"priority" | "round-robin"`), which governs per-provider account
 * selection — a distinct, intentionally separate concept.
 */

import { isOneOf } from "../shared/guards";

export const ROTATION_STRATEGIES = ["fallback", "round-robin"] as const;

export type RotationStrategy = (typeof ROTATION_STRATEGIES)[number];

export function isRotationStrategy(value: unknown): value is RotationStrategy {
  return isOneOf(value, ROTATION_STRATEGIES);
}

import type { ReasoningEffort, Surface } from "../../../application/contracts";

/** Normalizes client-specific effort names into the canonical reasoning contract. */
export function normalizeClientEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return "medium";
  const normalized = value.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized === "") return undefined;
  if (normalized === "none" || normalized === "off" || normalized === "disabled") return "none";
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium" || normalized === "default" || normalized === "auto") return "medium";
  if (normalized === "high") return "high";
  if (normalized === "xhigh" || normalized === "max" || normalized === "maximum" || normalized === "ultra" || normalized === "ultrahigh" || normalized === "ultracode") return "xhigh";
  return "medium";
}

/** Projects canonical effort into a target protocol vocabulary. */
export function projectEffort(value: unknown, targetSurface: Surface, supported: readonly ReasoningEffort[] = []): ReasoningEffort | undefined {
  const effort = normalizeClientEffort(value);
  if (effort === undefined || effort === "none") return effort;
  if (targetSurface === "anthropic-messages") {
    if (effort === "minimal" || effort === "low") return "low";
    if (effort === "xhigh" || effort === "high") return "high";
    return "medium";
  }
  if (supported.length === 0 || supported.includes(effort)) return effort;
  if (effort === "xhigh" && supported.includes("high")) return "high";
  if (effort === "minimal" && supported.includes("low")) return "low";
  if (supported.includes("medium")) return "medium";
  return supported[0];
}

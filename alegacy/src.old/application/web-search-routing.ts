import type { NormalizedTool, WebSearchPreference, WebSearchRouteKind } from "./contracts";

export const WEB_SEARCH_ROUTE_ORDER: readonly WebSearchRouteKind[] = ["native", "codex", "antigravity", "exa"];

export const WEB_SEARCH_ROUTE_LABELS: Readonly<Record<WebSearchRouteKind, string>> = {
  native: "Native search",
  codex: "Codex",
  antigravity: "Antigravity",
  exa: "Exa",
  passthrough: "Original route passthrough",
};

export interface WebSearchPreferenceOption {
  readonly value: WebSearchPreference;
  readonly label: string;
}

export const WEB_SEARCH_PREFERENCE_OPTIONS: readonly WebSearchPreferenceOption[] = [
  { value: "auto", label: "Automatic" },
  { value: "prefer-codex", label: "Prefer Codex" },
  { value: "prefer-exa", label: "Prefer Exa" },
];

export function isWebSearchPreference(value: unknown): value is WebSearchPreference {
  return value === "auto" || value === "prefer-codex" || value === "prefer-exa";
}

export function normalizeWebSearchPreference(value: unknown): WebSearchPreference {
  return isWebSearchPreference(value) ? value : "auto";
}

export function isWebSearchRouteKind(value: unknown): value is WebSearchRouteKind {
  return value === "native" || value === "codex" || value === "antigravity" || value === "exa" || value === "passthrough";
}

export function webSearchPreferenceOrder(preference: WebSearchPreference): readonly WebSearchRouteKind[] {
  if (preference === "prefer-codex") return ["codex", "native", "antigravity", "exa"];
  if (preference === "prefer-exa") return ["exa", "native", "codex", "antigravity"];
  return WEB_SEARCH_ROUTE_ORDER;
}

/** Returns whether a normalized tool requests web-search execution. */
export function isWebSearchTool(tool: Pick<NormalizedTool, "name" | "nativeType">): boolean {
  const normalizedName = tool.name.toLowerCase().replace(/[^a-z]/g, "");
  return normalizedName === "websearch"
    || normalizedName === "websearchpreview"
    || tool.nativeType?.startsWith("web_search_") === true;
}

export interface WebSearchCapabilityInput {
  readonly search?: boolean;
  readonly websearch?: boolean;
  readonly surfaces?: readonly string[];
}

/** Returns whether a provider or model capability declaration supports search. */
export function hasWebSearchCapability(value: WebSearchCapabilityInput | null | undefined): boolean {
  return value?.search === true
    || value?.websearch === true
    || value?.surfaces?.includes("web-search") === true;
}

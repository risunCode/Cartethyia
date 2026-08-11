import { describe, expect, test } from "bun:test";
import { hasWebSearchCapability, isWebSearchPreference, isWebSearchRouteKind, isWebSearchTool, normalizeWebSearchPreference, webSearchPreferenceOrder } from "../../src/application/web-search-routing";

describe("web-search routing policy", () => {
  test("normalizes preferences and keeps one order definition", () => {
    expect(isWebSearchPreference("prefer-exa")).toBe(true);
    expect(isWebSearchPreference("invalid")).toBe(false);
    expect(normalizeWebSearchPreference("invalid")).toBe("auto");
    expect(webSearchPreferenceOrder("auto")).toEqual(["native", "codex", "antigravity", "exa"]);
    expect(webSearchPreferenceOrder("prefer-codex")).toEqual(["codex", "native", "antigravity", "exa"]);
    expect(webSearchPreferenceOrder("prefer-exa")).toEqual(["exa", "native", "codex", "antigravity"]);
  });

  test("accepts every internal route kind including passthrough", () => {
    expect(isWebSearchRouteKind("native")).toBe(true);
    expect(isWebSearchRouteKind("passthrough")).toBe(true);
    expect(isWebSearchRouteKind("unknown")).toBe(false);
  });

  test("shares search capability and tool detection semantics", () => {
    expect(hasWebSearchCapability({ search: true })).toBe(true);
    expect(hasWebSearchCapability({ surfaces: ["web-search"] })).toBe(true);
    expect(hasWebSearchCapability({ websearch: false, surfaces: ["openai-chat"] })).toBe(false);
    expect(isWebSearchTool({ name: "web_search_preview" })).toBe(true);
    expect(isWebSearchTool({ name: "tool", nativeType: "web_search_20260318" })).toBe(true);
    expect(isWebSearchTool({ name: "search" })).toBe(false);
  });
});

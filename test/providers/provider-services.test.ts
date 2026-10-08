import { describe, expect, test } from "bun:test";
import {
  BUNDLED_PROVIDER_METADATA,
  providerServiceKinds,
  providerSupportsWebSearch,
} from "../../src/providers/provider-metadata";
import { sanitizeProviderResponse } from "../../src/console/providers/catalog/provider-operations";
describe("provider service taxonomy", () => {
  test("defaults providers to LLM and declares real search surfaces", () => {
    expect(providerServiceKinds("openai")).toEqual(["llm"]);
    expect(providerServiceKinds("gemini")).toEqual(["llm", "websearch"]);
    expect(providerServiceKinds("codex")).toEqual(["llm", "websearch"]);
    expect(providerServiceKinds("exa")).toEqual(["websearch"]);
    expect(providerServiceKinds("custom-provider")).toEqual(["llm"]);
    for (const provider of BUNDLED_PROVIDER_METADATA)
      expect(provider.serviceKinds).not.toContain("all");
  });
  // Web search is a provider capability, not a per-model flag: the adapter
  // either frames a hosted search tool or it does not.
  test("search-capable providers are declared at the provider level", () => {
    expect(providerSupportsWebSearch("claude")).toBe(true);
    expect(providerSupportsWebSearch("gemini")).toBe(true);
    expect(providerSupportsWebSearch("codex")).toBe(true);
    expect(providerSupportsWebSearch("antigravity")).toBe(true);
    // A pure search provider answers `/v1/search`, never a chat turn.
    expect(providerSupportsWebSearch("exa")).toBe(false);
    expect(providerSupportsWebSearch("cb")).toBe(false);
  });

  test("sanitized custom provider responses never expose an all category", () => {
    const response = sanitizeProviderResponse({
      providerId: "custom-provider",
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
    });
    expect(response.serviceKinds).toEqual(["llm"]);
    expect(response.serviceKinds).not.toContain("all");
  });
});

import { describe, expect, test } from "bun:test";
import { BUNDLED_PROVIDER_METADATA, providerServiceKinds, providerSupportsWebSearch } from "../../src/providers/metadata";
import { sanitizeProviderResponse } from "../../src/console/providers/catalog/provider-operations";
describe("provider service taxonomy", () => {
  test("declares real search surfaces and keeps bundled providers explicit", () => {
    expect(providerServiceKinds("openai")).toEqual(["llm"]);
    expect(providerServiceKinds("gemini")).toEqual(["llm", "websearch"]);
    expect(providerServiceKinds("codex")).toEqual(["llm", "websearch"]);
    expect(providerServiceKinds("exa")).toEqual(["websearch"]);
    // A bundled provider without a declaration serves LLM only — the
    // declaration is authoritative, so `llm` is not read as "everything".
    expect(providerServiceKinds("cbcn")).toEqual(["llm"]);
    for (const provider of BUNDLED_PROVIDER_METADATA)
      expect(provider.serviceKinds).not.toContain("all");
  });

  test("a custom provider may serve every media surface", () => {
    // A BYOK provider has no manifest row. It is read as able to serve the
    // generation surfaces too, because the operator chose its base URL and the
    // upstream — not the gateway — is what decides whether it can answer. A
    // bundled provider is still explicit: `llm` alone means LLM only.
    expect(providerServiceKinds("custom-provider")).toEqual([
      "llm",
      "imageGeneration",
      "videoGeneration",
    ]);
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
    // The kinds are derived from the taxonomy, so a custom provider reports the
    // media surfaces it may serve — never a literal "all", which would be an
    // undeclared capability.
    expect(response.serviceKinds).toEqual([
      "llm",
      "imageGeneration",
      "videoGeneration",
    ]);
    expect(response.serviceKinds).not.toContain("all");
  });
});

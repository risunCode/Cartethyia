import { describe, expect, test } from "bun:test";
import { capabilitiesOf } from "../../src/open-sse/transport/catalog";
import { applyProviderQuirkPolicy, applyRequiredProviderHeaders, fromCaps, resolveModelCapabilities } from "../../src/open-sse/translate";

describe("provider capability profiles", () => {
  test("preserves declarative reasoning and quirk policies", () => {
    const capabilities = capabilitiesOf({
      surfaces: ["openai-responses"],
      reasoning: true,
      reasoningCapability: { enabled: true, format: "openai", canDisable: true, minBudget: 256, maxBudget: 32_000 },
      quirks: { droppedFields: ["stop"], clampedFields: { temperature: { min: 0, max: 1 } }, supportedResponseControls: ["temperature"] },
    });

    expect(capabilities.reasoningCapability).toEqual({ enabled: true, format: "openai", canDisable: true, minBudget: 256, maxBudget: 32_000 });
    expect(capabilities.quirks?.droppedFields).toEqual(["stop"]);
  });

  test("applies field and header policies immutably", () => {
    const payload = { temperature: 2, stop: ["DONE"], model: "gpt-5" };
    const policy = { droppedFields: ["stop"], clampedFields: { temperature: { min: 0, max: 1 } }, requiredHeaders: { "anthropic-version": "2023-06-01" } };
    expect(applyProviderQuirkPolicy(payload, policy)).toEqual({ temperature: 1, model: "gpt-5" });
    expect(payload).toEqual({ temperature: 2, stop: ["DONE"], model: "gpt-5" });
    expect(applyRequiredProviderHeaders(new Headers({ authorization: "Bearer test" }), policy)).toEqual(new Headers({ authorization: "Bearer test", "anthropic-version": "2023-06-01" }));
  });

  test("resolves selected model capabilities instead of provider aggregate OR flags", () => {
    const provider = capabilitiesOf({ surfaces: ["openai-responses"], reasoning: true, explicitCache: true, promptCacheKey: true });
    const limited = {
      id: "gpt-basic",
      displayName: "Basic",
      capabilities: capabilitiesOf({ surfaces: ["openai-responses"], reasoning: false, explicitCache: false, promptCacheKey: false }),
    };
    const resolved = resolveModelCapabilities(provider, limited, "openai-responses");
    expect(resolved.reasoning.supported).toBe(false);
    expect(resolved.cache.key).toBe(false);
    expect(resolved.cache.breakpoints).toBe(false);
  });

  test("uses conservative optional defaults when model capabilities are unknown", () => {
    const provider = capabilitiesOf({ surfaces: ["openai-responses"], reasoning: true, explicitCache: true, promptCacheKey: true });
    const resolved = resolveModelCapabilities(provider, null, "openai-responses");
    expect(resolved.reasoning.supported).toBe(false);
    expect(resolved.cache.key).toBe(false);
    expect(resolved.tools.function).toBe(false);
  });
});

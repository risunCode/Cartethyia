import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "../../src/application/contracts";
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

  test("resolves every declared optional descriptor without inferring unrelated flags", () => {
    const provider = capabilitiesOf({
      surfaces: ["openai-responses"],
      reasoning: true,
      toolCalls: true,
      explicitCache: true,
      promptCacheKey: true,
      images: true,
      mediaGeneration: ["image", "video"],
    });
    const model: ProviderModel = {
      id: "gpt-declared",
      displayName: "Declared",
      capabilities: provider,
      compatibility: {
        reasoning: {
          efforts: ["low", "high"],
          effortMap: { low: "balanced", high: "deep" },
          budget: true,
          summary: false,
          disable: true,
        },
        sampling: { temperature: false, topP: true, stop: false },
        tools: { parallel: false, resultIdRequired: true, nativeTypes: ["web_search"] },
        cache: { mode: "explicit", ttl: true, breakpoints: 2, minimumPrefixTokens: 1024 },
        responseState: { previousResponseId: true, staleRepair: true },
        streamUsage: true,
        timeoutProfile: { firstByteMs: 800, idleMs: 2_000 },
      },
    };

    const resolved = resolveModelCapabilities(provider, model, "openai-responses");
    expect(resolved.reasoning).toMatchObject({
      supported: true,
      efforts: ["low", "high"],
      effortMap: { low: "balanced", high: "deep" },
      maxTokens: "supported",
      budget: true,
      summary: false,
      disable: true,
    });
    expect(resolved.sampling).toEqual({ temperature: false, topP: true, stop: false });
    expect(resolved.tools).toMatchObject({ function: true, native: ["web_search"], nativeTypes: ["web_search"], parallel: false, resultIdRequired: true });
    expect(resolved.cache).toMatchObject({
      mode: "explicit",
      read: true,
      write: true,
      key: true,
      breakpoints: true,
      breakpointLimit: 2,
      minimumPrefixTokens: 1024,
      ttl: ["30m", "5m", "1h"],
    });
    expect(resolved.responseState).toEqual({ previousResponseId: true, staleRepair: true });
    expect(resolved.streamUsage).toBe(true);
    expect(resolved.timeoutProfile).toEqual({ firstByteMs: 800, idleMs: 2_000 });
  });

  test("falls back to legacy caps while keeping parallel tools conservative", () => {
    const provider = capabilitiesOf({
      surfaces: ["openai-responses"],
      reasoning: true,
      reasoningCapability: { enabled: true, format: "openai", canDisable: true, maxBudget: 32_000 },
      toolCalls: true,
      explicitCache: true,
      promptCacheKey: true,
      quirks: { supportedResponseControls: ["temperature"] },
    });
    const resolved = fromCaps(provider, "openai-responses");

    expect(resolved.reasoning.efforts).toEqual(["xhigh", "high", "medium", "low", "minimal", "none"]);
    expect(resolved.reasoning.maxTokens).toBe("supported");
    expect(resolved.reasoning.summary).toBe(true);
    expect(resolved.reasoning.modes).toEqual(["standard", "pro"]);
    expect(resolved.sampling).toEqual({ temperature: true, topP: false, stop: false });
    expect(resolved.tools.function).toBe(true);
    expect(resolved.tools.parallel).toBe(false);
    expect(resolved.cache.mode).toBe("explicit");
    expect(resolved.cache.breakpoints).toBe(true);
  });

  test("disables all optional projections for an unknown model", () => {
    const provider = capabilitiesOf({
      surfaces: ["openai-responses"],
      streaming: true,
      reasoning: true,
      toolCalls: true,
      explicitCache: true,
      promptCacheKey: true,
      images: true,
      mediaGeneration: ["image"],
    });
    const resolved = resolveModelCapabilities(provider, null, "openai-responses");

    expect(resolved.reasoning).toMatchObject({ supported: false, efforts: [], maxTokens: "unknown", budget: false, summary: false, disable: false, modes: [] });
    expect(resolved.sampling).toEqual({ temperature: false, topP: false, stop: false });
    expect(resolved.tools).toEqual({ function: false, native: [], nativeTypes: [], parallel: false, resultIdRequired: false });
    expect(resolved.cache).toEqual({ mode: "none", read: false, write: false, key: false, breakpoints: false, ttl: [], options: [] });
    expect(resolved.responseState).toEqual({ previousResponseId: false, staleRepair: false });
    expect(resolved.streamUsage).toBe(false);
    expect(resolved.timeoutProfile).toEqual({});
    expect(resolved.media).toEqual({ images: false, generation: [] });
  });

  test("does not infer omitted members of an explicit descriptor", () => {
    const provider = capabilitiesOf({
      surfaces: ["openai-responses"],
      reasoning: true,
      reasoningCapability: { enabled: true, format: "openai", canDisable: true, maxBudget: 32_000 },
      toolCalls: true,
      explicitCache: true,
      promptCacheKey: true,
    });
    const model: ProviderModel = {
      id: "gpt-limited",
      displayName: "Limited",
      capabilities: provider,
      compatibility: {
        reasoning: { efforts: ["low"] },
        sampling: { supported: ["temperature"] },
        tools: {},
        cache: { mode: "none" },
        responseState: {},
        streamUsage: false,
        timeoutProfile: { firstByteMs: 0, idleMs: -1 },
      },
    };
    const resolved = resolveModelCapabilities(provider, model, "openai-responses");

    expect(resolved.reasoning.efforts).toEqual(["low"]);
    expect(resolved.reasoning.maxTokens).toBe("unknown");
    expect(resolved.reasoning.summary).toBe(false);
    expect(resolved.reasoning.disable).toBe(false);
    expect(resolved.sampling).toEqual({ temperature: true, topP: false, stop: false });
    expect(resolved.tools).toMatchObject({ function: true, native: [], parallel: false, resultIdRequired: false });
    expect(resolved.cache).toMatchObject({ mode: "none", read: false, write: false, key: false, breakpoints: false, ttl: [] });
    expect(resolved.responseState).toEqual({ previousResponseId: false, staleRepair: false });
    expect(resolved.streamUsage).toBe(false);
    expect(resolved.timeoutProfile).toEqual({});
  });

  test("retains semantic surface, stream, media, and function-tool capabilities", () => {
    const provider = capabilitiesOf({
      surfaces: ["openai-chat", "openai-responses", "images"],
      streaming: true,
      reasoning: false,
      toolCalls: true,
      images: true,
      mediaGeneration: ["image", "video"],
    });
    const model: ProviderModel = {
      id: "multimodal",
      displayName: "Multimodal",
      capabilities: provider,
      compatibility: { tools: { parallel: false }, cache: { mode: "none" } },
    };
    const resolved = resolveModelCapabilities(provider, model, "openai-chat");

    expect(resolved.surfaces).toEqual(["openai-chat", "openai-responses", "images"]);
    expect(resolved.streaming).toBe(true);
    expect(resolved.response).toEqual({ jsonObject: true, jsonSchema: true });
    expect(resolved.media).toEqual({ images: true, generation: ["image", "video"] });
    expect(resolved.tools.function).toBe(true);
  });
});

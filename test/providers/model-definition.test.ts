import { describe, expect, test } from "bun:test";

import {
  defineModel,
  isResponsesNativeModelId,
  resolveManualModelMetadata,
} from "../../src/providers/model-definition";

describe("defineModel", () => {
  test("takes limits and pricing from the base catalog but never capability", () => {
    // The bare-id lookup behind this fallback keeps only the first provider row
    // for a model id (`models-dev-catalog.ts`), so a capability read from it can
    // describe a different provider's serving of the same model. Limits and
    // price are facts about the model, so they still resolve; capability is a
    // routing gate and must be declared by the row.
    const row = defineModel({ id: "claude-4-6-sonnet" });
    expect(row.modalities.input).toEqual(["text"]);
    expect(row.reasoning).toBe(false);
    expect(row.contextLimit).toBeGreaterThan(200_000);
    expect(row.cost.pricing_model).toBe("pay-per-use");
  });

  test("declares exactly the capabilities the row names", () => {
    const row = defineModel({
      id: "claude-4-6-sonnet",
      vision: true,
      document: true,
      audio: true,
      reasoning: true,
    });
    expect(row.modalities.input).toEqual(["text", "image", "document", "audio"]);
    expect(row.reasoning).toBe(true);
  });

  test("never defaults a catalog row to tool-incapable", () => {
    // Capability preflight reads `toolCall` and strips `tools` when it is
    // false, so the shared default has to stay open.
    expect(defineModel({ id: "claude-4-6-sonnet" }).toolCall).toBe(true);
    expect(defineModel({ id: "claude-4-6-sonnet", toolCall: false }).toolCall).toBe(false);
  });

  test("an explicit row value outranks the catalog fallback", () => {
    const row = defineModel({ id: "claude-4-6-sonnet", ctx: 4096, out: 512 });
    expect(row.contextLimit).toBe(4096);
    expect(row.outputLimit).toBe(512);
  });
});

describe("isResponsesNativeModelId", () => {
  test("classifies the Responses-native families regardless of gateway prefix", () => {
    expect(isResponsesNativeModelId("gpt-5.6-terra")).toBe(true);
    expect(isResponsesNativeModelId("cx/gpt-5.6-terra")).toBe(true);
    expect(isResponsesNativeModelId("cb/gpt-5.6-luna")).toBe(true);
    expect(isResponsesNativeModelId("cx/gpt-6-astra")).toBe(true);
    expect(isResponsesNativeModelId("openai/o3-mini")).toBe(true);
    expect(isResponsesNativeModelId("openai/o4")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isResponsesNativeModelId("GPT-5.6-TERRA")).toBe(true);
    expect(isResponsesNativeModelId("OPENAI/O3-MINI")).toBe(true);
  });

  test("leaves chat-wire families alone", () => {
    // Only the GPT-5/6 and o3/o4 families speak native Responses. A gateway
    // listing a Claude or DeepSeek row must keep it on the chat wire.
    expect(isResponsesNativeModelId("ag/claude-opus-4-6")).toBe(false);
    expect(isResponsesNativeModelId("ali/deepseek-v4.1-flash")).toBe(false);
    expect(isResponsesNativeModelId("ag/gemini-3.7-flash-high")).toBe(false);
  });
});

describe("resolveManualModelMetadata", () => {
  test("always declares tools/vision/reasoning for a manual add", () => {
    const meta = resolveManualModelMetadata("cb", "hy4-preview");
    expect(meta.toolCall).toBe(true);
    expect(meta.reasoning).toBe(true);
    expect(meta.modalities.input).toContain("text");
    expect(meta.modalities.input).toContain("image");
  });

  test("never defaults a manually added model to tool-incapable", () => {
    // A manual add performs no probe and has no static catalog row, so
    // capabilities are declared up front. A false `toolCall` would make
    // capability preflight strip `tools` and the model would appear unable
    // to call tools at all.
    const meta = resolveManualModelMetadata("cb", "some-unlisted-model-id");
    expect(meta.toolCall).toBe(true);
    expect(meta.reasoning).toBe(true);
    expect(meta.modalities.input).toContain("image");
  });

  test("still takes non-capability facts from the base catalog when known", () => {
    // An exact provider row is the only lookup that can name the model's own
    // limits; `cb` has no row for this id, so ask a provider that does.
    const meta = resolveManualModelMetadata("anthropic", "claude-sonnet-4-6");
    expect(meta.contextLimit).toBeGreaterThan(0);
    expect(meta.modalities.output).toEqual(["text"]);
    expect(meta.webSearch).toBe(false);
  });

  test("leaves limits null rather than borrowing another provider's", () => {
    // `hy4-preview` is recorded under ~20 providers with three different
    // context limits. A bare lookup cannot say which is this model's, so the
    // manual-add path reports null and the console shows its own default —
    // never a stranger's number.
    const meta = resolveManualModelMetadata("cb", "hy4-preview");
    expect(meta.contextLimit).toBeNull();
    expect(meta.outputLimit).toBeNull();
    // Capability is still declared up front, independent of the lookup.
    expect(meta.toolCall).toBe(true);
    expect(meta.reasoning).toBe(true);
  });
});

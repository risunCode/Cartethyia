import { describe, expect, test } from "bun:test";
import { providerRegistry } from "../../src/upstream/providers/index";
import { lookupStaticTarget } from "../../src/routing/resolve";

describe("provider model catalogs", () => {
  test("resolves only exact upstream model IDs", () => {
    expect(providerRegistry.get("devin")?.models.resolve("swe-1-6-slow")?.id).toBe("swe-1-6-slow");
    expect(providerRegistry.get("kimchi")?.models.resolve("glm-5.2-fp8")?.id).toBe("glm-5.2-fp8");
    expect(providerRegistry.get("commandcode")?.models.resolve("deepseek/deepseek-v4-flash")?.id).toBe("deepseek/deepseek-v4-flash");
    expect(providerRegistry.get("opencode-free")?.models.resolve("deepseek-v4-flash-free")?.id).toBe("deepseek-v4-flash-free");
    expect(providerRegistry.get("qoder")?.models.resolve("qmodel_latest")?.id).toBe("qmodel_latest");

    expect(providerRegistry.get("devin")?.models.resolve("swe-1.6-slow")).toBeUndefined();
    expect(providerRegistry.get("kimchi")?.models.resolve("kini-k3")).toBeUndefined();
    expect(providerRegistry.get("commandcode")?.models.resolve("kimi-k2.6")).toBeUndefined();
    expect(providerRegistry.get("opencode-free")?.models.resolve("bigpickle")).toBeUndefined();
    expect(providerRegistry.get("qoder")?.models.resolve("qmodel-latest")).toBeUndefined();
  });

  test("reports reasoning/vision flags", () => {
    expect(providerRegistry.get("devin")?.models.resolve("swe-1-6-slow")?.reasoning).toBe(true);
    expect(providerRegistry.get("devin")?.models.resolve("swe-1-6-slow")?.vision).toBe(true);
    expect(providerRegistry.get("opencode-free")?.models.resolve("north-mini-code-free")?.vision).toBeUndefined();
    expect(providerRegistry.get("opencode-free")?.models.resolve("big-pickle")?.vision).toBe(true);
    expect(providerRegistry.get("opencode-free")?.models.resolve("big-pickle")?.reasoning).toBe(true);
    expect(providerRegistry.get("commandcode")?.models.resolve("moonshotai/Kimi-K2.6")?.reasoning).toBe(true);
  });

  test("lists provider models", () => {
    const devinModels = providerRegistry.get("devin")?.models.list() ?? [];
    expect(devinModels.length).toBeGreaterThan(0);
    expect(devinModels.some((m) => m.id === "swe-1-6-slow")).toBe(true);
    expect(devinModels.some((m) => m.id === "swe-1-7-medium")).toBe(true);
    expect(devinModels.some((m) => m.id === "nediun")).toBe(false);

    const opencodeModels = providerRegistry.get("opencode-free")?.models.list() ?? [];
    expect(opencodeModels.some((m) => m.id === "big-pickle")).toBe(true);
    expect(opencodeModels.some((m) => m.id === "deepseek-v4-flash-free")).toBe(true);
    expect(opencodeModels.some((m) => m.id === "north-mini-code-free")).toBe(true);
  });

  test("builds targets only for exact catalog IDs", () => {
    const devin = lookupStaticTarget("devin", "swe-1-6-slow");
    expect(devin?.modelId).toBe("swe-1-6-slow");
    expect(devin?.surface).toBe("devin-connect");

    const kimchi = lookupStaticTarget("kimchi", "glm-5.2-fp8");
    expect(kimchi?.modelId).toBe("glm-5.2-fp8");
    expect(kimchi?.surface).toBe("openai-chat");

    const opencode = lookupStaticTarget("opencode-free", "north-mini-code-free");
    expect(opencode?.modelId).toBe("north-mini-code-free");
    expect(opencode?.surface).toBe("openai-chat");

    expect(lookupStaticTarget("devin", "swe-1.6-slow")).toBeUndefined();
    expect(lookupStaticTarget("kimchi", "kini-k3")).toBeUndefined();
    expect(lookupStaticTarget("opencode-free", "northcode")).toBeUndefined();

    const qoder = lookupStaticTarget("qoder", "qmodel_latest");
    expect(qoder?.modelId).toBe("qmodel_latest");
    expect(qoder?.surface).toBe("openai-chat");
    expect(qoder?.credential).toBe("qoder-pat");
  });
});

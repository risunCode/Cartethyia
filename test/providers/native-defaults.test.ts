import { describe, expect, test } from "bun:test";
import { DEFAULT_NATIVE_PROVIDERS, NativeAdapter } from "../../src/providers/native";
import { ProviderAdapterError } from "../../src/providers/shared";

const byId = new Map(DEFAULT_NATIVE_PROVIDERS.map((config) => [config.id, config]));

describe("default native provider registry", () => {
  test("exposes unique provider ids", () => {
    const ids = DEFAULT_NATIVE_PROVIDERS.map((config) => config.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("exposes the legacy-compatible OpenAI-compatible identities", () => {
    expect([...byId.keys()].sort()).toEqual([
      "alibaba",
      "blackboxai",
      "cerebras",
      "deepseek",
      "fireworks",
      "groq",
      "mistral",
      "nvidia",
      "ollama",
      "opencodego",
      "openrouter",
      "siliconflow",
      "xiaomipg",
      "xiaomitp",
    ]);
  });

  test("blackboxai configures the legacy base URL and api-key auth", () => {
    const blackboxai = byId.get("blackboxai");
    expect(blackboxai).toBeDefined();
    expect(blackboxai!.baseUrl).toBe("https://api.blackbox.ai/v1");
    expect(blackboxai!.credentialKind).toBe("api_key");
    expect(blackboxai!.auth ?? "bearer").toBe("bearer");
  });
});

describe("NativeAdapter blackboxai catalog", () => {
  const adapter = new NativeAdapter(byId.get("blackboxai")!);

  test("blackboxai catalog is permissive (empty storedModels → any model resolves)", () => {
    // The blackboxai provider config may have an empty model list from MODEL_DATA;
    // NativeAdapter treats an empty catalog as permissive — get() returns a
    // synthetic entry for any model, and resolveTarget accepts arbitrary ids.
    const target = adapter.resolveTarget("blackboxai/any-model", "openai-chat");
    expect(target.modelId).toBe("blackboxai/any-model");
    expect(target.providerId).toBe("blackboxai");
    expect(target.surface).toBe("openai-chat");
  });

  test("rejects model ids outside the catalog surface", () => {
    expect(() => adapter.resolveTarget("not-a-blackboxai-model", "native")).toThrow(ProviderAdapterError);
  });
});
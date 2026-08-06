import { describe, expect, test } from "bun:test";
import { ProviderAdapterError, makeNativeAdapter } from "../../src/providers/shared";
import { openrouterConfig } from "../../src/providers/openrouter";
import { groqConfig } from "../../src/providers/groq";
import { alibabaConfig } from "../../src/providers/alibaba";
import { fireworksConfig } from "../../src/providers/fireworks";
import { deepseekNativeConfig } from "../../src/providers/deepseek-native";
import { ollamaConfig } from "../../src/providers/ollama";
import { mistralConfig } from "../../src/providers/mistral";
import { siliconflowConfig } from "../../src/providers/siliconflow";
import { cerebrasConfig } from "../../src/providers/cerebras";
import { nvidiaConfig } from "../../src/providers/nvidia-native";
import { blackboxaiConfig } from "../../src/providers/blackboxai";
import { opencodegoConfig } from "../../src/providers/opencodego";
import { xiaomipgConfig } from "../../src/providers/xiaomipg";
import { xiaomitpConfig } from "../../src/providers/xiaomitp";
import type { NativeProviderConfig } from "../../src/providers/shared";

const allConfigs: NativeProviderConfig[] = [
  openrouterConfig,
  groqConfig,
  alibabaConfig,
  fireworksConfig,
  deepseekNativeConfig,
  ollamaConfig,
  mistralConfig,
  siliconflowConfig,
  cerebrasConfig,
  nvidiaConfig,
  blackboxaiConfig,
  opencodegoConfig,
  xiaomipgConfig,
  xiaomitpConfig,
];

const byId = new Map(allConfigs.map((config) => [config.id, config]));

describe("default native provider registry", () => {
  test("exposes unique provider ids", () => {
    const ids = allConfigs.map((config) => config.id);
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
  const adapter = makeNativeAdapter(byId.get("blackboxai")!);

  test("blackboxai catalog is permissive (empty storedModels -> any model resolves)", () => {
    const target = adapter.resolveTarget("blackboxai/any-model", "openai-chat");
    expect(target.modelId).toBe("blackboxai/any-model");
    expect(target.providerId).toBe("blackboxai");
    expect(target.surface).toBe("openai-chat");
  });

  test("rejects model ids outside the catalog surface", () => {
    expect(() => adapter.resolveTarget("not-a-blackboxai-model", "native")).toThrow(ProviderAdapterError);
  });
});

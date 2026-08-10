import { describe, expect, test } from "bun:test";
import { ProviderService } from "../src/console/services/composition";
import type {
  AccountRepository,
  CustomProviderRepository,
  CustomProviderView,
  ProviderConfigRepository,
} from "../src/console/views";
import type { CustomProviderRecord } from "../src/storage/main/records";
import { CustomProviderAdapter } from "../src/providers/custom";
import { ProviderRegistry } from "../src/providers/registry";

function customProviderView(overrides: Partial<CustomProviderView> = {}): CustomProviderView {
  return {
    id: "custom-provider-id",
    slug: "blackbox",
    name: "Blackbox",
    kind: "openai-compatible",
    baseUrl: "https://api.blackbox.ai/v1",
    credentialHint: "…test",
    timeoutSeconds: 30,
    autoFetchModels: true,
    customHeaders: {},
    models: [
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    ],
    enabled: true,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("custom provider BYOK routing", () => {
  test("persists the creation credential as an active provider account", async () => {
    const created: Array<{ providerId: string; name: string; credentialKind: string; credential: string }> = [];
    const custom = customProviderView();
    const customProviders = {
      list: async () => [],
      get: async () => custom,
      create: async () => custom,
      update: async () => custom,
      remove: async () => true,
      updateModels: async () => custom,
      credential: async () => ({ credential: "sk-blackbox-\ntest" }),
    } as unknown as CustomProviderRepository;
    const accounts = {
      create: async (input: { providerId: string; name: string; credentialKind: string; credential: string }) => {
        created.push(input);
        return { id: "account-1", credentialHint: "sk-b…" };
      },
    } as unknown as AccountRepository;
    const providerConfig = {} as ProviderConfigRepository;
    const service = new ProviderService(new ProviderRegistry(), providerConfig, customProviders, accounts);

    const result = await service.createCustom({
      name: custom.name,
      slug: custom.slug,
      kind: "openai-compatible",
      baseUrl: custom.baseUrl,
      credential: "sk-blackbox-test",
    });
    expect(result).toMatchObject({ id: custom.id, slug: custom.slug });

    expect(created).toEqual([{ providerId: "blackbox", name: "Blackbox", credentialKind: "api_key", credential: "sk-blackbox-test" }]);
  });

  test("routes provider-relative DeepSeek and GLM ids without rewriting them", () => {
    const record: CustomProviderRecord = {
      id: "custom-provider-id",
      slug: "blackbox",
      name: "Blackbox",
      type: "openai-compatible",
      baseUrl: "https://api.blackbox.ai/v1",
      credential: "unused-in-test",
      timeoutSeconds: 30,
      models: [
        { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        { id: "z-ai/glm-5.2", name: "GLM 5.2" },
      ],
      customHeaders: {},
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const source = {
      list: () => [record],
      getBySlug: (slug: string) => slug === record.slug ? record : null,
    };
    const adapter = new CustomProviderAdapter(record, source);

    expect(adapter.resolveTarget("deepseek/deepseek-v4-pro", "openai-chat")).toMatchObject({
      providerId: "blackbox",
      modelId: "deepseek/deepseek-v4-pro",
      upstreamModelId: "deepseek/deepseek-v4-pro",
    });
    expect(adapter.resolveTarget("z-ai/glm-5.2", "openai-chat").upstreamModelId).toBe("z-ai/glm-5.2");
  });
  test("rejects private custom provider targets before persistence", async () => {
    const customProviders = {
      list: async () => [],
      create: async () => customProviderView(),
    } as unknown as CustomProviderRepository;
    const service = new ProviderService(new ProviderRegistry(), {} as ProviderConfigRepository, customProviders, {} as AccountRepository);

    const result = await service.createCustom({
      name: "Private",
      slug: "private-target",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
    });

    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_request" });
  });
});

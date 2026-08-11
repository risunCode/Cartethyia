import { describe, expect, test } from "bun:test";
import type { ProxyRequest } from "../../src/application/contracts";
import { ProviderService } from "../../src/console/services/composition";
import type {
  AccountRepository,
  CustomProviderRepository,
  CustomProviderView,
  ProviderConfigRepository,
} from "../../src/console/views";
import type { CustomProviderRecord } from "../../src/storage/main/records";
import { CustomProviderAdapter } from "../../src/providers/custom";
import { ProviderRegistry } from "../../src/providers/registry";

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
  test("forwards Claude gateway headers and native tool options to Anthropic-compatible upstreams", async () => {
    const record: CustomProviderRecord = {
      id: "custom-provider-id",
      slug: "anthropic-gateway",
      name: "Anthropic Gateway",
      type: "anthropic-compatible",
      baseUrl: "https://93.184.216.34/v1",
      credential: "unused-in-test",
      timeoutSeconds: 30,
      models: [{ id: "claude-custom", name: "Claude Custom" }],
      customHeaders: { "anthropic-beta": "operator-beta", "x-routing": "edge" },
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const source = {
      list: () => [record],
      getBySlug: (slug: string) => slug === record.slug ? record : null,
    };
    const adapter = new CustomProviderAdapter(record, source);
    const request: ProxyRequest = {
      model: "claude-custom",
      messages: [{ role: "user", content: [{ type: "text", text: "search" }] }],
      tools: [{
        name: "web_search",
        description: null,
        inputSchema: {},
        nativeType: "web_search_20260318",
        nativeOptions: { max_uses: 2, allowed_domains: ["example.com"] },
      }],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: 100,
      images: [],
      sourceSurface: "anthropic-messages",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 10_000_000, connectTimeoutMs: 10_000, firstByteTimeoutMs: 30_000, idleTimeoutMs: 30_000, totalTimeoutMs: 120_000 },
    };
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await adapter.call({
        target: adapter.resolveTarget("claude-custom", "anthropic-messages"),
        request,
        credential: "sk-gateway",
        network: { proxyId: null, url: null, release: async () => {} },
        signal: request.signal,
        headers: new Headers({
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-20260318",
          "anthropic-workspace-id": "workspace-1",
        }),
      });
      expect(result.mode).toBe("non_stream");
      expect(captured?.url).toBe("https://93.184.216.34/v1/messages");
      const headers = new Headers(captured?.init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-gateway");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("anthropic-beta")).toBe("web-search-20260318");
      expect(headers.get("anthropic-workspace-id")).toBe("workspace-1");
      expect(headers.get("x-routing")).toBe("edge");
      const sent = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
      expect(sent.tools).toEqual([{
        type: "web_search_20260318",
        name: "web_search",
        max_uses: 2,
        allowed_domains: ["example.com"],
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

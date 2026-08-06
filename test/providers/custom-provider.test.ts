import { describe, expect, test } from "bun:test";
import type { NormalizedProviderRequest } from "../../src/domain/contracts";
import type { CustomProviderRecord } from "../../src/storage";
import { CustomProviderAdapter, syncCustomAdapters } from "../../src/providers/custom";
import { ProviderRegistry } from "../../src/providers/registry";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

function record(overrides: Partial<CustomProviderRecord> = {}): CustomProviderRecord {
  return {
    id: "custom-1",
    slug: "acme",
    name: "Acme",
    type: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    credential: "secret",
    timeoutSeconds: 30,
    models: [],
    customHeaders: { "x-tenant": "prod" },
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<NormalizedProviderRequest> = {}): NormalizedProviderRequest {
  return {
    model: "arbitrary-upstream-model",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    stream: false,
    responseFormat: "text",
    reasoning: "default",
    maxOutputTokens: null,
    images: [],
    sourceSurface: "openai-chat",
    signal: new AbortController().signal,
    limits,
    ...overrides,
  };
}

const emptyNetwork = { proxyId: null, url: null, release: async () => {} } as const;

describe("custom provider runtime contracts", () => {
  test("syncs dynamic adapters and preserves permissive model routing", () => {
    let rows = [record()];
    const source = { list: () => rows, getBySlug: (slug: string) => rows.find((row) => row.slug === slug) ?? null };
    const registry = new ProviderRegistry();

    syncCustomAdapters(registry, source);
    const adapter = registry.get("acme");
    expect(adapter).toBeInstanceOf(CustomProviderAdapter);
    expect(adapter?.models.get("provider-published-later")).not.toBeNull();
    expect(adapter?.resolveTarget("provider-published-later", "openai-chat")).toEqual({ providerId: "acme", modelId: "provider-published-later", upstreamModelId: "provider-published-later", surface: "openai-chat" });

    rows = [];
    syncCustomAdapters(registry, source);
    expect(registry.get("acme")).toBeNull();
  });

  test("rejects private custom endpoints before outbound dispatch", async () => {
    const source = { list: () => [record({ baseUrl: "http://127.0.0.1:9" })], getBySlug: () => record({ baseUrl: "http://127.0.0.1:9" }) };
    const adapter = new CustomProviderAdapter(source.list()[0]!, source);

    await expect(adapter.call({
      target: { providerId: "acme", modelId: "arbitrary-upstream-model", upstreamModelId: "arbitrary-upstream-model", surface: "openai-chat" },
      request: request(),
      credential: "secret",
      network: emptyNetwork,
      signal: new AbortController().signal,
    })).rejects.toThrow(/blocked|private|loopback/i);
  });
});

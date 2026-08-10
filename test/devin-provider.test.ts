import { describe, expect, test } from "bun:test";
import { DevinAdapter } from "../src/providers/devin";
import { createDefaultRegistry } from "../src/providers/registry";
import type { ProviderRequest } from "../src/application/contracts";

function requestFor(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "devin", modelId: "swe-1-6-slow", upstreamModelId: "swe-1-6-slow", surface: "openai-chat" },
    request: {
      model: "swe-1-6-slow",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 5_000, firstByteTimeoutMs: 10_000, idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    },
    credential: "",
    network: { proxyId: null, url: null, release: async () => {} },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("DevinAdapter", () => {
  test("exposes the verified Devin model and OpenAI chat surface", () => {
    const adapter = new DevinAdapter();
    expect(adapter.metadata).toMatchObject({ id: "devin", protocol: "devin", credentialKind: "api_key" });
    expect(adapter.models.get("swe-1-6-slow")?.displayName).toBe("SWE-1.6 Slow");
    expect(adapter.resolveTarget("swe-1-6-slow", "openai-chat")).toEqual({ providerId: "devin", modelId: "swe-1-6-slow", upstreamModelId: "swe-1-6-slow", surface: "openai-chat" });
  });


  test("is registered in the default provider registry", async () => {
    const registry = await createDefaultRegistry();
    expect(registry.get("devin")?.metadata.displayName).toBe("Devin");
  });

  test("rejects requests without a bearer JWT or API key before network I/O", async () => {
    const adapter = new DevinAdapter();
    await expect(adapter.call(requestFor())).rejects.toMatchObject({ kind: "authentication_failed", statusCode: 401, routeScope: "account" });
  });
});

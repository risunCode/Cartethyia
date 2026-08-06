import { describe, expect, test } from "bun:test";
import type { NetworkSelection, NormalizedProviderRequest, ProviderRequest } from "../../src/domain/contracts";
import { AgentRouterAdapter } from "../../src/providers/agentrouter";
import { ClinePassAdapter } from "../../src/providers/cline";
import { CodeBuddyAdapter, CodeBuddyChinaAdapter } from "../../src/providers/codebuddy";
import { AnthropicOAuthAdapter } from "../../src/providers/claude-code";
import { KimchiAdapter } from "../../src/providers/kimchi";
import { OpenCodeZenAdapter } from "../../src/providers/opencode";
import { ProviderAdapterError, makeNativeAdapter } from "../../src/providers/shared";
import { xiaomipgConfig } from "../../src/providers/xiaomipg";
import { xiaomitpConfig } from "../../src/providers/xiaomitp";
import { ProviderRegistry, createDefaultRegistry } from "../../src/providers/registry";

const limits = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

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

const emptyNetwork: NetworkSelection = { proxyId: null, url: null, release: async () => {} };

function providerRequest(adapter: { metadata: { id: string } }, modelId: string, surface: "openai-chat" | "anthropic-messages", credential = "secret"): ProviderRequest {
  return {
    target: { providerId: adapter.metadata.id, modelId, surface },
    request: request({ model: modelId }),
    credential,
    network: emptyNetwork,
    signal: new AbortController().signal,
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetchFor(capture: CapturedCall, json: Record<string, unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init ?? {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("KimchiAdapter (Task 9)", () => {
  const adapter = new KimchiAdapter();

  test("metadata and catalog match legacy identity", () => {
    expect(adapter.metadata).toMatchObject({ id: "kimchi", displayName: "Kimchi", protocol: "openai", credentialKind: "oauth", credentialKinds: ["oauth", "api_key"] });
    expect([...adapter.models.list.map((m) => m.id)].sort()).toEqual(["deepseek-v4-flash", "kimi-k2.7", "minimax-m3", "nemotron-3-ultra-fp4"]);
  });

  test("resolves catalog models and rejects unknown models", () => {
    expect(adapter.resolveTarget("kimi-k2.7", "openai-chat")).toEqual({ providerId: "kimchi", modelId: "kimi-k2.7", surface: "openai-chat" });
    expect(() => adapter.resolveTarget("not-a-kimchi-model", "openai-chat")).toThrow(ProviderAdapterError);
  });

  test("guards empty credential and wrong surface before any fetch", async () => {
    await expect(adapter.call(providerRequest(adapter, "kimi-k2.7", "openai-chat", ""))).rejects.toThrow(/credential/i);
    await expect(
      adapter.call({ ...providerRequest(adapter, "kimi-k2.7", "openai-chat"), target: { providerId: "kimchi", modelId: "kimi-k2.7", surface: "images" as const } }),
    ).rejects.toThrow(ProviderAdapterError);
  });

  test("posts the OpenAI chat wire shape with bearer auth and model override", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    try {
      const output = await adapter.call(providerRequest(adapter, "kimi-k2.7", "openai-chat"));
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://llm.kimchi.dev/openai/v1/chat/completions");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer secret");
      expect(headers["user-agent"]).toBe("kimchi/0.1.75");
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("kimi-k2.7");
      expect(output.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
    } finally {
      restore();
    }
  });
});


describe("AgentRouterAdapter (Task 9)", () => {
  const adapter = new AgentRouterAdapter();

  test("metadata and catalog match legacy identity", () => {
    expect(adapter.metadata).toMatchObject({ id: "agentrouter", displayName: "AgentRouter", protocol: "anthropic", credentialKind: "api_key" });
    expect(adapter.models.get("claude-opus-4-8")).not.toBeNull();
    expect(adapter.capabilities.surfaces).toContain("anthropic-messages");
  });

  test("resolves catalog models and rejects unknown models", () => {
    expect(adapter.resolveTarget("claude-opus-4-8", "anthropic-messages")).toEqual({ providerId: "agentrouter", modelId: "claude-opus-4-8", surface: "anthropic-messages" });
    expect(() => adapter.resolveTarget("claude-nope", "anthropic-messages")).toThrow(ProviderAdapterError);
  });

  test("guards empty credential and wrong surface before any fetch", async () => {
    await expect(adapter.call(providerRequest(adapter, "claude-opus-4-8", "anthropic-messages", ""))).rejects.toThrow(/API key/i);
    await expect(
      adapter.call({ ...providerRequest(adapter, "claude-opus-4-8", "anthropic-messages"), target: { providerId: "agentrouter", modelId: "claude-opus-4-8", surface: "openai-chat" } }),
    ).rejects.toThrow(ProviderAdapterError);
  });

  test("posts native Anthropic Messages wire shape with identity headers and model override", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    try {
      const output = await adapter.call(providerRequest(adapter, "claude-opus-4-8", "anthropic-messages"));
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://agentrouter.org/v1/messages?beta=true");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("secret");
      expect(headers["user-agent"]).toBe("claude-cli/2.1.195 (external, sdk-cli)");
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("claude-opus-4-8");
      // Field order must present the Claude Code identity first.
      expect(Object.keys(body).join(",")).toMatch(/^model,messages/);
    } finally {
      restore();
    }
  });
});


describe("ClinePassAdapter", () => {
  const adapter = new ClinePassAdapter();

  test("exposes API key and OAuth credentials", () => {
    expect(adapter.metadata).toMatchObject({ id: "clinepass", displayName: "ClinePass", credentialKind: "oauth", credentialKinds: ["oauth", "api_key"] });
    expect(adapter.models.get("cline-pass/glm-5.2")).not.toBeNull();
  });

  test("accepts a plain API key without rewriting it as a WorkOS token", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "x", object: "chat.completion", choices: [] });
    try {
      await adapter.call(providerRequest(adapter, "cline-pass/glm-5.2", "openai-chat", "cline-key"));
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer cline-key");
    } finally {
      restore();
    }
  });

  test("encodes normalized image blocks as OpenAI image_url content", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "x", object: "chat.completion", choices: [] });
    try {
      const input = providerRequest(adapter, "cline-pass/glm-5.2", "openai-chat", "cline-key");
      await adapter.call({
        ...input,
        request: request({
          model: "cline-pass/glm-5.2",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Read this image." },
              { type: "image", image: { kind: "data", value: "YWJj", mediaType: "image/png" } },
            ],
          }],
        }),
      });
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      const messages = body.messages as Array<Record<string, unknown>>;
      const user = messages.find((message) => message.role === "user");
      expect(user?.content).toEqual([
        { type: "text", text: "Read this image." },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ]);
    } finally {
      restore();
    }
  });
});

describe("Claude Code OAuth adapter identity", () => {
  test("injects bounded instruction/tool identity without inventing a User-Agent", async () => {
    const adapter = new AnthropicOAuthAdapter();
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: "end_turn" });
    try {
      const input = providerRequest(adapter, "claude-opus-5", "anthropic-messages");
      const output = await adapter.call({ ...input, headers: new Headers({ "user-agent": "curl/8" }), request: request({ model: "claude-opus-5", maxOutputTokens: 128_000, tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }] }) });
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.max_tokens).toBe(64_000);
      expect((body.system as Array<Record<string, unknown>>)[0]?.text).toContain("x-anthropic-billing-header:");
      expect((body.system as Array<Record<string, unknown>>)[1]?.text).toContain("Claude agent");
      expect((body.system as Array<Record<string, unknown>>)[0]?.text).not.toContain("cch=00000");
      expect((body.tools as Array<Record<string, unknown>>)[0]?.name).toBe("_bash");
      expect((capture.init.headers as Record<string, string>)["user-agent"]).toBe(`claude-cli/${"2.1.165"} (external, local-agent, agent-sdk/${"0.3.165"})`);
    } finally {
      restore();
    }
  });
});

describe("CodeBuddy adapters", () => {
  test("expose separate global and CN catalogs", () => {
    const global = new CodeBuddyAdapter();
    const china = new CodeBuddyChinaAdapter();
    expect(global.metadata).toMatchObject({ id: "codebuddy", displayName: "CodeBuddy", credentialKind: "api_key" });
    expect(china.metadata).toMatchObject({ id: "codebuddy-cn", displayName: "CodeBuddy CN", credentialKind: "api_key" });
    expect(global.models.get("opus-4.8")).not.toBeNull();
    expect(china.models.get("glm-5.2")).not.toBeNull();
  });

  test("uses the region-specific OpenAI-compatible bases and maps model IDs", async () => {
    for (const [adapter, expectedUrl, modelId, expectedModel] of [
      [new CodeBuddyAdapter(), "https://www.codebuddy.ai/v2/chat/completions", "opus-4.8", "claude-opus-4.8"],
      [new CodeBuddyChinaAdapter(), "https://www.codebuddy.cn/v2/chat/completions", "glm-5.2", "glm-5.2"],
    ] as const) {
      const capture: CapturedCall = { url: "", init: {} };
      const restore = stubFetchFor(capture, { id: "x", object: "chat.completion", choices: [] });
      try {
        await adapter.call(providerRequest(adapter, modelId, "openai-chat"));
        expect(capture.url).toBe(expectedUrl);
        const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
        expect(body.model).toBe(expectedModel);
        expect((capture.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
      } finally {
        restore();
      }
    }
  });
});

describe("OpenCodeZenAdapter (Task 9)", () => {
  const adapter = new OpenCodeZenAdapter();

  test("metadata and catalog match legacy identity including ling-3.0-flash-free", () => {
    expect(adapter.metadata).toMatchObject({ id: "opencodezen", displayName: "OpenCode Zen", credentialKind: "api_key" });
    expect(adapter.models.get("ling-3.0-flash-free")).not.toBeNull();
    expect(adapter.models.get("big-pickle")).not.toBeNull();
  });

  test("resolves catalog models and rejects unknown models", () => {
    expect(adapter.resolveTarget("big-pickle", "openai-chat")).toEqual({ providerId: "opencodezen", modelId: "big-pickle", surface: "openai-chat" });
    expect(() => adapter.resolveTarget("nope", "openai-chat")).toThrow(ProviderAdapterError);
  });

  test("guards empty credential before any fetch", async () => {
    await expect(adapter.call(providerRequest(adapter, "big-pickle", "openai-chat", ""))).rejects.toThrow(/API key/i);
  });

  test("posts the OpenAI chat wire shape with billed bearer auth and model override", async () => {
    const capture: CapturedCall = { url: "", init: {} };
    const restore = stubFetchFor(capture, { id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    try {
      const output = await adapter.call(providerRequest(adapter, "big-pickle", "openai-chat"));
      expect(output.mode).toBe("non_stream");
      expect(capture.url).toBe("https://opencode.ai/zen/v1/chat/completions");
      const headers = capture.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer secret");
      expect(headers["x-opencode-client"]).toBeUndefined();
      const body = JSON.parse(capture.init.body as string) as Record<string, unknown>;
      expect(body.model).toBe("big-pickle");
    } finally {
      restore();
    }
  });
});

describe("Xiaomi PAYG/TokenPlan (Task 9)", () => {
  test("PAYG and Token Plan are registered as native OpenAI-compatible providers", () => {
    expect(xiaomipgConfig.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(xiaomitpConfig.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
  });

  test("both tiers route the curated mimo model pair", () => {
    for (const config of [xiaomipgConfig, xiaomitpConfig]) {
      const adapter = makeNativeAdapter(config);
      for (const modelId of ["mimo-v2.5-pro", "mimo-v2.5"]) {
        expect(adapter.models.get(modelId)).not.toBeNull();
        expect(adapter.resolveTarget(modelId, "openai-chat").modelId).toBe(modelId);
      }
    }
  });
});

describe("default registry registration (Task 9)", () => {
  test("registers the restored dedicated non-OAuth adapters and Xiaomi tiers", async () => {
    const registry = await createDefaultRegistry();
    const ids = registry.list().map((item) => item.metadata.id);
    for (const expected of ["opencodezen", "kimchi", "agentrouter", "xiaomipg", "xiaomitp"]) {
      expect(ids).toContain(expected);
    }
    // The restored dedicated adapters resolve their own catalog models through the registry.
    // (big-pickle is shared with OpenCode Free, which is registered first, so we use the
    // zen-unique ling-3.0-flash-free to assert zen routing.)
    expect(registry.resolveTarget("ling-3.0-flash-free", "openai-chat").providerId).toBe("opencodezen");
    expect(registry.resolveTarget("kimi-k2.7", "openai-chat").providerId).toBe("kimchi");
    expect(registry.resolveTarget("claude-opus-4-8", "anthropic-messages").providerId).toBe("agentrouter");
  });

  test("no restored adapter registers an excluded provider id", async () => {
    const registry = await createDefaultRegistry();
    expect(registry.list().some((item) => ProviderRegistry && item.metadata.id === "devin")).toBe(false);
  });
});


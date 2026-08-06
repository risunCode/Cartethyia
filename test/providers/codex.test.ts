import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "../../src/providers/codex";
import { ProviderAdapterError } from "../../src/providers/shared";
import type { ProviderRequest } from "../../src/domain/contracts";

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=/g, "");
  const body = btoa(JSON.stringify(payload)).replace(/=/g, "");
  return `${header}.${body}.sig`;
}

function makeRequest(credential: string, overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    target: { providerId: "codex", modelId: "gpt-5.5", surface: "openai-chat" },
    request: {
      model: "gpt-5.5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      stream: true,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1_000_000, connectTimeoutMs: 1_000, firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 },
    },
    credential,
    network: { select: async () => ({ proxyId: null, selection: { proxyId: null, url: null, release: async () => {} } }) } as never,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("CodexAdapter — identity & catalog", () => {
  test("declares the openai protocol and oauth credential kind", () => {
    const adapter = new CodexAdapter();
    expect(adapter.metadata).toMatchObject({ id: "codex", displayName: "Codex ChatGPT", protocol: "openai", credentialKind: "oauth" });
  });

  test("supports the openai-chat and images surfaces with streaming", () => {
    const adapter = new CodexAdapter();
    expect(adapter.capabilities.surfaces).toContain("openai-chat");
    expect(adapter.capabilities.surfaces).toContain("images");
    expect(adapter.capabilities.streaming).toBe(true);
  });

  test("exposes the Codex model catalog", () => {
    const adapter = new CodexAdapter();
    expect(adapter.models.get("gpt-5.6-sol")?.displayName).toBe("GPT 5.6 Sol");
    expect(adapter.models.get("gpt-5.5")?.capabilities.reasoning).toBe(true);
    expect(adapter.models.get("nope")).toBe(null);
  });
});

describe("CodexAdapter — resolveTarget", () => {
  test("resolves a known model on a supported surface", () => {
    const adapter = new CodexAdapter();
    expect(adapter.resolveTarget("gpt-5.4-mini", "openai-chat")).toEqual({ providerId: "codex", modelId: "gpt-5.4-mini", surface: "openai-chat" });
  });

  test("rejects an unsupported surface", () => {
    const adapter = new CodexAdapter();
    try {
      adapter.resolveTarget("gpt-5.5", "anthropic-messages");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("capability_unsupported");
    }
  });

  test("rejects an unknown model", () => {
    const adapter = new CodexAdapter();
    try {
      adapter.resolveTarget("no-such-codex", "openai-chat");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("model_not_found");
    }
  });
});

describe("CodexAdapter — call guard paths (no network)", () => {
  test("countTokens returns unknown", async () => {
    const adapter = new CodexAdapter();
    await expect(adapter.countTokens({ request: makeRequest("x").request, signal: new AbortController().signal })).resolves.toEqual({ tokens: null, source: "unknown" });
  });
});

describe("CodexAdapter — call credential validation", () => {
  test("call rejects an unsupported surface before touching the network", async () => {
    const adapter = new CodexAdapter();
    const input = makeRequest("tok", { target: { providerId: "codex", modelId: "gpt-5.5", surface: "anthropic-messages" } });
    await expect(adapter.call(input)).rejects.toBeInstanceOf(ProviderAdapterError);
  });

  test("call rejects an empty credential with authentication_failed (account scope)", async () => {
    const adapter = new CodexAdapter();
    const input = makeRequest("", { target: { providerId: "codex", modelId: "gpt-5.5", surface: "openai-chat" } });
    try {
      await adapter.call(input);
      throw new Error("should have thrown");
    } catch (error) {
      const typed = error as ProviderAdapterError;
      expect(typed.kind).toBe("authentication_failed");
      expect(typed.routeScope).toBe("account");
    }
  });

  test("call rejects a non-JWT credential (no account identity)", async () => {
    const adapter = new CodexAdapter();
    const input = makeRequest("not-a-jwt", { target: { providerId: "codex", modelId: "gpt-5.5", surface: "openai-chat" } });
    try {
      await adapter.call(input);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("authentication_failed");
    }
  });

  test("call rejects a JWT without a chatgpt_account_id", async () => {
    const adapter = new CodexAdapter();
    const jwt = makeJwt({ sub: "u" });
    const input = makeRequest(jwt, { target: { providerId: "codex", modelId: "gpt-5.5", surface: "openai-chat" } });
    try {
      await adapter.call(input);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ProviderAdapterError).kind).toBe("authentication_failed");
    }
  });
});

describe("CodexAdapter — mapError", () => {
  test("maps a ProviderAdapterError faithfully", () => {
    const adapter = new CodexAdapter();
    const mapped = adapter.mapError(new ProviderAdapterError({ kind: "credential_unavailable", message: "no token", routeScope: "account" }));
    expect(mapped.kind).toBe("credential_unavailable");
  });
});

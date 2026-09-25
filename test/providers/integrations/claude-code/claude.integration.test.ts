import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_SYSTEM_INSTRUCTION,
  computeClaudeCch,
  createClaudeBillingText,
  patchClaudeCchBody,
} from "../../../../src/providers/integrations/claude-code/claude-cch";
import { CLAUDE_CODE_SDK_VERSION, CLAUDE_CODE_USER_AGENT, CLAUDE_CODE_VERSION } from "../../../../src/providers/integrations/claude-code/claude-fingerprint";
import { CLAUDE_TOOL_PREFIX, prefixClaudeToolName, unprefixClaudeToolName } from "../../../../src/protocol/primitives";
import { OAUTH_MESSAGES_MAX_OUTPUT_TOKENS, ANTHROPIC_DEFAULT_MAX_TOKENS, canonicalToClaudeMessagesPayload } from "../../../../src/protocol/request/messages";
import { buildClaudeHeaders, mapStainlessArch, mapStainlessOs } from "../../../../src/providers/integrations/claude-code/claude-credentials";
import { filterClaudeCustomHeaders } from "../../../../src/providers/integrations/claude-messages";
import { CURATED_CLAUDE_MODELS, ClaudeOAuthClient, discoverClaudeModels } from "../../../../src/providers/integrations/claude-code/claude-oauth";
import { GatewayError } from "../../../../src/transport/gateway-error";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../../src/providers/provider-registry";
import { CLAUDE_MODELS, ClaudeAdapter } from "../../../../src/providers/integrations/claude-code/claude";
import { isClaudeMetadataUserId } from "../../../../src/providers/integrations/claude-code/claude";
import { claudeResponseToEvents } from "../../../../src/protocol/response/messages";
import { ANTHROPIC_MODELS, AnthropicApiKeyAdapter } from "../../../../src/providers/integrations/anthropic";
import { log } from "../../../../src/observability/logger";
import { _resetClaudeVersionCache, VERSION_SOURCES } from "../../../../src/providers/operations/client-versions";

describe("Claude Integration", () => {
  describe("claude-cch.test.ts", () => {
describe("Claude CCH", () => {
  test("matches known reference vectors", () => {
    const encoder = new TextEncoder();
    expect(computeClaudeCch(encoder.encode("cch=00000"))).toBe("a47f7");
    expect(computeClaudeCch(encoder.encode('{"messages":[],"cch=00000","x":1}'))).toBe("3073d");
    expect(
      computeClaudeCch(
        encoder.encode(
          "x-anthropic-billing-header: cc_version=2.1.158; cc_entrypoint=cli; cch=00000;",
        ),
      ),
    ).toBe("f2b0b");
  });

  test("patches an anchored billing placeholder", () => {
    const body =
      '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1; cch=00000;"}],"messages":[]}';
    const bytes = patchClaudeCchBody(body);
    expect(bytes).toBeDefined();
    const output = new TextDecoder().decode(bytes);
    expect(output).not.toContain("cch=00000");
    expect(output).toMatch(/cch=[0-9a-f]{5}/);
  });

  test("returns undefined when no billing block exists (fail-closed patch)", () => {
    expect(patchClaudeCchBody('{"system":[],"messages":[]}')).toBeUndefined();
  });

  test("billing text carries the captured version suffix shape", () => {
    const text = createClaudeBillingText("hello world, this is a test prompt", "2.1.257");
    expect(text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.257\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/,
    );
    // Missing user text falls back to "0" chars, still well-formed.
    expect(createClaudeBillingText("", "2.1.257")).toMatch(/cc_version=2\.1\.257\.[0-9a-f]{3}/);
  });

  test("identity instruction matches the harness string", () => {
    expect(CLAUDE_CODE_SYSTEM_INSTRUCTION).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  test("isClaudeMetadataUserId accepts cloaked and JSON ids only", () => {
    expect(isClaudeMetadataUserId(`user_${"ab".repeat(32)}_account_123e4567-e89b-12d3-a456-426614174000_session_123e4567-e89b-12d3-a456-426614174000`)).toBe(true);
    expect(isClaudeMetadataUserId(JSON.stringify({ session_id: "sess-1" }))).toBe(true);
    expect(isClaudeMetadataUserId("sess-real-123")).toBe(false);
    expect(isClaudeMetadataUserId(JSON.stringify({ device_id: "d1" }))).toBe(false);
    expect(isClaudeMetadataUserId("")).toBe(false);
  });
});
  });

  describe("claude-fingerprint.test.ts", () => {
describe("claude fingerprint constants", () => {
  test("composes the CLI user-agent from the pinned version", () => {
    expect(CLAUDE_CODE_USER_AGENT).toBe(
      `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    );
  });

  test("pins the SDK version and output-token ceiling", () => {
    expect(CLAUDE_CODE_SDK_VERSION).toBe(VERSION_SOURCES.claudeSdk.fallback);
    expect(OAUTH_MESSAGES_MAX_OUTPUT_TOKENS).toBe(64000);
  });

  test("CLAUDE_MODELS and ANTHROPIC_MODELS expose the current anthropic SKU table", () => {
    for (const id of ["claude-mythos-5", "claude-mythos-5-1", "claude-opus-5-5"]) {
      expect(CLAUDE_MODELS.some((model) => model.modelId === id)).toBe(true);
      expect(ANTHROPIC_MODELS.some((model) => model.modelId === id)).toBe(true);
    }
    const claudeById = new Map(CLAUDE_MODELS.map((model) => [model.modelId, model] as const));
    expect(claudeById.get("claude-sonnet-4-6")).toMatchObject({ outputLimit: 128_000 });
    expect(claudeById.get("claude-opus-4-5")).toMatchObject({
      contextLimit: 200_000,
      outputLimit: 64_000,
    });
    expect(claudeById.get("claude-sonnet-4-5")).toMatchObject({
      contextLimit: 1_000_000,
      outputLimit: 64_000,
    });
    const anthropicOpus45 = ANTHROPIC_MODELS.find((model) => model.modelId === "claude-opus-4-5");
    expect(anthropicOpus45).toMatchObject({ contextLimit: 200_000, outputLimit: 64_000 });
    const anthropicHaiku45 = ANTHROPIC_MODELS.find((model) => model.modelId === "claude-haiku-4-5");
    expect(anthropicHaiku45).toMatchObject({ contextLimit: 200_000, outputLimit: 64_000 });
  });

  test("OAuth tool-name prefixing round-trips through the shared constant", () => {
    expect(prefixClaudeToolName("my_tool", true)).toBe(
      `${CLAUDE_TOOL_PREFIX}my_tool`,
    );
    expect(unprefixClaudeToolName(`${CLAUDE_TOOL_PREFIX}my_tool`, true)).toBe(
      "my_tool",
    );
    expect(prefixClaudeToolName("web_search", true)).toBe("web_search");
    expect(prefixClaudeToolName("my_tool", false)).toBe("my_tool");
  });
});
  });

  describe("claude-oauth.test.ts", () => {
const originalOrigin = process.env.CARTETHYIA_PUBLIC_ORIGIN;

function restoreOrigin(): void {
  if (originalOrigin === undefined) delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
  else process.env.CARTETHYIA_PUBLIC_ORIGIN = originalOrigin;
}

describe("oauth.test.ts", () => {
  describe("Claude OAuth", () => {
    test("builds the Claude authorize URL", () => {
      process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://example.test";
      try {
        const url = new URL(
          new ClaudeOAuthClient().buildAuthorizeUrl({ state: "state", codeChallenge: "challenge", redirectUri: "http://127.0.0.1:59653/callback" }),
        );
        expect(url.origin).toBe("https://claude.ai");
        expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
        expect(url.searchParams.get("scope")).toContain("user:inference");
        expect(url.searchParams.get("redirect_uri")).toBe(
          "http://127.0.0.1:59653/callback",
        );
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      } finally {
        restoreOrigin();
      }
    });

    test("exchanges a code and resolves inline identity", async () => {
      const calls: RequestInit[] = [];
      const client = new ClaudeOAuthClient(async (_url, init) => {
        calls.push(init ?? {});
        return new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            account: { email_address: "user@example.test" },
          }),
          { status: 200 },
        );
      });
      process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://example.test";
      try {
        const result = await client.exchangeCode("code", "verifier");
        expect(result.access).toBe("access");
        expect(result.accountLabel).toBe("user@example.test");
        const body = JSON.parse(String(calls[0]?.body)) as Record<string, string>;
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code_verifier).toBe("verifier");
        expect(body.redirect_uri).toContain("/console/api/providers/claude/oauth/callback");
      } finally {
        restoreOrigin();
      }
    });

    test("refresh uses the dedicated OAuth provider headers", async () => {
      _resetClaudeVersionCache(VERSION_SOURCES.claudeSdk.fallback);
      let request: RequestInit | undefined;
      const client = new ClaudeOAuthClient(async (_url, init) => {
        request = init;
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 60,
          }),
          { status: 200 },
        );
      });
      const result = await client.refresh("old-refresh");
      expect(result.access).toBe("new-access");
      const headers = request?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(`anthropic-sdk-typescript/${VERSION_SOURCES.claudeSdk.fallback} userOAuthProvider`);
      expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["x-app"]).toBeUndefined();
    });

    test("allows refresh responses without a replacement refresh token", async () => {
      const client = new ClaudeOAuthClient(async () =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 60 })),
      );
      const result = await client.refresh("old-refresh");
      expect(result.access).toBe("new-access");
      expect(result.refresh).toBeUndefined();
    });
  });
});

describe("discovery.test.ts", () => {
  describe("discoverClaudeModels", () => {
    test("returns live model ids when the endpoint is authorized", async () => {
      const result = await discoverClaudeModels(
        "token",
        async () =>
          new Response(JSON.stringify({ data: [{ id: "claude-x" }, { id: "claude-y" }] }), {
            status: 200,
          }),
      );
      expect(result).toEqual({ modelIds: ["claude-x", "claude-y"], source: "live" });
    });

    test("falls back to curated models on a 401", async () => {
      const result = await discoverClaudeModels(
        "bad-token",
        async () => new Response("", { status: 401 }),
      );
      expect(result.source).toBe("curated");
      expect(result.modelIds).toEqual(CURATED_CLAUDE_MODELS);
    });

    test("falls back to curated models on a network error", async () => {
      const result = await discoverClaudeModels("token", async () => {
        throw new Error("network down");
      });
      expect(result.source).toBe("curated");
    });

    test("falls back to curated models when the response has no usable ids", async () => {
      const result = await discoverClaudeModels(
        "token",
        async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
      expect(result.source).toBe("curated");
    });

    test("sends the required Anthropic headers", async () => {
      let capturedHeaders: Record<string, string> = {};
      await discoverClaudeModels("my-token", async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      expect(capturedHeaders["authorization"]).toBe("Bearer my-token");
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    });
  });
});

  describe("Claude header parity (Phase 2)", () => {
    const encode = (v: string) => new TextEncoder().encode(v);

    test("adds anthropic-dangerous-direct-browser-access on every branch", () => {
      const headers = buildClaudeHeaders(encode("tok"), "acc123", {
        credential_kind: "oauth",
      });
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
      const apiHeaders = buildClaudeHeaders(encode("tok"), "acc123", {
        credential_kind: "api_key",
      });
      expect(apiHeaders["anthropic-dangerous-direct-browser-access"]).toBe(
        "true",
      );
    });

    test("builds expanded OAuth agent beta list with defaults and preserves extras", () => {
      const headers = buildClaudeHeaders(encode("tok"), "acc123", {
        credential_kind: "oauth",
        anthropic_beta: "extra-beta-2025-01-01",
        capabilities: { "anthropic-beta:extra-beta-2025-01-01": true },
        has_thinking: true,
        has_tools: true,
      });
      const beta = headers["anthropic-beta"] ?? "";
      const parts = beta.split(",").map((s) => s.trim());
      // Agent-profile defaults (tools or thinking present), captured shape
      expect(parts).toContain("oauth-2025-04-20");
      expect(parts).toContain("interleaved-thinking-2025-05-14");
      expect(parts).toContain("thinking-token-count-2026-05-13");
      expect(parts).toContain("context-management-2025-06-27");
      expect(parts).toContain("prompt-caching-scope-2026-01-05");
      expect(parts).toContain("claude-code-20250219");
      expect(parts).toContain("mid-conversation-system-2026-04-07");
      expect(parts).not.toContain("redact-thinking-2026-02-12");
      expect(parts).not.toContain("advanced-tool-use-2025-11-20");
      expect(parts).not.toContain("extended-cache-ttl-2025-04-11");
      expect(parts).not.toContain("structured-outputs-2025-12-15");
      // Conditional effort only when thinking
      expect(parts).toContain("effort-2025-11-24");
      expect(parts).toContain("fallback-credit-2026-06-01");
      expect(parts).toContain("extra-beta-2025-01-01");
    });

    test("builds the bare utility beta list when neither tools nor thinking are present", () => {
      const headers = buildClaudeHeaders(encode("tok"), "acc123", {
        credential_kind: "oauth",
        has_thinking: false,
        has_tools: false,
      });
      const beta = headers["anthropic-beta"] ?? "";
      const parts = beta.split(",").map((s) => s.trim());
      expect(parts).toContain("oauth-2025-04-20");
      expect(parts).toContain("interleaved-thinking-2025-05-14");
      expect(parts).toContain("thinking-token-count-2026-05-13");
      expect(parts).toContain("context-management-2025-06-27");
      expect(parts).toContain("prompt-caching-scope-2026-01-05");
      expect(parts).toContain("structured-outputs-2025-12-15");
      // Agent-only betas are absent from the utility profile
      expect(parts).not.toContain("claude-code-20250219");
      expect(parts).not.toContain("mid-conversation-system-2026-04-07");
      expect(parts).not.toContain("effort-2025-11-24");
      expect(parts).not.toContain("fallback-credit-2026-06-01");
    });

    test("omits effort beta when has_thinking is false", () => {
      const headers = buildClaudeHeaders(encode("tok"), "acc123", {
        credential_kind: "oauth",
        has_thinking: false,
      });
      const beta = headers["anthropic-beta"] ?? "";
      expect(beta).not.toContain("effort-2025-11-24");
      expect(beta).toContain("oauth-2025-04-20");
    });

    test("non-OAuth headers do not include OAuth defaults", () => {
      const headers = buildClaudeHeaders(encode("tok"), "acc123", {
        credential_kind: "api_key",
      });
      expect(headers["anthropic-beta"]).toBeUndefined();
    });

    test("removes invented x-account-id/x-device-id/x-session-id and omits session without identity", () => {
      const headers = buildClaudeHeaders(encode("tok"), "my-account", {
        credential_kind: "oauth",
      });
      expect(headers["x-account-id"]).toBeUndefined();
      expect(headers["x-device-id"]).toBeUndefined();
      expect(headers["x-session-id"]).toBeUndefined();
      // No synthetic session: absent without a real identity.
      expect(headers["X-Claude-Code-Session-Id"]).toBeUndefined();
    });

    test("derives x-claude-code-session-id from session_id option and inbound header", () => {
      const withOption = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "oauth",
        session_id: "real-session-999",
      });
      expect(withOption["X-Claude-Code-Session-Id"]).toBe("real-session-999");

      const withInbound = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "oauth",
        request_headers: { "x-claude-code-session-id": "inbound-abc" },
      });
      expect(withInbound["X-Claude-Code-Session-Id"]).toBe("inbound-abc");

      const fallback = buildClaudeHeaders(encode("tok"), "fallback-acc", {
        credential_kind: "oauth",
      });
      // No synthetic session: the header is absent without a real identity.
      expect(fallback["X-Claude-Code-Session-Id"]).toBeUndefined();
      const fallbackAgain = buildClaudeHeaders(encode("tok"), "fallback-acc", {
        credential_kind: "oauth",
      });
      expect(fallbackAgain["X-Claude-Code-Session-Id"]).toBeUndefined();
    });

    test("omits un-attested client-identity headers", () => {
      const headers = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "oauth",
      });
      // Neither header is emitted: the upstream client sends neither on
      // this protocol.
      expect(headers["anthropic-client-version"]).toBeUndefined();
      expect(headers["x-client-request-id"]).toBeUndefined();
    });

    test("allows x-client-request-id through filterClaudeCustomHeaders", () => {
      const filtered = filterClaudeCustomHeaders({
        "x-client-request-id": "req-123",
      });
      expect(filtered["x-client-request-id"]).toBe("req-123");
      // still protected: x-claude-code-session-id should be rejected
      expect(() =>
        filterClaudeCustomHeaders({ "x-claude-code-session-id": "bad" }),
      ).toThrow();
    });

    test("negotiates Accept/Connection/Accept-Encoding headers", () => {
      const oauth = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "oauth",
        stream: true,
      });
      // OAuth always negotiates plain JSON, even when streaming.
      expect(oauth.Accept).toBe("application/json");
      expect(oauth.Connection).toBe("keep-alive");
      expect(oauth["Accept-Encoding"]).toBe("gzip, deflate, br, zstd");

      const nonOauthStream = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "api_key",
        stream: true,
      });
      expect(nonOauthStream.Accept).toBe("text/event-stream");

      const nonOauthNoStream = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "api_key",
        stream: false,
      });
      expect(nonOauthNoStream.Accept).toBe("application/json");
    });

    test("maps x-stainless-arch/os dynamically via helpers", () => {
      expect(mapStainlessArch("x64")).toBe("x64");
      expect(mapStainlessArch("arm64")).toBe("arm64");
      expect(mapStainlessArch("ia32")).toBe("x86");
      expect(mapStainlessArch("unknownArch")).toBe("other::unknownarch");
      expect(mapStainlessOs("darwin")).toBe("MacOS");
      expect(mapStainlessOs("win32")).toBe("Windows");
      expect(mapStainlessOs("linux")).toBe("Linux");
      expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
      expect(mapStainlessOs("sunos")).toBe("Other::sunos");
      const headers = buildClaudeHeaders(encode("tok"), "acc", {
        credential_kind: "oauth",
      });
      expect(headers["X-Stainless-Arch"]).toBe(mapStainlessArch(process.arch));
      expect(headers["X-Stainless-OS"]).toBe(mapStainlessOs(process.platform));
    });
  });

  describe("Claude credential envelope normalization", () => {
    const encode = (v: string) => new TextEncoder().encode(v);

    test("strips a stored Bearer envelope so no Bearer Bearer header is emitted", () => {
      const headers = buildClaudeHeaders(encode("Bearer abc"), "acct-1", {});
      expect(headers.Authorization).toBe("Bearer abc");
      expect(headers.Authorization).not.toContain("Bearer Bearer");
    });

    test("an envelope-only secret emits no Authorization header", () => {
      const headers = buildClaudeHeaders(encode("Bearer "), "acct-1", {});
      expect(headers.Authorization).toBeUndefined();
    });
  });
});

  describe("claude.test.ts", () => {
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-4-6-sonnet",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: { max_tokens: 2048 },
    stream: false,
    source_surface: "messages",
    ...overrides,
  };
}

function candidate(capabilities: Readonly<Record<string, boolean>> = {}): ProviderDispatchTarget {
  return {
    provider_id: "claude",
    model_id: "claude-4-6-sonnet",
    wire_family: "messages",
    endpoint_path: "/v1/messages",
    capabilities,
  };
}

function context(
  credential_kind: ProviderDispatchContext["credential"]["credential_kind"] = "oauth",
  secret = "oauth-secret",
  request_headers?: Readonly<Record<string, string>>,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "claude",
      credential_kind,
      ...(credential_kind === "none" ? {} : { secret: encode(secret) }),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
    ...(request_headers === undefined ? {} : { request_headers }),
  };
}

function fakeFetch(
  payload: Record<string, unknown>,
  response: Record<string, unknown>,
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string")
      Object.assign(payload, JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Builds a fake fetch returning a text/event-stream body from raw SSE `data:` lines. */
function fakeSseFetch(
  payload: Record<string, unknown>,
  events: ReadonlyArray<Record<string, unknown>>,
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string")
      Object.assign(payload, JSON.parse(init.body) as Record<string, unknown>);
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("Claude canonical Messages compatibility", () => {
  test("preserves tool results, server tools, visible/redacted thinking and stop reasons", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        system: [{ kind: "text", text: "identity" }],
        tools: [{ name: "lookup", jsonSchema: { type: "object" } }],
        messages: [
          {
            role: "assistant",
            content: [
              { kind: "toolCall", call_id: "tool-1", name: "lookup", arguments: { q: "x" } },
              {
                kind: "extension",
                name: "server_tool_use",
                payload: { type: "server_tool_use", id: "server-1" },
              },
              { kind: "reasoning", payload: "summary", summary: "summary", signature: "sig" },
              {
                kind: "reasoning",
                payload: { type: "redacted_thinking", data: "opaque" },
                opaque: true,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                kind: "toolResult",
                call_id: "tool-1",
                content: [{ kind: "text", text: "result" }],
                is_error: true,
              },
            ],
          },
        ],
      }),
    );
    expect(payload.system).toEqual([
      { type: "text", text: "identity", cache_control: { type: "ephemeral" } },
    ]);
    // Stable-partitioned: all tool_use blocks trail non-tool content (S6)
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toMatchObject([
      { type: "server_tool_use", id: "server-1" },
      { type: "thinking", thinking: "summary", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "tool-1", input: { q: "x" } },
    ]);
    expect((payload.messages as Array<Record<string, unknown>>)[1]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "result" }],
        is_error: true,
        cache_control: { type: "ephemeral" },
      },
    ]);

    const response = claudeResponseToEvents(
      {
        id: "msg-1",
        model: "claude-4-6-sonnet",
        content: [
          { type: "text", text: "answer" },
          { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "done" }] },
          { type: "server_tool_use", id: "server-1", name: "web_search", input: {} },
          { type: "thinking", thinking: "visible", signature: "sig-2" },
          { type: "redacted_thinking", data: "opaque-2" },
        ],
        stop_reason: "pause_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          cache_read_input_tokens: 2,
          output_tokens_details: { thinking_tokens: 3 },
        },
      },
      request(),
    );
    expect(response.map((event) => (event as { type: string }).type)).toEqual([
      "message_start",
      "content_delta",
      "tool_result",
      "content_delta",
      "content_delta",
      "content_delta",
      "terminal",
    ]);
    expect(response[2]).toMatchObject({ type: "tool_result", call_id: "tool-1" });
    expect(response[3]).toMatchObject({ content: { kind: "extension", name: "server_tool_use" } });
    expect(response[4]).toMatchObject({ content: { kind: "reasoning", signature: "sig-2" } });
    expect(response[5]).toMatchObject({ content: { kind: "reasoning", opaque: true } });
    expect(response.at(-1)).toMatchObject({
      type: "terminal",
      stop_reason: "stop",
      provider_stop_reason: "pause_turn",
      usage: { reasoning_tokens: 3 },
    });
  });

  test("prefixes OAuth custom tools on the wire and removes exactly one prefix on return", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        tools: [
          { name: "Read", jsonSchema: { type: "object" } },
          { name: "_local", jsonSchema: { type: "object" } },
          { name: "web_search", jsonSchema: { type: "object" } },
        ],
        tool_choice: { type: "tool", name: "Read" },
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "call-1", name: "_local", arguments: {} }],
          },
        ],
      }),
      { isOAuth: true },
    );
    expect((payload.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toEqual([
      "_Read",
      "__local",
      "web_search",
    ]);
    expect(payload.tool_choice).toEqual({ type: "tool", name: "_Read" });
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toMatchObject([
      { type: "tool_use", name: "__local" },
    ]);

    const events = claudeResponseToEvents(
      { content: [{ type: "tool_use", id: "call-1", name: "__local", input: {} }] },
      request(),
      true,
    );
    expect(events.find((event) => event.type === "tool_call_delta")).toMatchObject({ name: "_local" });
  });

  test("anchors cache controls across reusable system, tools, and history", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        system: [{ kind: "text", text: "system" }],
        tools: [{ name: "lookup", jsonSchema: { type: "object" } }],
      }),
    );
    expect((payload.system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect((payload.tools as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect((payload.messages as Array<Record<string, unknown>>)[0]?.content).toMatchObject([
      { cache_control: { type: "ephemeral" } },
    ]);
  });

  test("patches computed CCH into the outbound OAuth request body, and never for API-key credentials", async () => {
    _resetClaudeVersionCache(VERSION_SOURCES.claudeCli.fallback);
    const oauthPayload: Record<string, unknown> = {};
    const oauthAdapter = new ClaudeAdapter({
      fetch: fakeFetch(oauthPayload, {
        id: "msg-1",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    await collect(oauthAdapter.dispatch(request(), candidate(), context("oauth")));
    const oauthSystem = oauthPayload.system as Array<{ text: string }>;
    const escapedCliFallback = VERSION_SOURCES.claudeCli.fallback.replaceAll(".", "\\.");
    expect(oauthSystem[0]?.text).toMatch(
      new RegExp(`^x-anthropic-billing-header: cc_version=${escapedCliFallback}\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$`),
    );
    expect(oauthSystem[0]?.text).not.toContain("cch=00000");
    expect(oauthSystem.some((block) => block.text === CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);

    const apiKeyPayload: Record<string, unknown> = {};
    const apiKeyAdapter = new AnthropicApiKeyAdapter({
      fetch: fakeFetch(apiKeyPayload, {
        id: "msg-2",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    await collect(apiKeyAdapter.dispatch(request(), candidate(), context("api_key")));
    expect(apiKeyPayload.system).toBeUndefined();
  });
});

describe("ClaudeAdapter dispatch", () => {
  test("uses the configured credential, filters custom headers, negotiates beta and parses response", async () => {
    const payload: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      base_url: "https://claude.test",
      custom_headers: { "X-Trace-Id": "fixture-1" },
      fetch: fakeFetch(payload, {
        id: "msg-2",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
    const events = await collect(
      adapter.dispatch(
        request(),
        candidate({ "claude-code-20250219": true }),
        context("oauth", "control-plane-oauth", {
          Authorization: "Bearer client-must-not-forward",
          "anthropic-beta": "claude-code-20250219",
        }),
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "terminal",
      stop_reason: "stop",
      provider_stop_reason: "end_turn",
    });
    expect(payload.model).toBe("claude-4-6-sonnet");
  });

  test("appends the user-profiles beta header when a user profile id is supplied", async () => {
    let betaHeader = "";
    const adapter = new ClaudeAdapter({
      fetch: (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        betaHeader = new Headers(init?.headers).get("anthropic-beta") ?? "";
        return new Response(
          JSON.stringify({
            id: "msg-2",
            type: "message",
            role: "assistant",
            model: "claude-4-6-sonnet",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    await collect(
      adapter.dispatch(
        request({
          generation_controls: {
            max_tokens: 2048,
            "extension:user_profile_id": "up-1",
          },
        }),
        candidate({ "claude-code-20250219": true }),
        context("oauth"),
      ),
    );
    expect(betaHeader.split(",").map((part) => part.trim())).toContain("user-profiles");
  });

  test("rejects unsupported beta and semantic capability before making a fetch", async () => {
    let fetches = 0;
    const adapter = new ClaudeAdapter({
      fetch: (async () => {
        fetches += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    let error: unknown;
    try {
      await collect(
        adapter.dispatch(
          request({ tools: [{ name: "lookup", jsonSchema: { type: "object" } }] }),
          candidate(),
          context("oauth", "secret", { "anthropic-beta": "context-1m-2025-08-07" }),
        ),
      );
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("capability_unsupported");
    expect(fetches).toBe(0);
  });
});

describe("Claude payload parity (Phase 3)", () => {
  test("caps stop_sequences at 4 entries on both wires", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({ generation_controls: { max_tokens: 100, stop: ["a", "b", "c", "d", "e", "f"] } }),
    );
    expect(payload.stop_sequences).toEqual(["a", "b", "c", "d"]);
  });

  test("clamps max_tokens to the OAuth ceiling, floors tool calls, verbatim otherwise", () => {
    const oauthClamped = canonicalToClaudeMessagesPayload(
      request({ generation_controls: { max_tokens: 100_000 } }),
      { isOAuth: true },
    );
    expect(oauthClamped.max_tokens).toBe(64000);

    const apiKeyUnclamped = canonicalToClaudeMessagesPayload(
      request({ generation_controls: { max_tokens: 100_000 } }),
      { isOAuth: false },
    );
    expect(apiKeyUnclamped.max_tokens).toBe(100_000);

    // Tools present widen a narrow ceiling to the tool-call floor.
    const floored = canonicalToClaudeMessagesPayload(
      request({
        tools: [{ name: "lookup", jsonSchema: { type: "object" } }],
        generation_controls: { max_tokens: 4096 },
      }),
      { isOAuth: false },
    );
    expect(floored.max_tokens).toBe(32000);

    // Thinking budget requires max_tokens >= budget + 1024
    const withBudget = canonicalToClaudeMessagesPayload(
      request({
        generation_controls: { max_tokens: 4096 },
        reasoning: { thinking_type: "enabled", budget_tokens: 5000 },
      }),
      { isOAuth: false },
    );
    expect(withBudget.max_tokens).toBe(5000 + 1024);
  });

  test("strips sampling params when thinking enabled", () => {
    const withThinking = canonicalToClaudeMessagesPayload(
      request({
        generation_controls: { temperature: 0.7, top_p: 0.9, top_k: 5, max_tokens: 100 },
        reasoning: { thinking_type: "enabled", budget_tokens: 1024 },
      }),
    );
    expect(withThinking.temperature).toBeUndefined();
    expect(withThinking.top_p).toBeUndefined();
    expect(withThinking.top_k).toBeUndefined();

    const withoutThinking = canonicalToClaudeMessagesPayload(
      request({
        generation_controls: { temperature: 0.7, top_p: 0.9, top_k: 5, max_tokens: 100 },
        reasoning: { thinking_type: "disabled" },
      }),
    );
    expect(withoutThinking.temperature).toBe(0.7);
    expect(withoutThinking.top_p).toBe(0.9);
    expect(withoutThinking.top_k).toBe(5);
  });

  test("moves disable_parallel_tool_use into tool_choice", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        generation_controls: { parallel_tool_calls: false, max_tokens: 100 },
        tool_choice: "auto",
      }),
    );
    expect((payload as Record<string, unknown>).disable_parallel_tool_use).toBeUndefined();
    expect((payload.tool_choice as Record<string, unknown>).disable_parallel_tool_use).toBe(true);

    const noDisable = canonicalToClaudeMessagesPayload(
      request({
        generation_controls: { parallel_tool_calls: true, max_tokens: 100 },
        tool_choice: "auto",
      }),
    );
    expect(
      (noDisable.tool_choice as Record<string, unknown>)?.disable_parallel_tool_use,
    ).toBeUndefined();
  });

  test("sanitizes lone surrogates via toWellFormed", () => {
    const lone = "\uD800 hello \uDC00 world";
    const payload = canonicalToClaudeMessagesPayload(
      request({
        messages: [{ role: "user", content: [{ kind: "text", text: lone }] }],
        reasoning: { thinking_type: "disabled" },
      }),
    );
    const msgs = payload.messages as Array<{ content: Array<{ text: string }> }>;
    const text = msgs[0]?.content[0]?.text ?? "";
    // Use includes + charCode check instead of toContain due to bun's surrogate handling bug
    expect(text.includes("\uD800")).toBe(false);
    expect(text.includes("\uDC00")).toBe(false);
    expect(text.includes("\uFFFD")).toBe(true);
    // Should contain replacement char and be well-formed
    expect(text.length).toBeGreaterThan(0);

    const toolPayload = canonicalToClaudeMessagesPayload(
      request({
        messages: [
          {
            role: "assistant",
            content: [{ kind: "toolCall", call_id: "id1", name: "tool", arguments: { arg: lone } }],
          },
        ],
      }),
    );
    const toolInput = (
      toolPayload.messages as Array<{ content: Array<{ input: Record<string, string> }> }>
    )[0]?.content[0]?.input as Record<string, string>;
    expect((toolInput.arg ?? "").includes("\uD800")).toBe(false);
    expect((toolInput.arg ?? "").includes("\uFFFD")).toBe(true);
  });

  test("stable-partitions assistant blocks so tool_use trails", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              { kind: "toolCall", call_id: "c1", name: "a", arguments: {} },
              { kind: "text", text: "after tool" },
              { kind: "toolCall", call_id: "c2", name: "b", arguments: {} },
            ],
          },
        ],
      }),
    );
    const blocks =
      (payload.messages as Array<{ content: Array<{ type: string }> }>)[0]?.content ?? [];
    const types = blocks.map((b) => b.type);
    // All tool_use should be at the tail
    const firstToolIndex = types.indexOf("tool_use");
    const lastNonTool = types.findLastIndex((t) => t !== "tool_use");
    expect(firstToolIndex).toBeGreaterThan(lastNonTool);
    expect(types).toEqual(["text", "tool_use", "tool_use"]);
  });

  test("maps stop_reason completeness including sensitive and model_context_window_exceeded", () => {
    const cases: Array<[string, string]> = [
      ["model_context_window_exceeded", "length"],
      ["sensitive", "error"],
      ["refusal", "error"],
      ["max_tokens", "length"],
      ["tool_use", "tool_use"],
      ["end_turn", "stop"],
    ];
    for (const [raw, expected] of cases) {
      const events = claudeResponseToEvents(
        {
          id: "msg",
          model: "claude-4-6-sonnet",
          content: [{ type: "text", text: "hi" }],
          stop_reason: raw,
        },
        request(),
      );
      const terminal = events.at(-1) as {
        stop_reason?: string;
        provider_stop_reason?: string;
        stop_details?: unknown;
      };
      expect(terminal.stop_reason).toBe(expected);
      expect(terminal.provider_stop_reason).toBe(raw);
    }
    // Refusal/sensitive should carry stop_details when present
    const withDetails = claudeResponseToEvents(
      {
        id: "msg",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "policy", explanation: "blocked" },
      },
      request(),
    );
    const term = withDetails.at(-1) as { stop_details?: Record<string, unknown> };
    expect(term.stop_details).toMatchObject({ type: "refusal" });
  });

  test("injects default context_management when thinking, caller policy wins", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        reasoning: { thinking_type: "enabled", budget_tokens: 1024, effort: "high" },
        generation_controls: { max_tokens: 4096 },
      }),
    );
    expect(payload.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    });
    expect(payload.output_config).toMatchObject({ effort: "high" });

    const supplied = canonicalToClaudeMessagesPayload(
      request({
        reasoning: { thinking_type: "enabled", budget_tokens: 1024 },
        generation_controls: {
          max_tokens: 4096,
          "extension:context_management": { edits: [] },
        },
      }),
    );
    expect(supplied.context_management).toEqual({ edits: [] });

    const withoutThinking = canonicalToClaudeMessagesPayload(
      request({
        reasoning: { thinking_type: "disabled" },
        generation_controls: { max_tokens: 4096 },
      }),
    );
    expect(withoutThinking.context_management).toBeUndefined();
  });

  test("defaults absent max_tokens explicitly and omits the none tier", () => {
    const defaulted = canonicalToClaudeMessagesPayload(request({ generation_controls: {} }));
    expect(defaulted.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);

    for (const effort of ["minimal", "low", "high"] as const) {
      const payload = canonicalToClaudeMessagesPayload(
        request({
          reasoning: { thinking_type: "enabled", budget_tokens: 1024, effort },
          generation_controls: { max_tokens: 4096 },
        }),
      );
      expect(payload.output_config).toMatchObject({ effort });
    }
    const nonePayload = canonicalToClaudeMessagesPayload(
      request({
        reasoning: { thinking_type: "enabled", budget_tokens: 1024, effort: "none" },
        generation_controls: { max_tokens: 4096 },
      }),
    );
    expect(nonePayload.output_config).toBeUndefined();
  });

  test("appends ?beta=true to endpoint URL for OAuth via dispatch", async () => {
    let capturedUrl: unknown;
    const adapter = new ClaudeAdapter({
      fetch: (async (input: RequestInfo | URL) => {
        capturedUrl = input;
        return new Response(
          JSON.stringify({
            id: "msg",
            model: "m",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as unknown as typeof fetch,
    });
    // Provide candidate with simple path to check ?beta=true
    await collect(
      adapter.dispatch(
        request(),
        {
          provider_id: "claude",
          model_id: "claude-4-6-sonnet",
          wire_family: "messages",
          endpoint_path: "/v1/messages",
          capabilities: {},
        },
        {
          credential: {
            provider_id: "claude",
            credential_kind: "oauth",
            secret: new TextEncoder().encode("tok"),
          },
          deadline: Date.now() + 5000,
          abort_signal: new AbortController().signal,
        },
      ),
    );
    expect(String(capturedUrl)).toContain("?beta=true");

    // Non-OAuth should not add beta param
    let capturedUrl2: unknown;
    const adapter2 = new AnthropicApiKeyAdapter({
      fetch: (async (input: RequestInfo | URL) => {
        capturedUrl2 = input;
        return new Response(
          JSON.stringify({
            id: "msg",
            model: "m",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as unknown as typeof fetch,
    });
    await collect(
      adapter2.dispatch(
        request(),
        {
          provider_id: "anthropic",
          model_id: "claude-4-6-sonnet",
          wire_family: "messages",
          endpoint_path: "/v1/messages",
          capabilities: {},
        },
        {
          credential: {
            provider_id: "anthropic",
            credential_kind: "api_key",
            secret: new TextEncoder().encode("key"),
          },
          deadline: Date.now() + 5000,
          abort_signal: new AbortController().signal,
        },
      ),
    );
    expect(String(capturedUrl2)).not.toContain("?beta=true");
  });
});

describe("Claude P1 robustness backlog (gap report Phase 4)", () => {
  test("cache_control is bare ephemeral by default: no implicit ttl (gap P8)", () => {
    const payload = canonicalToClaudeMessagesPayload(request()) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const block = payload.messages[0]?.content.at(-1);
    const control = block?.["cache_control"] as Record<string, unknown> | undefined;
    expect(control).toEqual({ type: "ephemeral" });
  });

  test("cache_control carries no scope field on any credential (gap P8)", () => {
    const oauth = canonicalToClaudeMessagesPayload(request(), { isOAuth: true }) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const oauthControl = oauth.messages[0]?.content.at(-1)?.["cache_control"] as
      Record<string, unknown> | undefined;
    expect(oauthControl).toEqual({ type: "ephemeral" });

    const apiKey = canonicalToClaudeMessagesPayload(request(), { isOAuth: false }) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const apiKeyControl = apiKey.messages[0]?.content.at(-1)?.["cache_control"] as
      Record<string, unknown> | undefined;
    expect(apiKeyControl).toEqual({ type: "ephemeral" });
  });

  test("tool eager_input_streaming and defer_loading pass through when set (gap P9)", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        tools: [
          {
            name: "search",
            jsonSchema: { type: "object" },
            eager_input_streaming: true,
            defer_loading: true,
          },
          { name: "plain", jsonSchema: { type: "object" } },
        ],
      }),
    );
    const tools = payload.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.["eager_input_streaming"]).toBe(true);
    expect(tools[0]?.["defer_loading"]).toBe(true);
    expect(tools[1]?.["eager_input_streaming"]).toBeUndefined();
    expect(tools[1]?.["defer_loading"]).toBeUndefined();
  });

  test("OAuth prefixes custom tools but leaves Anthropic built-ins in their provider namespace", () => {
    const oauth = canonicalToClaudeMessagesPayload(request({ tools: [{ name: "Bash", jsonSchema: {} }] }), {
      isOAuth: true,
    });
    expect((oauth.tools as Array<Record<string, unknown>>)[0]?.["name"]).toBe("_Bash");

    const apiKey = canonicalToClaudeMessagesPayload(
      request({ tools: [{ name: "Bash", jsonSchema: {} }] }),
      {
        isOAuth: false,
      },
    );
    expect((apiKey.tools as Array<Record<string, unknown>>)[0]?.["name"]).toBe("Bash");

    const nonColliding = canonicalToClaudeMessagesPayload(
      request({ tools: [{ name: "my_custom_tool", jsonSchema: {} }] }),
      { isOAuth: true },
    );
    expect((nonColliding.tools as Array<Record<string, unknown>>)[0]?.["name"]).toBe("_my_custom_tool");
  });

  test("normalizes image media_type aliases and tags url/file source variants (gap P14)", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "image",
                payload: { source: { type: "base64", media_type: "jpg", data: "AAAA" } },
              },
              { kind: "image", payload: { source: { url: "https://example.test/x.png" } } },
              { kind: "image", payload: { source: { file_id: "file-123" } } },
            ],
          },
        ],
      }),
    );
    const blocks = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      ?.content;
    const first = blocks?.[0]?.["source"] as Record<string, unknown> | undefined;
    expect(first?.["media_type"]).toBe("image/jpeg");
    const second = blocks?.[1]?.["source"] as Record<string, unknown> | undefined;
    expect(second?.["type"]).toBe("url");
    const third = blocks?.[2]?.["source"] as Record<string, unknown> | undefined;
    expect(third?.["type"]).toBe("file");
  });

  test("logs and forwards unsupported image media_type unchanged rather than dropping it (gap P14)", () => {
    const warnSpy = (() => {
      const original = log.warn;
      const calls: unknown[][] = [];
      log.warn = (msg: string, ...args: unknown[]) => calls.push([msg, ...args]);
      return { calls, restore: () => (log.warn = original) };
    })();
    try {
      const payload = canonicalToClaudeMessagesPayload(
        request({
          messages: [
            {
              role: "user",
              content: [
                {
                  kind: "image",
                  payload: { source: { type: "base64", media_type: "image/bmp", data: "AAAA" } },
                },
              ],
            },
          ],
        }),
      );
      const block = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
        ?.content[0];
      const source = block?.["source"] as Record<string, unknown> | undefined;
      expect(source?.["media_type"]).toBe("image/bmp");
      expect(warnSpy.calls.length).toBeGreaterThan(0);
    } finally {
      warnSpy.restore();
    }
  });

  test("mid-conversation system-role message is hoisted to top-level system, not coerced to user (gap P13)", () => {
    const payload = canonicalToClaudeMessagesPayload(
      request({
        messages: [
          { role: "user", content: [{ kind: "text", text: "hi" }] },
          { role: "assistant", content: [{ kind: "text", text: "hello" }] },
          { role: "system", content: [{ kind: "text", text: "switch tone to formal" }] },
          { role: "user", content: [{ kind: "text", text: "continue" }] },
        ],
      }),
    );
    const roles = (payload.messages as Array<{ role: string }>).map((m) => m.role);
    // Anthropic accepts `system` only at the top level; a mid-conversation
    // system turn must not be emitted as a `messages[]` role (400) nor silently
    // coerced to `user` (semantics change) — it is hoisted instead.
    expect(roles).toEqual(["user", "assistant", "user"]);
    const system = payload.system as Array<{ type: string; text: string }>;
    expect(system.some((block) => block.text === "switch tone to formal")).toBe(true);
  });

  test("metadata.user_id carries the resolved session identity on OAuth dispatch (gap P2)", async () => {
    const payload: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      fetch: fakeFetch(payload, {
        id: "msg-1",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
    await collect(
      adapter.dispatch(
        request(),
        candidate(),
        context("oauth", "oauth-secret", { "x-claude-code-session-id": "sess-real-123" }),
      ),
    );
    const userId = (payload.metadata as Record<string, unknown> | undefined)?.["user_id"];
    const parsed = JSON.parse(String(userId)) as Record<string, unknown>;
    expect(parsed["session_id"]).toBe("sess-real-123");
    expect(parsed["device_id"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("metadata.user_id forwards a valid caller id verbatim", async () => {
    const payload: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      fetch: fakeFetch(payload, {
        id: "msg-1",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
    const cloaked = `user_${"ab".repeat(32)}_account_123e4567-e89b-12d3-a456-426614174000_session_123e4567-e89b-12d3-a456-426614174000`;
    await collect(
      adapter.dispatch(
        request({
          generation_controls: { "extension:metadata_user_id": cloaked },
        }),
        candidate(),
        context("oauth"),
      ),
    );
    expect((payload.metadata as Record<string, unknown> | undefined)?.["user_id"]).toBe(cloaked);
  });

  test("metadata.user_id is absent for non-OAuth credentials", async () => {
    const payload: Record<string, unknown> = {};
    const adapter = new AnthropicApiKeyAdapter({
      fetch: fakeFetch(payload, {
        id: "msg-1",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    });
    await collect(
      adapter.dispatch(
        request(),
        { ...candidate(), provider_id: "anthropic" },
        {
          credential: {
            provider_id: "anthropic",
            credential_kind: "api_key",
            secret: new TextEncoder().encode("key"),
          },
          deadline: Date.now() + 5000,
          abort_signal: new AbortController().signal,
        },
      ),
    );
    expect(payload.metadata).toBeUndefined();
  });

  test("usage accounting merges message_start input/cache tokens with message_delta output tokens (gap S8)", async () => {
    const payload: Record<string, unknown> = {};
    const adapter = new ClaudeAdapter({
      fetch: fakeSseFetch(payload, [
        {
          type: "message_start",
          message: {
            id: "msg-1",
            model: "claude-4-6-sonnet",
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 40,
              cache_creation: { ephemeral_5m_input_tokens: 12, ephemeral_1h_input_tokens: 8 },
            },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 7 },
        },
        { type: "message_stop" },
      ]),
    });
    const events = await collect(
      adapter.dispatch(request({ stream: true }), candidate(), context()),
    );
    const terminal = events.at(-1) as { usage?: Record<string, unknown> };
    // Fresh 100 + read 40 + written 20: Anthropic input_tokens excludes cache.
    expect(terminal.usage?.["input_tokens"]).toBe(160);
    expect(terminal.usage?.["cached_input_tokens"]).toBe(40);
    expect(terminal.usage?.["cache_write_tokens"]).toBe(20);
    expect(terminal.usage?.["output_tokens"]).toBe(7);
  });

  test("non-stream response reads nested cache_creation ephemeral breakdown (gap S8)", () => {
    const response = claudeResponseToEvents(
      {
        id: "msg-1",
        model: "claude-4-6-sonnet",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 50,
          output_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 },
        },
      },
      request(),
    );
    const terminal = response.at(-1) as { usage?: Record<string, unknown> };
    expect(terminal.usage?.["cache_write_tokens"]).toBe(40);
  });
});

describe("Claude streaming HTTP failure mapping", () => {
  test("rejects a truncated SSE stream without message_stop", async () => {
    const adapter = new ClaudeAdapter({
      fetch: fakeSseFetch({}, [
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    });
    const failure = await collect(
      adapter.dispatch(request({ stream: true }), candidate(), context()),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).message).toContain("message_stop");
  });

  test("streaming 401 maps to authentication_failed, not an SSE parse error", async () => {
    const adapter = new ClaudeAdapter({
      fetch: (async () =>
        new Response(JSON.stringify({ type: "error", error: { message: "invalid key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const failure = await collect(
      adapter.dispatch(request({ stream: true }), candidate(), context()),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("authentication_failed");
    expect((failure as GatewayError).status).toBe(401);
  });

  test("streaming 429 maps to quota_exceeded", async () => {
    const adapter = new ClaudeAdapter({
      fetch: (async () =>
        new Response(JSON.stringify({ type: "error", error: { message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const failure = await collect(
      adapter.dispatch(request({ stream: true }), candidate(), context()),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("quota_exceeded");
  });

  test("in-stream SSE 407/529/5xx share the HTTP status→code table", async () => {
    const cases: ReadonlyArray<{
      readonly status: number;
      readonly code: GatewayError["code"];
      readonly origin: GatewayError["origin"];
    }> = [
      { status: 407, code: "proxy_auth_required", origin: "network" },
      { status: 529, code: "capacity_exhausted", origin: "upstream" },
      { status: 503, code: "platform_unavailable", origin: "upstream" },
    ];
    for (const { status, code, origin } of cases) {
      const adapter = new ClaudeAdapter({
        fetch: fakeSseFetch({}, [
          { type: "error", error: { status, code: "overloaded_error", message: "boom" } },
        ]),
      });
      const failure = await collect(
        adapter.dispatch(request({ stream: true }), candidate(), context()),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(GatewayError);
      expect((failure as GatewayError).code).toBe(code);
      expect((failure as GatewayError).status).toBe(status);
      expect((failure as GatewayError).origin).toBe(origin);
      expect((failure as GatewayError).details["providerCode"]).toBe("overloaded_error");
      expect((failure as GatewayError).details["upstreamStatus"]).toBe(status);
    }
  });

  test("in-stream SSE 401 carries credential evidence", async () => {
    const adapter = new ClaudeAdapter({
      fetch: fakeSseFetch({}, [
        { type: "error", error: { status: 401, message: "invalid api key" } },
      ]),
    });
    const failure = await collect(
      adapter.dispatch(request({ stream: true }), candidate(), context()),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("authentication_failed");
    expect((failure as GatewayError).details["credentialEvidence"]).toBe(true);
  });

  test("in-stream SSE error without a status falls back to platform_unavailable", async () => {
    const adapter = new ClaudeAdapter({
      fetch: fakeSseFetch({}, [{ type: "error", error: { message: "broken" } }]),
    });
    const failure = await collect(
      adapter.dispatch(request({ stream: true }), candidate(), context()),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(502);
    expect((failure as GatewayError).code).toBe("platform_unavailable");
  });
});
  });

});

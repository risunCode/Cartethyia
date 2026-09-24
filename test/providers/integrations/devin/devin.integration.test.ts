import { describe, expect, test } from "bun:test";
import { DEVIN_AUTHORIZE_URL, DEVIN_TOKEN_URL, DevinOAuthClient, expiryFromDevinJwt } from "../../../../src/providers/integrations/devin/devin-oauth";
import { gzipSync } from "node:zlib";
import { create, toBinary } from "@bufbuild/protobuf";
import { GetChatMessageResponseSchema } from "../../../../src/providers/integrations/devin/generated/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "../../../../src/providers/integrations/devin/generated/exa/auth_pb/auth_pb";
import { _resetDevinAuthCache, buildDevinChatRequest, createDevinAdapter, fetchDevinModels, normalizeDevinSessionToken } from "../../../../src/providers/integrations/devin/devin";
import { DEVIN_MODELS } from "../../../../src/providers/integrations/devin/catalog";
import type { CanonicalRequest, CanonicalMessage } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../../src/providers/provider-registry";
import { CONNECT_COMPRESSED_FLAG, CONNECT_END_STREAM_FLAG, frameConnectMessage } from "../../../../src/providers/integrations/connect";

describe("Devin Integration", () => {
  describe("devin-oauth.test.ts", () => {
function jwt(exp: number, email = "dev@example.com"): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp, email })}.sig`;
}

describe("Devin OAuth", () => {
  test("builds the PKCE authorize URL against the console callback", () => {
    process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://console.example.com";
    const client = new DevinOAuthClient();
    const url = new URL(
      client.buildAuthorizeUrl({ state: "state-1", codeChallenge: "challenge-1", redirectUri: "http://127.0.0.1:59653/callback" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(DEVIN_AUTHORIZE_URL);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:59653/callback",
    );
    delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
  });

  test("exchanges code for the token with JWT expiry and label", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const token = jwt(exp);
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new DevinOAuthClient(fetcher);
    const result = await client.exchangeCode("code-1", "verifier-1");
    expect(seenUrl).toBe(DEVIN_TOKEN_URL);
    expect(seenBody).toEqual({ code: "code-1", code_verifier: "verifier-1" });
    expect(result).toMatchObject({
      access: token,
      refresh: token,
      accountLabel: "dev@example.com",
    });
    expect(result.expiresAt.getTime()).toBe(exp * 1000);
  });

  test("falls back to 365 days for opaque tokens", () => {
    const before = Date.now();
    const expires = expiryFromDevinJwt("opaque-token");
    expect(expires.getTime() - before).toBeGreaterThan(364 * 24 * 3_600 * 1_000);
  });
});
  });

  describe("devin.test.ts", () => {
void GetChatMessageResponseSchema;

function request(): CanonicalRequest {
  return {
    model: "swe-1-6-slow",
    messages: [{ role: "user", content: [{ kind: "text", text: "fix it" }] }],
    generation_controls: { max_output_tokens: 128 },
    stream: false,
    source_surface: "chat",
  };
}

const candidate: ProviderDispatchTarget = {
  provider_id: "devin",
  model_id: "swe-1-6-slow",
  wire_family: "native",
  endpoint_path: "/exa.api_server_pb.ApiServerService/GetChatMessage",
  capabilities: {},
};

function context(): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "devin",
      credential_kind: "oauth",
      secret: new TextEncoder().encode("session-abc"),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

describe("Devin token handling", () => {
  test("normalizes session tokens and resets the userJwt cache", () => {
    expect(normalizeDevinSessionToken("abc")).toBe("devin-session-token$abc");
    expect(normalizeDevinSessionToken("devin-session-token$abc")).toBe(
      "devin-session-token$abc",
    );
    expect(normalizeDevinSessionToken(undefined)).toBe("");
    _resetDevinAuthCache();
  });

  test("static catalog carries the reference fallback model", () => {
    expect(DEVIN_MODELS).toHaveLength(1);
    expect(DEVIN_MODELS[0]).toMatchObject({
      modelId: "swe-1-6-slow",
      wireFamily: "native",
      contextLimit: 200_000,
      outputLimit: 64_000,
    });
  });

  test("empty credentials skip discovery without network", async () => {
    await expect(fetchDevinModels("   ")).resolves.toBeNull();
  });
});

describe("Devin chat request", () => {
  test("builds a decodable GetChatMessage request with images and websearch", async () => {
    const { GetChatMessageRequestSchema } = await import(
      "../../../../src/providers/integrations/devin/generated/exa/api_server_pb/api_server_pb"
    );
    const { fromBinary } = await import("@bufbuild/protobuf");
    const messagesWithImage: CanonicalMessage[] = [
      {
        role: "user",
        content: [
          { kind: "text", text: "What is in this image?" },
          { kind: "image", payload: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
        ],
      },
    ];
    const bytes = buildDevinChatRequest(
      "swe-1-6-slow",
      messagesWithImage,
      "be helpful",
      [{ name: "web_search", tool_type: "web_search", description: "", jsonSchema: {} }],
      { maxTokens: 64_000, conversationId: "cascade-1" },
      "devin-session-token$abc",
      "jwt-1",
    );
    const decoded = fromBinary(GetChatMessageRequestSchema, bytes);
    expect(decoded.chatModelUid).toBe("swe-1-6-slow");
    expect(decoded.prompt).toBe("be helpful");
    expect(decoded.cascadeId).toBe("cascade-1");
    expect(decoded.chatMessagePrompts.length).toBe(1);
    expect(decoded.chatMessagePrompts[0]?.images.length).toBe(1);
    expect(decoded.chatMessagePrompts[0]?.images[0]?.mimeType).toBe("image/png");
    expect(decoded.chatMessagePrompts[0]?.images[0]?.base64Data).toBe("iVBORw0KGgoAAAANSUhEUg==");
    expect(decoded.experimentConfig?.forceEnableExperimentStrings).toContain("CASCADE_WEB_SEARCH_ENABLED");
    // web_search is handled as an internal Cascade experiment capability, not forwarded as a client function tool
    expect(decoded.tools.length).toBe(0);
  });
});

describe("Devin dispatch over mocked Connect upstream", () => {
  test("exchanges GetUserJwt then streams text usage and terminal", async () => {
    _resetDevinAuthCache();
    const seen: string[] = [];
    const authBytes = toBinary(
      GetUserJwtResponseSchema,
      create(GetUserJwtResponseSchema, { userJwt: "jwt-1", customApiServerUrl: "" }),
    );
    const textBytes = toBinary(
      GetChatMessageResponseSchema,
      create(GetChatMessageResponseSchema, { deltaText: "done" }),
    );
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/exa.auth_pb.AuthService/GetUserJwt")) {
        return new Response(authBytes, { status: 200 });
      }
      expect(new Headers(init?.headers).get("connect-content-encoding")).toBe("gzip");
      const body = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frameConnectMessage(gzipSync(textBytes), CONNECT_COMPRESSED_FLAG));
            controller.enqueue(
              frameConnectMessage(new TextEncoder().encode("{}"), CONNECT_END_STREAM_FLAG),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
      return body;
    }) as unknown as typeof fetch;

    const adapter = createDevinAdapter({ fetch: fetcher });
    const events = [];
    for await (const event of adapter.dispatch(request(), candidate, context())) {
      events.push(event);
    }
    expect(seen[0]).toBe("https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt");
    expect(seen[1]).toBe(
      "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
    );
    expect(events[0]).toMatchObject({ type: "response_start" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "content_delta",
        content: { kind: "text", text: "done" },
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });

    // Second dispatch reuses the cached userJwt: no second auth call.
    const second = [];
    for await (const event of adapter.dispatch(request(), candidate, context())) {
      second.push(event);
    }
    expect(seen.filter((url) => url.endsWith("GetUserJwt"))).toHaveLength(1);
    expect(second.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
    _resetDevinAuthCache();
  });

  test("rejects non-function tools and accepts API-key credential kind", async () => {
    const adapter = createDevinAdapter({
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const withTool = {
      ...request(),
      tools: [
        {
          name: "computer",
          description: "",
          jsonSchema: { type: "object" },
          tool_type: "computer_use",
        },
      ],
    } as unknown as CanonicalRequest;
    await expect(
      (async () => {
        for await (const _event of adapter.dispatch(withTool, candidate, context())) {}
      })(),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
    const apiKeyContext: ProviderDispatchContext = {
      ...context(),
      credential: { provider_id: "devin", credential_kind: "api_key" },
    };
    await expect(
      (async () => {
        for await (const _event of adapter.dispatch(request(), candidate, apiKeyContext)) {}
      })(),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });
});
  });

});

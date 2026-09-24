import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeBuddyModel } from "../../../../src/providers/integrations/buddy/buddy-catalog-shared";
import { VERSION_SOURCES, buildCodeBuddyUserAgent, _resetCodeBuddyVersionCache } from "../../../../src/providers/operations/client-versions";
import { buddyPrePayloadCommon, coalesceConsecutiveUserMessages, dropEmptyBuddyMessages, ensureBuddyLeadingSystem } from "../../../../src/providers/integrations/buddy/buddy-chat-shared";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchTarget, ProviderDispatchContext } from "../../../../src/providers/provider-registry";
import { CODEBUDDY_PROVIDER_ID, CODEBUDDY_MODELS, createCodeBuddyAdapter } from "../../../../src/providers/integrations/buddy/codebuddy";
import { CODEBUDDY_CN_PROVIDER_ID, CODEBUDDY_CN_MODELS, codeBuddyCnPrePayload, createCodeBuddyCnAdapter } from "../../../../src/providers/integrations/buddy/codebuddy-cn";
import {
  BuddyOAuthClient,
  buddyAccountLabel,
  strictResponseCode,
  type BuddyOAuthVariant,
} from "../../../../src/providers/integrations/buddy/buddy-oauth-shared";

describe("CodeBuddy Integration", () => {
  // Seed the client version so request contracts are asserted against a
  // fixed value. Seeding also stops background discovery during the suite.
  beforeEach(() => {
    _resetCodeBuddyVersionCache(VERSION_SOURCES.codebuddy.fallback);
  });
  afterEach(() => {
    _resetCodeBuddyVersionCache();
  });
  describe("codebuddy shared kernel", () => {
  test("resolves a display label from CodeBuddy's Keycloak JWT identity claims", () => {
    const token = [
      "header",
      Buffer.from(JSON.stringify({
        sub: "acct-1",
        email: "user@example.test",
        preferred_username: "user@example.test",
        name: "Some User",
        given_name: "Some",
        family_name: "User",
      })).toString("base64url"),
      "sig",
    ].join(".");
    expect(buddyAccountLabel(token)).toBe("Some User <user@example.test>");

    // Preferred username is used when `email` is absent; family-name-only falls back to `name`.
    const token2 = [
      "header",
      Buffer.from(JSON.stringify({ sub: "acct-2", preferred_username: "dev@example.test" })).toString("base64url"),
      "sig",
    ].join(".");
    expect(buddyAccountLabel(token2)).toBe("dev@example.test");

    // Opaque (non-JWT) access tokens fall back to no label so the operator's label survives.
    expect(buddyAccountLabel("opaque-token")).toBeUndefined();
    expect(buddyAccountLabel("")).toBeUndefined();
  });

  test("common pre-payload forces stream and gates reasoning summary", () => {
    const withEffort: Record<string, unknown> = {
      reasoning_effort: "high",
      agent: "x",
      agent_mode: "y",
      agent_prompt: "z",
    };
    buddyPrePayloadCommon(withEffort);
    expect(withEffort).toMatchObject({ stream: true, reasoning_effort: "high", reasoning_summary: "auto" });
    expect("agent" in withEffort).toBe(false);
    expect("agent_mode" in withEffort).toBe(false);
    expect("agent_prompt" in withEffort).toBe(false);

    const off: Record<string, unknown> = { reasoning_effort: "none", reasoning_summary: "auto" };
    buddyPrePayloadCommon(off);
    expect("reasoning_effort" in off).toBe(false);
    expect("reasoning_summary" in off).toBe(false);

    const bare: Record<string, unknown> = {};
    buddyPrePayloadCommon(bare);
    expect(bare).toEqual({ stream: true });
  });

  test("model helper maps a raw tuple entry", () => {
    expect(makeBuddyModel(["glm-5.2", "GLM 5.2", true, true, 1_000_000, 48_000], "cb")).toMatchObject({
      modelId: "glm-5.2",
      wireFamily: "chat",
      endpointPath: "/chat/completions",
      contextLimit: 1_000_000,
      outputLimit: 48_000,
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: true,
      toolCall: true,
      webSearch: false,
    });
  });
  });
});

function responseSse(): Response {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
    JSON.stringify({ choices: [{ delta, finish_reason }] });
  return new Response(
    `data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "glm-5.2",
    messages: [
      {
        role: "system",
        content: [{ kind: "text", text: "You are an AI agent with orchestration capabilities." }],
      },
      { role: "user", content: [{ kind: "text", text: "hello" }] },
    ],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function candidate(providerId: ProviderDispatchTarget["provider_id"]): ProviderDispatchTarget {
  return {
    provider_id: providerId,
    model_id: "glm-5.2",
    wire_family: "chat",
    endpoint_path: "/chat/completions",
    capabilities: {},
  };
}

function context(
  credentialKind: "api_key" | "oauth" = "api_key",
  providerId: ProviderDispatchTarget["provider_id"] = CODEBUDDY_PROVIDER_ID,
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: providerId,
      credential_kind: credentialKind,
      secret: new TextEncoder().encode("test-token"),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

describe("CodeBuddy adapter contracts", () => {
  beforeEach(() => {
    _resetCodeBuddyVersionCache(VERSION_SOURCES.codebuddy.fallback);
  });
  afterEach(() => {
    _resetCodeBuddyVersionCache();
  });
  test("intl forces upstream streaming, injects the CodeBuddy system prompt, and types user content", async () => {
    let body: Record<string, unknown> = {};
    let seenUrl = "";
    let seenHeaders = new Headers();
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseSse();
    }) as typeof fetch;
    const adapter = createCodeBuddyAdapter(fetcher);
    const events = [];
    for await (const event of adapter.dispatch(request(), candidate(CODEBUDDY_PROVIDER_ID), context())) {
      events.push(event);
    }

    expect(seenUrl).toBe("https://www.codebuddy.ai/v2/chat/completions");
    expect(seenHeaders.get("authorization")).toBe("Bearer test-token");
    expect(seenHeaders.get("x-domain")).toBe("www.codebuddy.ai");
    expect(seenHeaders.get("x-ide-type")).toBe("IDE");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "You are CodeBuddy Code." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "terminal", state: "complete" });
  });
  test("preserves stable x-conversation-id from inbound request headers", async () => {
    let seenHeaders = new Headers();
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return responseSse();
    }) as typeof fetch;
    const adapter = createCodeBuddyAdapter(fetcher);
    const dispatchCtx: ProviderDispatchContext = {
      ...context("oauth", CODEBUDDY_PROVIDER_ID),
      request_headers: { "x-conversation-id": "client-session-12345" },
    };
    for await (const _ of adapter.dispatch(request(), candidate(CODEBUDDY_PROVIDER_ID), dispatchCtx)) {
      // drain
    }
    expect(seenHeaders.get("x-conversation-id")).toBe("client-session-12345");
    expect(seenHeaders.get("x-request-id")).toBeDefined();
  });

  test("CN neutralizes agent system prompts and keeps reasoning opt-in", () => {
    const payload: Record<string, unknown> = {
      stream: false,
      messages: [{ role: "system", content: "You are Claude Code, an official CLI agent." }],
      model: "glm-5.2",
      reasoning_effort: "off",
    };
    codeBuddyCnPrePayload(payload, request(), candidate(CODEBUDDY_CN_PROVIDER_ID));
    expect(payload.stream).toBe(true);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.reasoning_summary).toBeUndefined();
    expect(payload.messages).toEqual([
      {
        role: "system",
        content: "You are a helpful AI assistant that helps with software engineering tasks.",
      },
    ]);
  });

  test("CN accepts an OAuth credential and sends CLI headers to the Tencent host", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return responseSse();
    }) as typeof fetch;
    const adapter = createCodeBuddyCnAdapter(fetcher);
    for await (const _event of adapter.dispatch(
      request({ stream: false }),
      candidate(CODEBUDDY_CN_PROVIDER_ID),
      context("oauth", CODEBUDDY_CN_PROVIDER_ID),
    )) {
      // Consume the canonical stream to exercise the complete dispatch path.
    }
    expect(seenUrl).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(seenHeaders.get("authorization")).toBe("Bearer test-token");
    expect(seenHeaders.get("user-agent")).toBe(`CLI/${VERSION_SOURCES.codebuddy.fallback} CodeBuddy/${VERSION_SOURCES.codebuddy.fallback}`);
    expect(seenHeaders.get("x-ide-type")).toBe("CLI");
    expect(seenHeaders.get("x-ide-name")).toBe("CLI");
    expect(seenHeaders.get("x-domain")).toBe("copilot.tencent.com");
    expect(seenHeaders.get("x-codebuddy-request")).toBe("1");
  });

  test("catalogs match the current CodeBuddy provider split", () => {
    expect(CODEBUDDY_MODELS).toHaveLength(26);
    expect(CODEBUDDY_MODELS).toHaveLength(26);
    expect(CODEBUDDY_CN_MODELS).toHaveLength(12);
    expect(CODEBUDDY_MODELS.some((model) => model.modelId === "deepseek-v4.1-flash")).toBe(true);
    expect(CODEBUDDY_MODELS.some((model) => model.modelId === "glm-5.3")).toBe(true);
    expect(CODEBUDDY_CN_MODELS.some((model) => model.modelId === "glm-5.3-flash")).toBe(true);
  });

  test("hy3 and hy4-preview are tool- and reasoning-capable, text-only, 1M ctx", () => {
    for (const id of ["hy3", "hy4-preview"]) {
      const model = CODEBUDDY_MODELS.find((m) => m.modelId === id);
      expect(model).toBeDefined();
      expect(model?.toolCall).toBe(true);
      expect(model?.reasoning).toBe(true);
      expect(model?.contextLimit).toBe(1_000_000);
      expect(model?.modalities.input).toEqual(["text"]);
    }
  });

  test("intl coalesces consecutive user turns so an image-only turn keeps its attachment", async () => {
    // VS Code Copilot delivers a pasted screenshot as its own user turn
    // (image parts only) followed by a text-only user turn. CodeBuddy's
    // upstream merges those itself and drops the image while doing so, so the
    // adapter must merge them before dispatch.
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    let body: Record<string, unknown> = {};
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseSse();
    }) as typeof fetch;
    const adapter = createCodeBuddyAdapter(fetcher);
    for await (const _event of adapter.dispatch(
      request({
        messages: [
          { role: "system", content: [{ kind: "text", text: "sys" }] },
          { role: "user", content: [{ kind: "image", payload: image.image_url }] },
          { role: "user", content: [{ kind: "text", text: "coba liat ini" }] },
          { role: "assistant", content: [{ kind: "text", text: "ok" }] },
          { role: "user", content: [{ kind: "text", text: "apa itu?" }] },
        ],
      }),
      candidate(CODEBUDDY_PROVIDER_ID),
      context(),
    )) {
      // Consume the canonical stream to exercise the complete dispatch path.
    }

    expect(body.messages).toEqual([
      { role: "system", content: "You are CodeBuddy Code." },
      {
        role: "user",
        content: [image, { type: "text", text: "coba liat ini" }],
      },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "apa itu?" }] },
    ]);
  });

  test("coalescing is lossless and scoped to adjacent user turns", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "user", content: "second" },
      { role: "user", content: [{ type: "text", text: "third" }] },
      { role: "assistant", content: "reply" },
      { role: "user", content: "after assistant" },
    ];
    coalesceConsecutiveUserMessages(messages);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "text", text: "second" },
          { type: "text", text: "third" },
        ],
      },
      { role: "assistant", content: "reply" },
      { role: "user", content: "after assistant" },
    ]);
  });

  test("CN coalesces consecutive user turns the same way", () => {
    const payload: Record<string, unknown> = {
      stream: false,
      model: "glm-5.2",
      messages: [
        { role: "system", content: "You are Claude Code, an official CLI agent." },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "user", content: "coba liat ini" },
      ],
    };
    codeBuddyCnPrePayload(payload, request(), candidate(CODEBUDDY_CN_PROVIDER_ID));
    expect(payload.messages).toEqual([
      {
        role: "system",
        content: "You are a helpful AI assistant that helps with software engineering tasks.",
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "text", text: "coba liat ini" },
        ],
      },
    ]);
  });

  test("empty-content turns are dropped but tool and reasoning turns survive", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "user", content: [] },
      { role: "user", content: null },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read" } }] },
      { role: "tool", tool_call_id: "c1", content: "output" },
      { role: "assistant", content: null, reasoning_content: "thinking trace" },
      { role: "user", content: "real question" },
    ];
    dropEmptyBuddyMessages(messages);
    expect(messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read" } }] },
      { role: "tool", tool_call_id: "c1", content: "output" },
      { role: "assistant", content: null, reasoning_content: "thinking trace" },
      { role: "user", content: "real question" },
    ]);
  });

  test("a history opening with a bare user turn gains a leading system turn", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: "hello" },
    ];
    ensureBuddyLeadingSystem(messages, "You are a helpful AI assistant that helps with software engineering tasks.");
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a helpful AI assistant that helps with software engineering tasks.",
    });
    expect(messages).toHaveLength(2);
  });

  test("CN installs the neutral prompt when the history has no system turn at all", () => {
    const payload: Record<string, unknown> = {
      stream: false,
      model: "glm-5.2",
      messages: [{ role: "user", content: "hello" }],
    };
    codeBuddyCnPrePayload(payload, request(), candidate(CODEBUDDY_CN_PROVIDER_ID));
    const messages = payload.messages as Array<Record<string, unknown>>;
    // The guarantee under test is the leading system turn (11128); CN keeps
    // bare string user content on its own path rather than rebuilding it.
    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a helpful AI assistant that helps with software engineering tasks.",
    });
    expect(messages).toHaveLength(2);
  });
});

describe("CodeBuddy device OAuth", () => {
  beforeEach(() => {
    _resetCodeBuddyVersionCache(VERSION_SOURCES.codebuddy.fallback);
  });
  afterEach(() => {
    _resetCodeBuddyVersionCache();
  });
  test("uses provider state polling and bespoke refresh headers", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    let count = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      count += 1;
      if (count === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { state: "state-1", authUrl: "https://codebuddy.example/login" },
          }),
        );
      }
      if (count === 2) return new Response(JSON.stringify({ code: 11217, msg: "pending" }));
      if (count === 3) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 3600 },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new BuddyOAuthClient(
      {
        providerId: "cbcn",
        providerLabel: "CodeBuddy",
        domain: "copilot.tencent.com",
        platform: "CLI",
        userAgent: async () => buildCodeBuddyUserAgent("CLI"),
        deviceStartUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
        devicePollUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
        refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
        responseCode: strictResponseCode,
      } satisfies BuddyOAuthVariant,
      fetcher,
    );

    const started = await client.startDeviceAuth();
    const pending = await client.pollDeviceAuth(started.deviceAuthId);
    const complete = await client.pollDeviceAuth(started.deviceAuthId);
    const refreshed = await client.refresh(complete.status === "complete" ? complete.result.refresh : "refresh-1");

    expect(started).toMatchObject({ deviceAuthId: "state-1", verificationUri: "https://codebuddy.example/login", userCode: "" });
    expect(pending).toEqual({ status: "pending" });
    expect(complete.status).toBe("complete");
    expect(refreshed.access).toBe("access-2");
    expect(calls[0]?.url).toContain("?platform=CLI");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("x-domain")).toBe("copilot.tencent.com");
    expect(calls[0]?.headers.get("user-agent")).toBe(`CLI/${VERSION_SOURCES.codebuddy.fallback} CodeBuddy/${VERSION_SOURCES.codebuddy.fallback}`);
    expect(calls[1]?.url).toContain("?state=state-1");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.headers.get("x-no-authorization")).toBe("true");
    expect(calls[1]?.headers.get("x-no-user-id")).toBe("true");
    expect(calls[1]?.headers.get("x-no-department-info")).toBe("true");
    expect(calls[2]?.headers.get("x-no-enterprise-id")).toBe("true");
    expect(calls[3]?.headers.get("x-refresh-token")).toBe("refresh-1");
    expect(calls[3]?.headers.get("x-auth-refresh-source")).toBe("plugin");
  });

  test("intl device start uses platform=ide and the .ai domain", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({
          code: 0,
          data: { state: "state-intl", authUrl: "https://www.codebuddy.ai/login" },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new BuddyOAuthClient(
      {
        providerId: "cb",
        providerLabel: "CodeBuddy",
        domain: "www.codebuddy.ai",
        platform: "ide",
        userAgent: async () => buildCodeBuddyUserAgent("IDE"),
        deviceStartUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
        devicePollUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
        refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
        responseCode: strictResponseCode,
      } satisfies BuddyOAuthVariant,
      fetcher,
    );
    const started = await client.startDeviceAuth();
    expect(started).toMatchObject({
      deviceAuthId: "state-intl",
      verificationUri: "https://www.codebuddy.ai/login",
      userCode: "",
    });
    expect(calls[0]?.url).toContain("?platform=ide");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("x-domain")).toBe("www.codebuddy.ai");
    expect(calls[0]?.headers.get("user-agent")).toBe(
      `IDE/${VERSION_SOURCES.codebuddy.fallback} CodeBuddy/${VERSION_SOURCES.codebuddy.fallback}`,
    );
  });
});

describe("chat SSE null-usage tolerance", () => {
  test("usage:null frames do not break the stream", async () => {
    const { decodeChatSseStream } = await import("../../../../src/protocol/response/chat");
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }], usage: null })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
      "data: [DONE]",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
        controller.close();
      },
    });
    const events = [];
    for await (const event of decodeChatSseStream(body, {
      model: "deepseek-v4.1-flash",
    } as Parameters<typeof decodeChatSseStream>[1])) {
      events.push(event);
    }
    const terminal = events.at(-1) as { state: string; usage: { input_tokens: number } };
    expect(terminal.state).toBe("complete");
    expect(terminal.usage.input_tokens).toBe(3);
  });
});

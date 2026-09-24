import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetWorkBuddyClientVersionCache,
  _resetWorkBuddyVersionCache,
  getWorkBuddyClientVersion,
  getWorkBuddyCliVersion,
  resolveWorkBuddyClientVersion,
} from "../../../../src/providers/operations/client-versions";
import {
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_MODELS,
  createWorkBuddyAdapter,
  workbuddyPrePayload,
} from "../../../../src/providers/integrations/buddy/workbuddy";
import { makeBuddyModel } from "../../../../src/providers/integrations/buddy/buddy-catalog-shared";
import { WORKBUDDY_CHAT_PATH } from "../../../../src/providers/integrations/buddy/workbuddy-shared";
import {
  buddyPrePayloadCommon,
  coalesceConsecutiveUserMessages,
} from "../../../../src/providers/integrations/buddy/buddy-chat-shared";
import {
  WORKBUDDY_OAUTH_VARIANT,
} from "../../../../src/providers/integrations/buddy/workbuddy-oauth";
import {
  BuddyOAuthClient,
  buddyAccountLabel,
} from "../../../../src/providers/integrations/buddy/buddy-oauth-shared";
import { fetchWorkBuddyQuota } from "../../../../src/providers/integrations/buddy/workbuddy-quota";
import type { CanonicalRequest } from "../../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../../src/providers/provider-registry";

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

function candidate(): ProviderDispatchTarget {
  return {
    provider_id: WORKBUDDY_PROVIDER_ID,
    model_id: "glm-5.2",
    wire_family: "chat",
    endpoint_path: "/v2/chat/completions",
    capabilities: {},
  };
}

function context(
  credentialKind: "api_key" | "oauth" = "api_key",
  accountId = "acct-1",
): ProviderDispatchContext {
  return {
    credential: {
      provider_id: WORKBUDDY_PROVIDER_ID,
      account_id: accountId,
      credential_kind: credentialKind,
      secret: new TextEncoder().encode("test-token"),
    },
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}
describe("WorkBuddy integration", () => {
  beforeEach(() => {
    _resetWorkBuddyClientVersionCache();
    _resetWorkBuddyVersionCache(VERSION_SOURCES.workbuddyCli.fallback);
  });
  afterEach(() => {
    _resetWorkBuddyClientVersionCache();
    _resetWorkBuddyVersionCache();
  });

  test("model helper maps a raw tuple entry", () => {
    const model = makeBuddyModel(["test-model", "Test Model", true, true, 1000, 200], "workbuddy", WORKBUDDY_CHAT_PATH);
    expect(model.modelId).toBe("test-model");
    expect(model.reasoning).toBe(true);
    expect(model.modalities.input).toContain("text");
    expect(model.modalities.input).toContain("image");
    expect(model.contextLimit).toBe(1000);
    expect(model.outputLimit).toBe(200);
  });


  test("resolves the desktop version from the official update manifest", async () => {
    const source = VERSION_SOURCES.workbuddyClient.sources[0];
    if (!source) throw new Error("WorkBuddy desktop update source is missing");
    const fetcher = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(source.url);
      return new Response(
        JSON.stringify({ version: "5.5.2.37849279", productVersion: "5.5.2.37849279" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await resolveWorkBuddyClientVersion(fetcher);
    expect(getWorkBuddyClientVersion()).toBe("5.5.2.37849279");
  });
  test("prePayloadCommon forces streaming and keeps reasoning opt-in", () => {
    const payload: Record<string, unknown> = {
      stream: false,
      reasoning_effort: "off",
      agent: "x",
      agent_mode: "y",
      agent_prompt: "z",
    };
    buddyPrePayloadCommon(payload);
    expect(payload.stream).toBe(true);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.reasoning_summary).toBeUndefined();
    expect(payload.agent).toBeUndefined();
    expect(payload.agent_mode).toBeUndefined();
    expect(payload.agent_prompt).toBeUndefined();
  });

  test("coalesce merges consecutive user turns without dropping image parts", () => {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "see" }] },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] },
    ];
    coalesceConsecutiveUserMessages(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "see" },
      { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
    ]);
  });

  test("prePayload injects the WorkBuddy system prompt and types user content", () => {
    const payload: Record<string, unknown> = {
      stream: false,
      model: "glm-5.2",
      messages: [
        { role: "system", content: "client system" },
        { role: "user", content: "hello" },
      ],
    };
    workbuddyPrePayload(payload, request(), candidate());
    expect(payload.stream).toBe(true);
    expect(payload.messages).toEqual([
      { role: "system", content: "You are WorkBuddy AI." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("normalizes DeepSeek thinking, tool schemas, and names", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      tools: [
        {
          type: "function",
          function: {
            name: "bad.name",
            parameters: {
              type: "object",
              properties: {
                value: { type: "string" },
                optional: { type: "boolean" },
              },
              required: ["value"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "badname",
            parameters: { type: "object", properties: { other: { type: "string" } } },
          },
        },
      ],
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: { name: "bad.name", arguments: "{}" },
            },
          ],
        },
      ],
      tool_choice: { type: "function", function: { name: "bad.name" } },
    };

    workbuddyPrePayload(payload, request(), candidate());

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
    expect(payload.reasoning_summary).toBe("auto");
    const tools = payload.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => (tool.function as Record<string, unknown>).name)).toEqual([
      "badname",
      "badname_2",
    ]);
    const firstParameters = (tools[0]?.function as Record<string, unknown>).parameters as Record<string, unknown>;
    const secondParameters = (tools[1]?.function as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(firstParameters.required).toEqual(["value", "optional"]);
    expect(secondParameters.required).toEqual(["other"]);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const assistant = messages[1] as Record<string, unknown>;
    const calls = assistant.tool_calls as Array<Record<string, unknown>>;
    expect((calls[0]?.function as Record<string, unknown>).name).toBe("badname");
    // The assistant turn carries no reasoning trace, so no `reasoning_content`
    // is invented. Writing `""` here claimed thinking-mode reasoning that was
    // never produced, and the upstream rejected the following turn with "the
    // reasoning content from the previous turn must be passed back in thinking
    // mode".
    expect(assistant).not.toHaveProperty("reasoning_content");
    expect(
      ((payload.tool_choice as Record<string, unknown>).function as Record<string, unknown>).name,
    ).toBe("badname");
  });
  test("restores declarations for historical tool calls when tools are omitted", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4.1-flash",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-git",
              type: "function",
              function: { name: "git", arguments: "{\"action\":\"diff\"}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-git", content: "diff output" },
      ],
    };

    workbuddyPrePayload(payload, request(), candidate());

    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "git",
          description: "Recovered from historical tool calls.",
          parameters: { type: "object", additionalProperties: true },
        },
      },
    ]);
  });


  test("adapter dispatches to /v2/chat/completions with desktop-client headers", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    let body: Record<string, unknown> = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseSse();
    }) as typeof fetch;
    const adapter = createWorkBuddyAdapter(fetcher);
    for await (const _event of adapter.dispatch(request(), candidate(), context())) {
      // Consume the canonical stream to exercise the full dispatch path.
    }
    expect(seenUrl).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(seenHeaders.get("authorization")).toBe("Bearer test-token");
    expect(seenHeaders.get("x-domain")).toBe("www.workbuddy.ai");
    expect(seenHeaders.get("x-no-enterprise-id")).toBe("1");
    expect(seenHeaders.get("x-codebuddy-request")).toBe("1");
    expect(seenHeaders.get("x-agent-purpose")).toBe("conversation");
    expect(seenHeaders.get("x-ide-name")).toBe("WorkBuddy");
    expect(seenHeaders.get("x-ide-type")).toBe("WorkBuddy");
    expect(seenHeaders.get("x-ide-version")).toBe(getWorkBuddyClientVersion());
    expect(seenHeaders.get("x-product")).toBe("WorkBuddy");
    expect(seenHeaders.get("x-user-id")).toBe("acct-1");
    expect(seenHeaders.get("x-machine-id")).toHaveLength(36);
    expect(seenHeaders.get("x-session-id")).toHaveLength(36);
    const clientVersion = getWorkBuddyClientVersion();
    expect(seenHeaders.get("user-agent")).toBe(
      `WorkBuddy/${clientVersion} WorkBuddy AI/${clientVersion} CLI/${getWorkBuddyCliVersion()}`,
    );
    expect(body.stream).toBe(true);
  });

  test("account-stable device headers are deterministic per account and distinct across accounts", async () => {
    const capture = async (accountId: string): Promise<Headers> => {
      let headers = new Headers();
      const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return responseSse();
      }) as unknown as typeof fetch;
      const adapter = createWorkBuddyAdapter(fetcher);
      for await (const _event of adapter.dispatch(request(), candidate(), context("api_key", accountId))) {
        // drain
      }
      return headers;
    };
    const a1 = await capture("acct-1");
    const a1again = await capture("acct-1");
    const a2 = await capture("acct-2");
    expect(a1.get("x-machine-id")).toBe(a1again.get("x-machine-id"));
    expect(a1.get("x-machine-id")).not.toBe(a2.get("x-machine-id"));
  });

  test("preserves stable x-conversation-id from inbound request headers", async () => {
    let headers = new Headers();
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return responseSse();
    }) as unknown as typeof fetch;
    const adapter = createWorkBuddyAdapter(fetcher);
    const dispatchCtx: ProviderDispatchContext = {
      ...context("oauth", "acct-wb"),
      request_headers: { "x-conversation-id": "wb-session-999" },
    };
    for await (const _event of adapter.dispatch(request(), candidate(), dispatchCtx)) {
      // drain
    }
    expect(headers.get("x-conversation-id")).toBe("wb-session-999");
    expect(headers.get("x-request-id")).toBeDefined();
  });
  test("uses Claude Code session identity for the upstream conversation id", async () => {
    let headers = new Headers();
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return responseSse();
    }) as unknown as typeof fetch;
    const adapter = createWorkBuddyAdapter(fetcher);
    const dispatchCtx: ProviderDispatchContext = {
      ...context("oauth", "acct-wb"),
      request_headers: { "x-claude-code-session-id": "claude-session-999" },
    };
    for await (const _event of adapter.dispatch(request(), candidate(), dispatchCtx)) {
      // drain
    }
    expect(headers.get("x-conversation-id")).toBe("claude-session-999");
  });

  test("catalog covers the WorkBuddy international model set", () => {
    expect(WORKBUDDY_MODELS.length).toBeGreaterThan(20);
    for (const id of ["glm-5.2", "kimi-k3", "deepseek-v4.1-flash", "gpt-6-astra"]) {
      expect(WORKBUDDY_MODELS.some((model) => model.modelId === id)).toBe(true);
    }
    const glm = WORKBUDDY_MODELS.find((model) => model.modelId === "glm-5.2");
    expect(glm?.contextLimit).toBe(1_000_000);
    expect(glm?.reasoning).toBe(true);
    // Every catalog row must carry the explicit `/v2/chat/completions`
    // endpoint: the base URL has no version segment, so the generic
    // `/chat/completions` default would 405 upstream.
    expect(WORKBUDDY_MODELS.every((model) => model.endpointPath === "/v2/chat/completions")).toBe(
      true,
    );
  });

  describe("OAuth device flow", () => {
    test("startDeviceAuth posts to the state endpoint and returns the auth URL", async () => {
      let seenUrl = "";
      let seenMethod = "";
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input);
        seenMethod = init?.method ?? "";
        return new Response(
          JSON.stringify({ code: 0, data: { state: "dev-1", authUrl: "https://workbuddy.ai/authorize" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const client = new BuddyOAuthClient(WORKBUDDY_OAUTH_VARIANT, fetcher);
      const started = await client.startDeviceAuth();
      expect(seenMethod).toBe("POST");
      expect(seenUrl).toContain("/v2/plugin/auth/state");
      expect(seenUrl).toContain("platform=CLI");
      expect(started.deviceAuthId).toBe("dev-1");
      expect(started.verificationUri).toBe("https://workbuddy.ai/authorize");
    });

    test("pollDeviceAuth reports pending then complete", async () => {
      let calls = 0;
      const fetcher = (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ code: 11217, msg: "login ing" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              accessToken: "access-token",
              refreshToken: "refresh-token",
              expiresIn: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const client = new BuddyOAuthClient(WORKBUDDY_OAUTH_VARIANT, fetcher);
      expect(await client.pollDeviceAuth("dev-1")).toEqual({ status: "pending" });
      const done = await client.pollDeviceAuth("dev-1");
      expect(done.status).toBe("complete");
    });

    test("refresh posts the refresh token header and returns a rotated access token", async () => {
      let seenHeaders = new Headers();
      const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ code: 0, data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      const client = new BuddyOAuthClient(WORKBUDDY_OAUTH_VARIANT, fetcher);
      const result = await client.refresh("old-refresh");
      expect(seenHeaders.get("x-refresh-token")).toBe("old-refresh");
      expect(result.access).toBe("new-access");
    });

    test("account label reads identity from the access JWT", () => {
      const payload = Buffer.from(
        JSON.stringify({ email: "user@example.com", given_name: "Jane", family_name: "Doe" }),
      ).toString("base64url");
      const token = `header.${payload}.sig`;
      expect(buddyAccountLabel(token)).toBe("Jane Doe <user@example.com>");
    });
  });

  describe("quota parsing", () => {
    test("fetchWorkBuddyQuota parses the Tencent billing envelope", async () => {
      const fetcher = (async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              Response: {
                Data: {
                  Accounts: [
                    {
                      PackageName: "WorkBuddy Pro",
                      CycleCapacityUsedPrecise: "50",
                      CycleCapacitySizePrecise: "100",
                      CycleStartTime: 1_700_000_000,
                      CycleEndTime: 1_700_086_400,
                      DeductionEndTime: 1_700_432_000,
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch;
      const result = await fetchWorkBuddyQuota("test-token", fetcher);
      expect(result.error).toBeNull();
      expect(result.plan).toBe("WorkBuddy Pro");
      expect(result.windows).toHaveLength(1);
      expect(result.windows[0]?.usedPercent).toBe(50);
    });

    test("fetchWorkBuddyQuota surfaces a missing credential without a network call", async () => {
      const fetcher = (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch;
      const result = await fetchWorkBuddyQuota("   ", fetcher);
      expect(result.error).toBe("WorkBuddy credential not available.");
    });
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { anthropicOAuthProvider } from "../../../src/upstream/providers/anthropic-oauth";
import { codexProvider } from "../../../src/upstream/providers/codex";
import type { ProviderRequest, ResolvedCredential } from "../../../src/upstream/providers";

const request: ProviderRequest = {
  surface: "openai-chat",
  body: { model: "gpt-5.4-mini", messages: [{ role: "user", content: "Hello" }], stream: false },
};

const signal = AbortSignal.timeout(1_000);

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe("OAuth provider transports", () => {
  test("sends Codex Responses requests with OAuth account identity", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const credential: ResolvedCredential = {
      kind: "oauth",
      value: "codex-access-token",
      accountId: "account-row-1",
      providerMetadata: { chatgptAccountId: "workspace-1" },
    };

    const target = await codexProvider.resolveTarget("gpt-5.4-mini");
    expect(target).toBeTruthy();
    const result = await codexProvider.call(target!, request, credential, signal);

    expect(result.type).toBe("stream");
    const captured = fetchSpy.mock.calls[0];
    expect(captured?.[0]).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(captured?.[1]?.headers).toMatchObject({
      authorization: "Bearer codex-access-token",
      "chatgpt-account-id": "workspace-1",
      originator: "pi",
    });
    expect(JSON.parse(String(captured?.[1]?.body))).toMatchObject({ model: "gpt-5.4-mini", input: [{ type: "message", role: "user", content: "Hello" }], store: false, stream: true });
  });

  test("sends Anthropic OAuth Messages requests with Claude Code headers", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "Claude says hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
    }));
    const credential: ResolvedCredential = { kind: "oauth", value: "anthropic-access-token" };
    const anthropicRequest: ProviderRequest = {
      surface: "openai-chat",
      body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "Hello" }], stream: false },
    };

    const target = await anthropicOAuthProvider.resolveTarget("claude-sonnet-5");
    expect(target).toBeTruthy();
    const result = await anthropicOAuthProvider.call(target!, anthropicRequest, credential, signal);

    expect(result.type).toBe("json");
    if (result.type !== "json") return;
    expect(result.body.choices).toEqual([{ index: 0, message: { role: "assistant", content: "Claude says hi" }, finish_reason: "stop" }]);
    const captured = fetchSpy.mock.calls[0];
    expect(captured?.[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(captured?.[1]?.headers).toMatchObject({
      authorization: "Bearer anthropic-access-token",
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    });
    expect(JSON.parse(String(captured?.[1]?.body))).toMatchObject({ model: "claude-sonnet-5", messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
  });
});

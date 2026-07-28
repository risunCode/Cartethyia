/**
 * Integration tests for POST /v1/messages — Anthropic-shape client.
 * Native path (claude model → Anthropic upstream, verbatim) and
 * cross-provider path (openai model → OpenAI Chat upstream, response
 * translated back to Anthropic Messages shape).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import type { AnthropicResponse, OpenAIChatResponse } from "../../src/translate/types";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postMessages(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/messages", () => {
  test("rejects an invalid body with a friendly Anthropic-shape validation error", async () => {
    const res = await postMessages({ model: "claude-3-5-sonnet-20241022" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toContain("expected API format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("claude model: forwards to Anthropic upstream and returns its response verbatim", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "hi there" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await postMessages(
      { model: "claude-3-5-sonnet-20241022", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": "sk-ant-test" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstreamBody);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.anthropic.com/v1/messages");
  });

  test("gpt model: translates to OpenAI Chat upstream and translates the response back to Messages shape", async () => {
    const upstreamBody: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234,
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await postMessages(
      { model: "gpt-4o-mini", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-test-openai" }
    );
    expect(res.status).toBe(200);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.openai.com/v1/chat/completions");

    const msgBody = (await res.json()) as AnthropicResponse;
    expect(msgBody.type).toBe("message");
    expect(msgBody.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(msgBody.stop_reason).toBe("end_turn");
  });

  test("upstream failure returns a friendly Anthropic envelope without leaking raw provider output", async () => {
    fetchSpy.mockResolvedValue(new Response("bad request: internal provider details", { status: 400 }));
    const res = await postMessages(
      { model: "claude-3-5-sonnet-20241022", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": "sk-ant-test" }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string; upstream_body?: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toContain("could not accept");
    expect(body.error.upstream_body).toBeUndefined();
  });
});

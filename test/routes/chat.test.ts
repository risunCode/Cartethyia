/**
 * Integration tests for POST /v1/chat/completions — drives the real Elysia
 * app through `app.handle()` (full lifecycle: schema validation, auth guard,
 * route handler) with `globalThis.fetch` mocked so no real upstream call is
 * made. Verifies both the passthrough path (OpenAI model → OpenAI upstream,
 * body forwarded/returned unmodified) and the cross-provider translation
 * path (Anthropic model → Anthropic upstream, response translated back to
 * OpenAI Chat shape).
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

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/chat/completions", () => {
  test("rejects an invalid body with a friendly OpenAI-shape validation error", async () => {
    const res = await postChat({ foo: "bar" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("expected API format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("openai model: forwards to OpenAI upstream and returns its response verbatim", async () => {
    const upstreamBody: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234,
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await postChat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer sk-test-openai" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstreamBody);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.openai.com/v1/chat/completions");
  });

  test("claude model: translates to Anthropic upstream request and translates the response back to Chat shape", async () => {
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

    const res = await postChat({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }] }, { "x-api-key": "sk-ant-test" });
    expect(res.status).toBe(200);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.anthropic.com/v1/messages");
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.model).toBe("claude-3-5-sonnet-20241022");

    const chatBody = (await res.json()) as OpenAIChatResponse;
    expect(chatBody.object).toBe("chat.completion");
    expect(chatBody.choices[0]!.message.content).toBe("hi there");
    expect(chatBody.choices[0]!.finish_reason).toBe("stop");
  });

  test("upstream 4xx keeps its status but returns a friendly actionable message without leaking the raw upstream body", async () => {
    fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));

    const res = await postChat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer sk-test-openai" });
    expect(res.status).toBe(429);
    const errorBody = (await res.json()) as { error: { type: string; message: string; upstream_body?: string } };
    expect(errorBody.error.type).toBe("rate_limit_error");
    expect(errorBody.error.message).toContain("rate-limiting");
    expect(errorBody.error.upstream_body).toBeUndefined();
  });

  test("claude model + tools: max_tokens is floored to 4096 when the client's default/small value would truncate a tool call", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    await postChat(
      {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "weather?" }],
        max_tokens: 16,
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
      },
      { "x-api-key": "sk-ant-test" }
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.max_tokens).toBe(4096);
  });

  test("claude model without tools: client's max_tokens is respected as-is, no floor applied", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    await postChat(
      { model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
      { "x-api-key": "sk-ant-test" }
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.max_tokens).toBe(16);
  });

  test("claude model: tool_choice 'none' is translated, not silently dropped", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    await postChat(
      {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
        tool_choice: "none",
      },
      { "x-api-key": "sk-ant-test" }
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.tool_choice).toEqual({ type: "none" });
  });

  test("claude model: response_format json_object is folded into the system prompt as a best-effort instruction", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    await postChat(
      {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "hi" }],
        response_format: { type: "json_object" },
      },
      { "x-api-key": "sk-ant-test" }
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.system).toContain("You are terse.");
    expect(sentBody.system).toContain("valid JSON");
  });

  test("claude model: response_format json_schema embeds the schema verbatim and produces a distinct instruction from json_object", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
    await postChat(
      {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_schema", json_schema: { name: "weather", schema } },
      },
      { "x-api-key": "sk-ant-test" }
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.system).toContain(JSON.stringify(schema, null, 2));
    expect(sentBody.system).not.toContain("Respond ONLY with a JSON object, no other text.");
  });

  test("claude model: a tool_call left unanswered by history is auto-repaired instead of letting Anthropic 400", async () => {
    const upstreamBody: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    await postChat(
      {
        model: "claude-3-5-sonnet-20241022",
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
          { role: "user", content: "and tomorrow?" },
        ],
      },
      { "x-api-key": "sk-ant-test" }
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String((init as RequestInit).body));
    // find the synthesized tool_result message inserted right after the tool_use turn
    const messages: { role: string; content: unknown }[] = sentBody.messages;
    const toolUseIndex = messages.findIndex((m) => Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === "tool_use"));
    expect(toolUseIndex).toBeGreaterThanOrEqual(0);
    const following = messages[toolUseIndex + 1]!;
    expect(Array.isArray(following.content)).toBe(true);
    const toolResultBlock = (following.content as { type: string; tool_use_id?: string }[]).find((b) => b.type === "tool_result");
    expect(toolResultBlock?.tool_use_id).toBe("call_1");
  });
});

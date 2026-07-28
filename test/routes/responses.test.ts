/**
 * Integration tests for POST /v1/responses — OpenAI Responses-shape client.
 * Native path (gpt model → Responses upstream, verbatim) and cross-provider
 * path (claude model → Anthropic Messages upstream via Chat as the
 * intermediate, response translated back to Responses shape).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import type { AnthropicResponse, OpenAIResponsesResponse } from "../../src/translate/types";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postResponses(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/responses", () => {
  test("rejects an invalid body with a friendly OpenAI-shape validation error", async () => {
    const res = await postResponses({ model: "gpt-4o-mini" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("expected API format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("gpt model: forwards to OpenAI Responses upstream and returns its response verbatim", async () => {
    const upstreamBody: OpenAIResponsesResponse = {
      id: "resp_1",
      object: "response",
      created_at: 1234,
      model: "gpt-4o-mini",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(upstreamBody), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await postResponses({ model: "gpt-4o-mini", input: "hi" }, { authorization: "Bearer sk-test-openai" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstreamBody);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.openai.com/v1/responses");
  });

  test("claude model: translates through Chat to Anthropic upstream and back to Responses shape", async () => {
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

    const res = await postResponses({ model: "claude-3-5-sonnet-20241022", input: "hi" }, { "x-api-key": "sk-ant-test" });
    expect(res.status).toBe(200);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.anthropic.com/v1/messages");

    const respBody = (await res.json()) as OpenAIResponsesResponse;
    expect(respBody.status).toBe("completed");
    expect(respBody.output[0]).toMatchObject({ type: "message", role: "assistant" });
  });

  test("upstream failure returns a friendly OpenAI envelope without raw provider output", async () => {
    fetchSpy.mockResolvedValue(new Response("server error: internal provider details", { status: 500 }));
    const res = await postResponses({ model: "gpt-4o-mini", input: "hi" }, { authorization: "Bearer sk-test-openai" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { type: string; message: string; upstream_body?: string } };
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.message).toContain("having trouble");
    expect(body.error.upstream_body).toBeUndefined();
  });
});

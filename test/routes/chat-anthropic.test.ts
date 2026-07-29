/**
 * Tests for POST /v1/chat/completions with the anthropic namespace (REQ:
 * built-in API-key providers). Translates the OpenAI Chat-shaped body to
 * Anthropic's native Messages shape before forwarding, and back on the way
 * out.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postChat(body: unknown, apiKey = "sk-ant-test") {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
  );
}

function anthropicMessageResponse(text: string) {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("POST /v1/chat/completions with anthropic namespace", () => {
  test("translates to native Messages shape, forwards to api.anthropic.com, and translates the response back", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicMessageResponse("hello from claude"));

    const res = await postChat({ model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from claude");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const sentBody = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string }> };
    expect(sentBody.model).toBe("claude-opus-5");
    expect(sentBody.messages[0]!.role).toBe("user");
  });

  test("routes an uncatalogued model id too", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicMessageResponse("ok"));

    const res = await postChat({ model: "anthropic/claude-future-6", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body)) as { model: string };
    expect(sentBody.model).toBe("claude-future-6");
  });
});

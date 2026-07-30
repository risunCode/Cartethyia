/**
 * Tests for POST /v1/chat/completions with the pmimo namespace (Xiaomi MiMo
 * pay-as-you-go, provider id `pgxiaomi`, REQ: built-in API-key providers).
 * Distinct from the no-auth `mimo` (Free) namespace and from the Token Plan
 * tier (`tpxiaomi`, `mimosgtp` prefix) — this is a curated-catalog,
 * bearer-auth OpenAI-compatible passthrough.
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

function postChat(body: unknown) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pgxiaomi-test-key" },
      body: JSON.stringify(body),
    })
  );
}

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "mimo-payg-1",
      object: "chat.completion",
      created: 1234,
      model: "mimo-v2.5-pro",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("POST /v1/chat/completions with pmimo namespace (pgxiaomi provider)", () => {
  test("routes a catalog model to api.xiaomimimo.com/v1 with the bearer credential", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("hello from mimo payg"));

    const res = await postChat({ model: "pmimo/mimo-v2.5-pro", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from mimo payg");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer pgxiaomi-test-key");
  });

  test("rejects a model id outside the curated catalog, unlike openai/anthropic, pgxiaomi has a fixed model list", async () => {
    const res = await postChat({ model: "pmimo/not-a-real-model", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

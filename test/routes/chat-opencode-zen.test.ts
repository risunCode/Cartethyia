/**
 * Tests for POST /v1/chat/completions with the opencode-zen namespace.
 * OpenCode Zen shares OpenCode Free's catalog/base URL but requires a real,
 * billed API key instead of the free tier's shared public credential.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { resetOpenCodeZenCatalogForTests } from "../../src/upstream/providers/opencode-zen";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  resetOpenCodeZenCatalogForTests();
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

function catalogResponse() {
  return new Response(
    JSON.stringify({ data: [{ id: "deepseek-v4-flash-free", object: "model", created: 1234, owned_by: "opencode" }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("POST /v1/chat/completions with opencode-zen namespace", () => {
  test("routes with the caller's bearer credential, not the free tier's shared public token", async () => {
    fetchSpy
      .mockResolvedValueOnce(catalogResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "oc-zen-1",
            object: "chat.completion",
            created: 1234,
            model: "deepseek-v4-flash-free",
            choices: [{ index: 0, message: { role: "assistant", content: "hello from opencode zen" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const res = await postChat(
      { model: "opencodezen/deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer zen-secret-key" }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from opencode zen");

    const [, init] = fetchSpy.mock.calls[1]!;
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe("Bearer zen-secret-key");
    expect(sentHeaders["x-opencode-client"]).toBe("desktop");
  });

  test("rejects a request with no credential", async () => {
    fetchSpy.mockResolvedValueOnce(catalogResponse());

    const res = await postChat({ model: "opencodezen/deepseek-v4-flash-free", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(401);
  });
});

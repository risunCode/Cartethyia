/**
 * Tests for POST /v1/chat/completions with the opencode-free namespace.
 * OpenCode Free is always accessible regardless of the opencodeFreeAccess
 * setting — the access gate was removed.
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

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/chat/completions with opencode-free namespace", () => {
  test("routes an opencode-free chat request regardless of access setting", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "deepseek-v4-flash-free", object: "model", created: 1234, owned_by: "opencode" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "oc-1",
            object: "chat.completion",
            created: 1234,
            model: "deepseek-v4-flash-free",
            choices: [{ index: 0, message: { role: "assistant", content: "hello from opencode" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const res = await postChat({
      model: "foc/deepseek-v4-flash-free",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from opencode");
    const [, init] = fetchSpy.mock.calls[1]!;
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe("Bearer public");
    expect(sentHeaders["x-opencode-client"]).toBe("desktop");
    expect(sentHeaders.accept).toBe("text/event-stream");
  });
});

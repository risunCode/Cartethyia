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

describe("POST /v1/chat/completions with commandcode namespace", () => {
  test("rejects a commandcode request without a bearer credential", async () => {
    const res = await postChat({ model: "cmd/moonshotai/Kimi-K2.6", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  test("routes a commandcode non-stream request and materializes a Chat response", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        [
          '{"type":"text-delta","text":"hello"}',
          '{"type":"text-delta","text":" from commandcode"}',
          '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":3,"outputTokens":4}}',
          '{"type":"finish","finishReason":"stop"}',
        ].join("\n"),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const res = await postChat(
      { model: "cmd/moonshotai/Kimi-K2.6", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer user_test_key" }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }]; object: string };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hello from commandcode");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("api.commandcode.ai/alpha/generate");
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders["x-command-code-version"]).toBe("1.4.4");
    expect(sentHeaders["x-cli-environment"]).toBe("cli");
    expect(sentHeaders["x-session-id"]).toBeDefined();
    expect(sentHeaders["authorization"]).toBe("Bearer user_test_key");
    expect(sentHeaders["user-agent"]).toBeUndefined();
    expect(sentHeaders["x-cartethyia-version"]).toBeUndefined();
  });

  test("routes a commandcode stream request and emits SSE chunks", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        [
          '{"type":"text-delta","text":"streamed"}',
          '{"type":"finish","finishReason":"stop"}',
        ].join("\n"),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const res = await postChat(
      { model: "cmd/moonshotai/Kimi-K2.6", messages: [{ role: "user", content: "hi" }], stream: true },
      { authorization: "Bearer user_test_key" }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("streamed");
    expect(text).toContain("[DONE]");
  });

  test("returns a friendly error when the Command Code upstream fails", async () => {
    fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));

    const res = await postChat(
      { model: "cmd/moonshotai/Kimi-K2.6", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer user_test_key" }
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string; message: string; upstream_body?: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.upstream_body).toBeUndefined();
  });
});

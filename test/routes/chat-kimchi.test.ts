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

describe("POST /v1/chat/completions with kimchi namespace", () => {
  test("rejects a kimchi request without a bearer credential", async () => {
    const res = await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  test("routes a kimchi non-stream request to its OpenAI-compatible endpoint", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "kimchi-1",
          object: "chat.completion",
          created: 1234,
          model: "kimi-k2.7",
          choices: [{ index: 0, message: { role: "assistant", content: "hi from kimchi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const res = await postChat(
      { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer kimchi_test_key" }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hi from kimchi");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("llm.kimchi.dev/openai/v1/chat/completions");
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.model).toBe("kimi-k2.7");
    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.accept).toBe("text/event-stream,application/json");
    expect(sentHeaders["user-agent"]).toBe("kimchi/0.1.75");
  });

  test("routes a kimchi stream request and emits SSE chunks", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        [
          'data: {"id":"k1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.7","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
          '',
          'data: {"id":"k1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.7","choices":[{"index":0,"delta":{"content":"kimchi stream"},"finish_reason":null}]}',
          '',
          'data: [DONE]',
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );

    const res = await postChat(
      { model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }], stream: true },
      { authorization: "Bearer kimchi_test_key" }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("kimchi stream");
    expect(text).toContain("[DONE]");
  });
});

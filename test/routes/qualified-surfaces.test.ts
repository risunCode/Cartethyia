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

function kimchiChatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "kimchi-1",
      object: "chat.completion",
      created: 1234,
      model: "kimi-k2.7",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("qualified provider routing across API surfaces", () => {
  test("routes Anthropic Messages requests through the qualified provider dispatcher", async () => {
    fetchSpy.mockResolvedValueOnce(kimchiChatResponse("hi from kimchi"));

    const res = await app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({
          model: "kimchi/kimi-k2.7",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: Array<{ type: string; text: string }> };
    expect(body.type).toBe("message");
    expect(body.content[0]?.text).toBe("hi from kimchi");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("llm.kimchi.dev/openai/v1/chat/completions");
  });

  test("routes OpenAI Responses requests through the qualified provider dispatcher", async () => {
    fetchSpy.mockResolvedValueOnce(kimchiChatResponse("hi from kimchi"));

    const res = await app.handle(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer kimchi_test_key" },
        body: JSON.stringify({ model: "kimchi/kimi-k2.7", input: "hi" }),
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; output: Array<{ type: string; content?: Array<{ text?: string }> }> };
    expect(body.status).toBe("completed");
    expect(body.output[0]?.content?.[0]?.text).toBe("hi from kimchi");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("llm.kimchi.dev/openai/v1/chat/completions");
  });

  test("returns provider-shaped authentication errors on non-chat surfaces", async () => {
    const messagesRes = await app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimchi/kimi-k2.7",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    expect(messagesRes.status).toBe(401);
    const messagesBody = (await messagesRes.json()) as { type: string; error: { type: string } };
    expect(messagesBody.type).toBe("error");
    expect(messagesBody.error.type).toBe("authentication_error");

    const responsesRes = await app.handle(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimchi/kimi-k2.7", input: "hi" }),
      })
    );
    expect(responsesRes.status).toBe(401);
    const responsesBody = (await responsesRes.json()) as { error: { type: string } };
    expect(responsesBody.error.type).toBe("authentication_error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

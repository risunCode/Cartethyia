/**
 * Tests for POST /v1/chat/completions with the openai namespace (REQ: built-in
 * API-key providers). BYOK header-based credential, near-direct forward to
 * api.openai.com, permissive model ids (any model routes, not just the
 * curated catalog).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { createAccount } from "../../src/console/db/repos/accounts";
import { useIsolatedDataDir } from "../console/helpers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function postChat(body: unknown, authorization = "Bearer sk-test-openai") {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
    })
  );
}

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "cmpl-1",
      object: "chat.completion",
      created: 1234,
      model: "gpt-5.6-sol",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("POST /v1/chat/completions with openai namespace", () => {
  test("routes a curated-catalog model to api.openai.com with the bearer credential", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("hello from openai"));

    const res = await postChat({ model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from openai");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-openai");
    const sentBody = JSON.parse(String(init?.body)) as { model: string };
    expect(sentBody.model).toBe("gpt-5.6-sol");
  });

  test("fails over to the next stored account after a 401", async () => {
    createAccount({ provider: "openai", name: "first", credentialKind: "bearer", credential: "sk-first", priority: 1 });
    createAccount({ provider: "openai", name: "second", credentialKind: "bearer", credential: "sk-second", priority: 2 });
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }));
    fetchSpy.mockResolvedValueOnce(chatResponse("retried with second account"));

    const res = await postChat({ model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }, "");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[0]![1]?.headers as Record<string, string>).authorization).toBe("Bearer sk-first");
    expect((fetchSpy.mock.calls[1]![1]?.headers as Record<string, string>).authorization).toBe("Bearer sk-second");
  });

  test("locks a repeatedly failing account only for that model", async () => {
    createAccount({ provider: "openai", name: "model-lock", credentialKind: "bearer", credential: "sk-lock", priority: 1 });
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 500 }));

    for (let attempt = 0; attempt < 3; attempt++) {
      const failed = await postChat({ model: "openai/locked-model", messages: [{ role: "user", content: "hi" }] }, "");
      expect(failed.status).toBe(500);
    }

    const locked = await postChat({ model: "openai/locked-model", messages: [{ role: "user", content: "hi" }] }, "");
    expect(locked.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    fetchSpy.mockResolvedValueOnce(chatResponse("available for another model"));
    const otherModel = await postChat({ model: "openai/other-model", messages: [{ role: "user", content: "hi" }] }, "");
    expect(otherModel.status).toBe(200);
  });

  test("does not retry once an upstream stream has yielded bytes", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
        controller.error(new Error("upstream disconnected"));
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const response = await postChat({ model: "openai/gpt-5.6-sol", stream: true, messages: [{ role: "user", content: "hi" }] });
    await response.text();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("routes an uncatalogued model id too — openai accepts any model, no static allowlist", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await postChat({ model: "openai/some-brand-new-model-2099", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body)) as { model: string };
    expect(sentBody.model).toBe("some-brand-new-model-2099");
  });

  test("retries an image request as text when the provider rejects image input", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "images are not supported" } }), { status: 400 }))
      .mockResolvedValueOnce(chatResponse("I cannot read images with this model."));

    const res = await postChat({
      model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: [{ type: "text", text: "What is in this screenshot?" }, { type: "image_url", image_url: { url: "https://example.com/screenshot.png" } }] }],
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchSpy.mock.calls[1]!;
    const retryBody = JSON.parse(String(retryInit?.body)) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    const userMessage = retryBody.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toEqual([
      { type: "text", text: "What is in this screenshot?" },
      { type: "text", text: "[Image attachment omitted: the selected model cannot process image input. Respond using the available text only.]" },
    ]);
  });

  test("rejects a request with no credential", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }),
      })
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

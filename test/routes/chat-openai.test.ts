/**
 * Tests for POST /v1/chat/completions with the openai namespace (REQ: built-in
 * API-key providers). BYOK header-based credential, near-direct forward to
 * api.openai.com, permissive model ids (any model routes, not just the
 * curated catalog).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "../console/helpers";

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

  test("routes an uncatalogued model id too — openai accepts any model, no static allowlist", async () => {
    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await postChat({ model: "openai/some-brand-new-model-2099", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body)) as { model: string };
    expect(sentBody.model).toBe("some-brand-new-model-2099");
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

  test("a console-configured system prompt is injected exactly once, not doubled", async () => {
    // Regression: dispatchQualifiedRoute already runs prepareOutboundRequest
    // once, centrally, before provider.call() — the openai/anthropic/xmimo/
    // openai-compatible providers used to re-run it themselves, doubling the
    // injected system prompt (and, more generally, double-applying RTK
    // compression and filter rules) for every qualified request.
    const cookie = await loginAndGetCookie();
    const patchRes = await app.handle(postJson("/console/api/settings", { systemPrompt: "ALWAYS SIGN OFF WITH A FLOWER" }, { cookie }));
    expect(patchRes.status).toBe(200);

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));

    const res = await postChat({ model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);

    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const systemMessages = sentBody.messages.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]!.content).toBe("ALWAYS SIGN OFF WITH A FLOWER");
  });
});

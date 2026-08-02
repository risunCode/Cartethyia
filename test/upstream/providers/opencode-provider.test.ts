/**
 * Unit tests for the OpenCode provider factory (opencode-provider.ts) —
 * validates the credential guard, authorizationHeader callback, and that
 * Free and Zen produce correctly-shaped requests.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../../src/app";
import { resetOpenCodeCatalogForTests } from "../../../src/upstream/providers/opencode-catalog";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  resetOpenCodeCatalogForTests();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function catalog() {
  return new Response(
    JSON.stringify({
      data: [
        { id: "test-model", object: "model", created: 1234, owned_by: "opencode" },
        { id: "deepseek-v4-flash-free", object: "model", created: 1234, owned_by: "opencode" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function completion() {
  return new Response(
    JSON.stringify({
      id: "c1", object: "chat.completion", created: 1234, model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function postChat(model: string, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }),
  );
}

describe("OpenCode Free — authorizationHeader is always 'Bearer public'", () => {
  test("sends Bearer public regardless of request headers", async () => {
    fetchSpy.mockResolvedValueOnce(catalog()).mockResolvedValueOnce(completion());
    await postChat("foc/test-model");
    const [, init] = fetchSpy.mock.calls[1]!;
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      authorization: "Bearer public",
    });
  });

  test("always sends x-opencode-client: desktop", async () => {
    fetchSpy.mockResolvedValueOnce(catalog()).mockResolvedValueOnce(completion());
    await postChat("foc/test-model");
    const [, init] = fetchSpy.mock.calls[1]!;
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      "x-opencode-client": "desktop",
    });
  });
});

// OpenCode Zen (unlike Free) is subject to routing's static-catalog existence
// check (src/routing/resolve.ts) before the provider's own dynamic
// resolveTarget ever runs, so these tests must use a model id present in
// Zen's static catalog (opencode-zen.ts) rather than an arbitrary id.
const ZEN_STATIC_MODEL = "deepseek-v4-flash-free";

describe("OpenCode Zen — validateCredential rejects missing key", () => {
  test("returns 401 when no Authorization header is provided", async () => {
    fetchSpy.mockResolvedValueOnce(catalog());
    const res = await postChat(`opencodezen/${ZEN_STATIC_MODEL}`);
    expect(res.status).toBe(401);
  });

  test("returns 401 when Authorization is empty string", async () => {
    fetchSpy.mockResolvedValueOnce(catalog());
    const res = await postChat(`opencodezen/${ZEN_STATIC_MODEL}`, { authorization: "" });
    expect(res.status).toBe(401);
  });
});

describe("OpenCode Zen — authorizationHeader forwards caller's bearer key", () => {
  test("sends the caller's bearer token to upstream", async () => {
    fetchSpy.mockResolvedValueOnce(catalog()).mockResolvedValueOnce(completion());
    await postChat(`opencodezen/${ZEN_STATIC_MODEL}`, { authorization: "Bearer caller-secret" });
    const [, init] = fetchSpy.mock.calls[1]!;
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      authorization: "Bearer caller-secret",
    });
  });
});

describe("OpenCode provider — model not in catalog returns 4xx", () => {
  test("returns an error status when model is not in the live catalog", async () => {
    fetchSpy.mockResolvedValueOnce(catalog());
    const res = await postChat("foc/does-not-exist-model");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

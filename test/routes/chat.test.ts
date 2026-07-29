/**
 * Integration tests for POST /v1/chat/completions — drives the real Elysia
 * app through `app.handle()` (full lifecycle: schema validation, auth guard,
 * route handler) with `globalThis.fetch` mocked so no real upstream call is
 * made. Verifies the provider-qualified routing path and the rejection of
 * bare (unqualified) model names.
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

describe("POST /v1/chat/completions", () => {
  test("rejects an invalid body with a friendly OpenAI-shape validation error", async () => {
    const res = await postChat({ foo: "bar" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("expected API format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("bare model name (no prefix) is rejected with 400", async () => {
    const res = await postChat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("bare claude model name (no prefix) is rejected with 400", async () => {
    const res = await postChat({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("qualified model with no stored credential returns 401", async () => {
    // kimchi/kimi-k2.7 resolves to the Kimchi provider which requires a stored
    // credential. Without one the request is rejected before upstream.
    const res = await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("bearer");
  });

  test("unregistered provider prefix returns 400", async () => {
    const res = await postChat({ model: "xx/some-model", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

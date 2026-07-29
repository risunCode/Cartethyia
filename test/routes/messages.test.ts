/**
 * Integration tests for POST /v1/messages — Anthropic-shape client.
 * Verifies provider-qualified routing and rejection of bare model names.
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

function postMessages(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/messages", () => {
  test("rejects an invalid body with a friendly Anthropic-shape validation error", async () => {
    const res = await postMessages({ model: "claude-3-5-sonnet-20241022" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.message).toContain("expected API format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("bare claude model name (no prefix) is rejected with 400", async () => {
    const res = await postMessages(
      { model: "claude-3-5-sonnet-20241022", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": "sk-ant-test" }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("bare gpt model name (no prefix) is rejected with 400", async () => {
    const res = await postMessages(
      { model: "gpt-4o-mini", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { authorization: "Bearer sk-test-openai" }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("unknown model returns 400", async () => {
    const res = await postMessages(
      { model: "unknown-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": "sk-ant-test" }
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

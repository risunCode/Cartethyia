/**
 * Integration tests for POST /v1/responses — OpenAI Responses-shape client.
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

function postResponses(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/responses", () => {
  test("rejects an invalid body with a friendly OpenAI-shape validation error", async () => {
    const res = await postResponses({ model: "gpt-4o-mini" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("expected API format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("bare model name (no prefix) is rejected with 400", async () => {
    const res = await postResponses({ model: "gpt-4o-mini", input: "hi" }, { authorization: "Bearer sk-test-openai" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("bare claude model name (no prefix) is rejected with 400", async () => {
    const res = await postResponses({ model: "claude-3-5-sonnet-20241022", input: "hi" }, { "x-api-key": "sk-ant-test" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("provider prefix");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

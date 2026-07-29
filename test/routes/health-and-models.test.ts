/**
 * Integration tests for GET /health and GET /v1/models.
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

describe("GET /", () => {
  test("redirects visitors into the authenticated console", async () => {
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console/");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /health", () => {
  test("returns ok without ever calling fetch", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "cartethyia" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /v1/models", () => {
  test("merges OpenAI and Anthropic model lists into one OpenAI-shape envelope", async () => {
    fetchSpy.mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("api.openai.com")) {
        return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet-20241022", type: "model" }] }), { status: 200 });
    }) as typeof fetch);

    const res = await app.handle(
      new Request("http://localhost/v1/models", { headers: { authorization: "Bearer sk-test-openai", "x-api-key": "sk-ant-test" } })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: { id: string; object: string; owned_by: string }[] };
    expect(body.object).toBe("list");
    expect(body.data).toContainEqual({ id: "gpt-4o-mini", object: "model", owned_by: "openai" });
    expect(body.data).toContainEqual({ id: "claude-3-5-sonnet-20241022", object: "model", owned_by: "anthropic" });
  });

  test("a failing provider is skipped rather than failing the whole request", async () => {
    fetchSpy.mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("api.openai.com")) throw new Error("network down");
      return new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet-20241022" }] }), { status: 200 });
    }) as typeof fetch);

    const res = await app.handle(
      new Request("http://localhost/v1/models", { headers: { authorization: "Bearer sk-test-openai", "x-api-key": "sk-ant-test" } })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe("claude-3-5-sonnet-20241022");
  });
});

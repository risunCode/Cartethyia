/**
 * Custom provider "Check" validation (REQ-8) — models-only discovery via
 * `GET {baseUrl}/models`. There is no model-ID / chat-completion fallback:
 * the console never asks for a model ID, it discovers them.
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

describe("POST /console/api/custom-providers/validate", () => {
  test("succeeds via /models and reports the discovered model count", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const res = await app.handle(
      postJson("/console/api/custom-providers/validate", { type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "sk-test" }, { cookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; models: Array<{ id: string; capabilities: string[] }> };
    expect(body.ok).toBe(true);
    // Neither id matches a known catalog model, so both fall back to the plain text+streaming placeholder.
    expect(body.models).toEqual([
      { id: "gpt-4o", capabilities: ["text", "streaming"] },
      { id: "gpt-4o-mini", capabilities: ["text", "streaming"] },
    ]);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.com/v1/models");
  });

  test("reports unauthorized on 401 from /models", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const res = await app.handle(
      postJson("/console/api/custom-providers/validate", { type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "bad-key" }, { cookie }),
    );
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("API key unauthorized");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("reports a helpful error when /models 404s, with no fallback attempt", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const res = await app.handle(
      postJson("/console/api/custom-providers/validate", { type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "sk-test" }, { cookie }),
    );
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("/models endpoint not found");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("passes a timed-out fetch failure through as a readable error", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockRejectedValueOnce(new DOMException("The operation was aborted.", "TimeoutError"));

    const res = await app.handle(
      postJson("/console/api/custom-providers/validate", { type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "sk-test", timeoutSeconds: 1 }, { cookie }),
    );
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Timed out after 1s");
  });

  test("anthropic-compatible sends x-api-key and anthropic-version headers, normalizing a trailing /messages base URL", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "claude-3-opus" }] }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await app.handle(
      postJson("/console/api/custom-providers/validate", { type: "anthropic-compatible", baseUrl: "https://api.anthropic.com/v1/messages", credential: "sk-ant-test" }, { cookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/models");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("POST /console/api/custom-providers with autoFetchModels", () => {
  test("discovers and persists models when autoFetchModels is true", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "llama-3" }] }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await app.handle(
      postJson(
        "/console/api/custom-providers",
        { name: "Auto Fetch", type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "sk-test", slug: "auto-fetch", autoFetchModels: true, timeoutSeconds: 10 },
        { cookie },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { models: Array<{ id: string; capabilities: string[] }>; timeoutSeconds: number };
    expect(body.models).toEqual([{ id: "llama-3", capabilities: ["text", "streaming"] }]);
    expect(body.timeoutSeconds).toBe(10);
  });

  test("creation still succeeds when the auto-fetch fails — models is just empty", async () => {
    const cookie = await loginAndGetCookie();
    fetchSpy.mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const res = await app.handle(
      postJson(
        "/console/api/custom-providers",
        { name: "Fetch Fails", type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "sk-test", slug: "fetch-fails", autoFetchModels: true },
        { cookie },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { models: string[] };
    expect(body.models).toEqual([]);
  });

  test("skips the fetch entirely when autoFetchModels is false", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      postJson(
        "/console/api/custom-providers",
        { name: "No Fetch", type: "openai-compatible", baseUrl: "https://api.example.com/v1", credential: "sk-test", slug: "no-fetch" },
        { cookie },
      ),
    );
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Custom provider detail page's API surface (REQ-8) — GET one, update
 * (name/baseUrl/timeout/credential rotation), and re-running model
 * discovery for an already-created provider.
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

async function createProvider(cookie: string) {
  const res = await app.handle(
    postJson(
      "/console/api/custom-providers",
      { name: "vLLM Box", type: "openai-compatible", baseUrl: "https://vllm.example.com/v1", credential: "sk-original" },
      { cookie }
    )
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string; credentialHint: string };
}

describe("GET /console/api/custom-providers/:id", () => {
  test("returns the record with a masked credential hint, never the ciphertext", async () => {
    const cookie = await loginAndGetCookie();
    const created = await createProvider(cookie);

    const res = await app.handle(new Request(`http://localhost/console/api/custom-providers/${created.id}`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; credentialEnc?: string; credentialHint: string };
    expect(body.name).toBe("vLLM Box");
    expect(body.credentialEnc).toBeUndefined();
    expect(body.credentialHint).toBeTruthy();
  });

  test("404s for an unknown id", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(new Request("http://localhost/console/api/custom-providers/does-not-exist", { headers: { cookie } }));
    expect(res.status).toBe(404);
  });
});

describe("POST /console/api/custom-providers/:id (update)", () => {
  test("updates name/baseUrl/timeout without touching the credential when it is omitted", async () => {
    const cookie = await loginAndGetCookie();
    const created = await createProvider(cookie);

    const res = await app.handle(postJson(`/console/api/custom-providers/${created.id}`, { name: "vLLM Box Renamed", timeoutSeconds: 45 }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; timeoutSeconds: number; credentialHint: string };
    expect(body.name).toBe("vLLM Box Renamed");
    expect(body.timeoutSeconds).toBe(45);
    // Credential untouched — same masked hint as before the update.
    expect(body.credentialHint).toBe(created.credentialHint);
  });

  test("rotates the credential when a new one is supplied", async () => {
    const cookie = await loginAndGetCookie();
    const created = await createProvider(cookie);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await app.handle(postJson(`/console/api/custom-providers/${created.id}`, { credential: "sk-rotated-different-suffix" }, { cookie }));

    // Prove the new credential is what actually gets sent upstream, not the old one.
    await app.handle(postJson(`/console/api/custom-providers/${created.id}/models/fetch`, {}, { cookie }));
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-rotated-different-suffix");
  });

  test("404s for an unknown id", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/custom-providers/does-not-exist", { name: "x" }, { cookie }));
    expect(res.status).toBe(404);
  });
});

describe("POST /console/api/custom-providers/:id/models/fetch", () => {
  test("re-discovers models using the stored credential and persists the result", async () => {
    const cookie = await loginAndGetCookie();
    const created = await createProvider(cookie);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "llama-3.1-70b" }, { id: "qwen2.5-32b" }] }), { status: 200, headers: { "content-type": "application/json" } })
    );

    const res = await app.handle(postJson(`/console/api/custom-providers/${created.id}/models/fetch`, {}, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; models: Array<{ id: string }> };
    expect(body.ok).toBe(true);
    expect(body.models.map((m) => m.id)).toEqual(["llama-3.1-70b", "qwen2.5-32b"]);

    const detailRes = await app.handle(new Request(`http://localhost/console/api/custom-providers/${created.id}`, { headers: { cookie } }));
    const detail = (await detailRes.json()) as { models: Array<{ id: string }> };
    expect(detail.models.map((m) => m.id)).toEqual(["llama-3.1-70b", "qwen2.5-32b"]);
  });

  test("a failed fetch does not clobber the previously discovered models", async () => {
    const cookie = await loginAndGetCookie();
    const created = await createProvider(cookie);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "seed-model" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await app.handle(postJson(`/console/api/custom-providers/${created.id}/models/fetch`, {}, { cookie }));

    fetchSpy.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const failRes = await app.handle(postJson(`/console/api/custom-providers/${created.id}/models/fetch`, {}, { cookie }));
    expect((await failRes.json() as { ok: boolean }).ok).toBe(false);

    const detailRes = await app.handle(new Request(`http://localhost/console/api/custom-providers/${created.id}`, { headers: { cookie } }));
    const detail = (await detailRes.json()) as { models: Array<{ id: string }> };
    expect(detail.models.map((m) => m.id)).toEqual(["seed-model"]);
  });

  test("404s for an unknown id", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/custom-providers/does-not-exist/models/fetch", {}, { cookie }));
    expect(res.status).toBe(404);
  });
});

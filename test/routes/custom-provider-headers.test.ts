/**
 * Custom provider extra headers (REQ-8 follow-up) — operator-configured
 * headers are sent with every outbound request (discovery, dispatch, and
 * test) and win over the provider's own built-in headers on a name
 * collision, since the whole point is overriding something the built-in
 * set gets wrong (e.g. a required org/routing/WAF-bypass header).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "../console/helpers";

let fetchSpy: Mock<typeof fetch>;
let dnsLookupSpy: ReturnType<typeof spyOn<typeof Bun.dns, "lookup">>;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
  dnsLookupSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4, ttl: 0 }]);
});

afterEach(() => {
  dnsLookupSpy.mockRestore();
  fetchSpy.mockRestore();
});

function chatResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "custom-1",
      object: "chat.completion",
      created: 1234,
      model: "m1",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("custom provider custom headers", () => {
  test("a custom header is sent on dispatch and overrides the built-in header on collision", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson(
        "/console/api/custom-providers",
        {
          name: "Header Test",
          type: "openai-compatible",
          baseUrl: "https://headers.example.com/v1",
          credential: "sk-secret",
          customHeaders: { "X-Org-Id": "org-42", authorization: "Bearer overridden-by-custom-header" },
        },
        { cookie }
      )
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { slug: string; customHeaders: Record<string, string> };
    expect(created.customHeaders).toEqual({ "X-Org-Id": "org-42", authorization: "Bearer overridden-by-custom-header" });

    fetchSpy.mockResolvedValueOnce(chatResponse("ok"));
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${created.slug}/m1`, messages: [{ role: "user", content: "hi" }] }),
      })
    );
    expect(res.status).toBe(200);

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Org-Id"]).toBe("org-42");
    // Custom header wins over the provider's own built-in authorization header.
    expect(headers.authorization).toBe("Bearer overridden-by-custom-header");
  });

  test("headers persist across an update that changes other fields", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "Persist Test", type: "openai-compatible", baseUrl: "https://p.example.com/v1", credential: "x", customHeaders: { "X-Keep": "me" } }, { cookie })
    );
    const created = (await createRes.json()) as { id: string };

    const updateRes = await app.handle(postJson(`/console/api/custom-providers/${created.id}`, { timeoutSeconds: 60 }, { cookie }));
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { customHeaders: Record<string, string>; timeoutSeconds: number };
    expect(updated.timeoutSeconds).toBe(60);
    expect(updated.customHeaders).toEqual({ "X-Keep": "me" });
  });

  test("an explicit header update replaces the set wholesale", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "Replace Test", type: "openai-compatible", baseUrl: "https://r.example.com/v1", credential: "x", customHeaders: { "X-Old": "gone" } }, { cookie })
    );
    const created = (await createRes.json()) as { id: string };

    const updateRes = await app.handle(postJson(`/console/api/custom-providers/${created.id}`, { customHeaders: { "X-New": "here" } }, { cookie }));
    const updated = (await updateRes.json()) as { customHeaders: Record<string, string> };
    expect(updated.customHeaders).toEqual({ "X-New": "here" });
  });
});

describe("custom provider model discovery enrichment", () => {
  test("a discovered id matching a known model gets its capabilities/context back-filled", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "Enrich Test", type: "openai-compatible", baseUrl: "https://e.example.com/v1", credential: "x" }, { cookie })
    );
    const created = (await createRes.json()) as { id: string };

    // "gpt-oss-120b" is a known model (Cerebras' curated catalog) — the
    // custom provider's own /models call only returns a bare id.
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }, { id: "totally-unknown-model-xyz" }] }), { status: 200, headers: { "content-type": "application/json" } }));

    const fetchRes = await app.handle(postJson(`/console/api/custom-providers/${created.id}/models/fetch`, {}, { cookie }));
    expect(fetchRes.status).toBe(200);
    const result = (await fetchRes.json()) as { models: Array<{ id: string; reasoning?: boolean; vision?: boolean; contextWindow?: number }> };

    const known = result.models.find((m) => m.id === "gpt-oss-120b")!;
    expect(known.reasoning).toBe(true);
    expect(known.vision).toBeUndefined();

    const unknown = result.models.find((m) => m.id === "totally-unknown-model-xyz")!;
    expect(unknown.reasoning).toBeUndefined();
    expect(unknown.vision).toBeUndefined();
  });
});

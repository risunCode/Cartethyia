/**
 * End-to-end: create a custom OpenAI-compatible provider via the console
 * API, dispatch a chat request through `<slug>/<model>` — the slug is the
 * prefix directly, no `custom/` wrapper — then delete it and confirm the
 * prefix stops routing (REQ-8).
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
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("custom provider dispatch", () => {
  test("routes a request through <slug>/<model> (no custom/ wrapper) to the registered base URL with the stored credential", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "My Endpoint", type: "openai-compatible", baseUrl: "https://my-endpoint.example.com/v1", credential: "sk-secret-123" }, { cookie }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { slug: string };
    expect(created.slug).toBe("my-endpoint");

    fetchSpy.mockResolvedValueOnce(chatResponse("hello from custom provider"));

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "my-endpoint/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: [{ message: { content: string } }] };
    expect(body.choices[0].message.content).toBe("hello from custom provider");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://my-endpoint.example.com/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret-123");
    const sentBody = JSON.parse(String(init?.body)) as { model: string };
    expect(sentBody.model).toBe("gpt-4o-mini");
  });

  test("deleting a custom provider makes its prefix stop routing immediately", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "Temp", type: "openai-compatible", baseUrl: "https://temp.example.com/v1", credential: "sk-x" }, { cookie }),
    );
    const created = (await createRes.json()) as { id: string; slug: string };

    const deleteRes = await app.handle(
      new Request(`http://localhost/console/api/custom-providers/${created.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie } }),
    );
    expect(deleteRes.status).toBe(200);

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${created.slug}/gpt-4o-mini`, messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    // Same "model not available" status every provider returns for an unresolvable model — not custom-provider-specific.
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects a slug collision with 409", async () => {
    const cookie = await loginAndGetCookie();
    await app.handle(postJson("/console/api/custom-providers", { name: "Dup", type: "openai-compatible", baseUrl: "https://a.example.com", credential: "x" }, { cookie }));
    const secondRes = await app.handle(postJson("/console/api/custom-providers", { name: "Dup", type: "openai-compatible", baseUrl: "https://b.example.com", credential: "y" }, { cookie }));
    expect(secondRes.status).toBe(409);
  });

  test("the old custom/<slug>/<model> wrapper is no longer a valid prefix", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "No Wrapper", type: "openai-compatible", baseUrl: "https://no-wrapper.example.com/v1", credential: "sk-x" }, { cookie }),
    );
    const created = (await createRes.json()) as { slug: string };

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `custom/${created.slug}/gpt-4o-mini`, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

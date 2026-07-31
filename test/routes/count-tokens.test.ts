/**
 * Tests for POST /v1/messages/count_tokens — Anthropic's token-counting
 * endpoint. Covers the built-in "anthropic" provider, an "anthropic-compatible"
 * custom provider, and the clean-400 path for providers with no equivalent
 * upstream operation (OpenAI, and an "openai-compatible" custom provider).
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

function countTokensResponse(inputTokens: number) {
  return new Response(JSON.stringify({ input_tokens: inputTokens }), { status: 200, headers: { "content-type": "application/json" } });
}

function postCountTokens(body: unknown, apiKey = "sk-ant-test") {
  return app.handle(
    new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      // Cartethyia's own inbound BYOK convention is a uniform `Authorization:
      // Bearer` regardless of what header the target upstream itself needs -
      // it's translated internally into `x-api-key` for the real Anthropic call.
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /v1/messages/count_tokens — built-in Anthropic provider", () => {
  test("forwards to api.anthropic.com/v1/messages/count_tokens and returns input_tokens", async () => {
    fetchSpy.mockResolvedValueOnce(countTokensResponse(42));

    const res = await postCountTokens({ model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const bodyOut = (await res.json()) as { input_tokens: number };
    expect(bodyOut.input_tokens).toBe(42);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sentBody.model).toBe("claude-opus-5");
    expect(sentBody.stream).toBeUndefined();
    expect(sentBody.max_tokens).toBeUndefined();
  });

  test("forwards system/tools/tool_choice unchanged (native Anthropic shape, no Chat translation)", async () => {
    fetchSpy.mockResolvedValueOnce(countTokensResponse(7));

    const res = await postCountTokens({
      model: "anthropic/claude-opus-5",
      system: "Be helpful",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", input_schema: { type: "object", properties: {} } }],
    });

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sentBody.system).toBe("Be helpful");
    expect(sentBody.tools).toEqual([{ name: "get_weather", input_schema: { type: "object", properties: {} } }]);
  });

  test("upstream 401 maps to a clean authentication_error, not a raw passthrough", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }));

    const res = await postCountTokens({ model: "anthropic/claude-opus-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    const bodyOut = (await res.json()) as { error: { type: string } };
    expect(bodyOut.error.type).toBe("authentication_error");
  });

  test("an unresolvable model returns 400 without ever calling fetch", async () => {
    const res = await postCountTokens({ model: "anthropic/", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /v1/messages/count_tokens — providers without a count_tokens operation", () => {
  test("a model routed to a provider with no countTokens implementation (OpenAI) returns a clean 400", async () => {
    const res = await postCountTokens({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] }, "sk-openai-test");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    const bodyOut = (await res.json()) as { error: { type: string; message: string } };
    expect(bodyOut.error.type).toBe("invalid_request_error");
    expect(bodyOut.error.message).toContain("not supported");
  });
});

describe("POST /v1/messages/count_tokens — anthropic-compatible custom providers", () => {
  test("forwards to <baseUrl>/messages/count_tokens with the stored credential", async () => {
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "My Claude Proxy", type: "anthropic-compatible", baseUrl: "https://my-claude-proxy.example.com/v1", credential: "sk-proxy-secret" }, { cookie })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { slug: string };

    fetchSpy.mockResolvedValueOnce(countTokensResponse(15));

    const res = await postCountTokens({ model: `${created.slug}/claude-opus-5`, messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const bodyOut = (await res.json()) as { input_tokens: number };
    expect(bodyOut.input_tokens).toBe(15);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://my-claude-proxy.example.com/v1/messages/count_tokens");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-proxy-secret");
    const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sentBody.model).toBe("claude-opus-5");
  });

  test("an openai-compatible custom provider returns a clean 400 instead of forwarding to a non-existent endpoint", async () => {
    // The "custom" provider is one shared registry entry backing many DB
    // records of either type, so the openai-compatible-vs-anthropic-compatible
    // check only happens once countTokens actually runs (unlike the static
    // "provider has no countTokens at all" case above, which the route
    // rejects before ever calling in). That thrown ProviderCallError takes
    // the same generic-sanitized-message path every other provider-internal
    // failure already does in chat.ts/messages.ts - not a route-level check,
    // so it is intentionally NOT this route's own specific wording.
    const cookie = await loginAndGetCookie();
    const createRes = await app.handle(
      postJson("/console/api/custom-providers", { name: "My OpenAI Proxy", type: "openai-compatible", baseUrl: "https://my-openai-proxy.example.com/v1", credential: "sk-proxy-secret" }, { cookie })
    );
    const created = (await createRes.json()) as { slug: string };

    const res = await postCountTokens({ model: `${created.slug}/gpt-4o-mini`, messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    const bodyOut = (await res.json()) as { error: { type: string } };
    expect(bodyOut.error.type).toBe("invalid_request_error");
  });
});

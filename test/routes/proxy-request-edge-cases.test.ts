/**
 * Edge-case tests for withProxyRequest — ProviderCallError handling and
 * errorMapper interaction. The existing proxy-request-middleware.test.ts
 * covers success, UpstreamError, plain Error, and slot lifecycle; this
 * file covers the remaining error-mapper edge cases.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { useIsolatedDataDir } from "../console/helpers";
import { withProxyRequest } from "../../src/routes/middleware/proxyRequest";
import { openAIUpstreamError, openAIClientError } from "../../src/http/errors";
import { ProviderCallError } from "../../src/upstream/providers";

beforeEach(() => {
  useIsolatedDataDir();
});

function testApp(handler: Parameters<typeof withProxyRequest>[1], errorMapper = openAIUpstreamError) {
  return new Elysia().post("/test-proxy", async ({ request, server, set }) =>
    withProxyRequest(
      { endpoint: "/test-proxy", surface: "chat", model: "test/model", stream: false, request, server, set, errorMapper },
      handler,
    ),
  );
}

describe("withProxyRequest — ProviderCallError mapping", () => {
  test("maps a 4xx ProviderCallError through the error mapper", async () => {
    const testApi = testApp(async () => {
      throw new ProviderCallError(400, "invalid_request", "bad model name");
    });
    const res = await testApi.handle(new Request("http://localhost/test-proxy", { method: "POST" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { type?: string; message?: string } };
    expect(body.error?.message).toBeTruthy();
  });

  test("maps a 401 ProviderCallError as authentication error", async () => {
    const testApi = testApp(async () => {
      throw new ProviderCallError(401, "authentication", "invalid credential");
    });
    const res = await testApi.handle(new Request("http://localhost/test-proxy", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  test("maps a 429 ProviderCallError through the error mapper", async () => {
    const testApi = testApp(async () => {
      throw new ProviderCallError(429, "rate_limited", "too many requests");
    });
    const res = await testApi.handle(new Request("http://localhost/test-proxy", { method: "POST" }));
    expect(res.status).toBe(429);
  });
});

describe("withProxyRequest — errorMapper interaction", () => {
  test("a handler that returns a successful Response passes it through untouched", async () => {
    const testApi = testApp(async () => new Response("raw stream", { status: 200 }));
    const res = await testApi.handle(new Request("http://localhost/test-proxy", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("raw stream");
  });
});

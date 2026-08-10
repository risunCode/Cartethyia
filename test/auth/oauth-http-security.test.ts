import { describe, expect, test } from "bun:test";
import { OAuthDriverError, OAuthHttpClient } from "../../src/application/auth/oauth/base";
import { createEnvOAuthRefresher } from "../../src/application/auth/oauth-refresher";

const jsonHeaders = { "content-type": "application/json" };

describe("OAuth HTTP transport hardening", () => {
  test("forces manual redirects and an abort signal on token requests", async () => {
    let requestInit: RequestInit | undefined;
    const client = new OAuthHttpClient({
      fetch: async (_input, init) => {
        requestInit = init;
        return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200, headers: jsonHeaders });
      },
    });

    await expect(client.postJson("https://oauth.example.test/token", { grant_type: "refresh_token" }, "test", "refresh")).resolves.toEqual({ access_token: "access-token" });
    expect(requestInit?.redirect).toBe("manual");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects successful token responses with a non-JSON content type", async () => {
    const client = new OAuthHttpClient({
      fetch: async () => new Response("<html>not-json</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });

    await expect(client.postForm("https://oauth.example.test/token", {}, "test", "refresh")).rejects.toMatchObject({ kind: "content-type", status: 502 });
  });

  test("rejects redirects instead of following them", async () => {
    const client = new OAuthHttpClient({
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example.test" } }),
    });

    await expect(client.postForm("https://oauth.example.test/token", {}, "test", "refresh")).rejects.toMatchObject({ kind: "redirect", status: 502 });
  });

  test("bounds token response bytes before JSON parsing", async () => {
    const client = new OAuthHttpClient({
      maxBytes: 32,
      fetch: async () => new Response(JSON.stringify({ access_token: "this-token-is-too-large" }), { status: 200, headers: jsonHeaders }),
    });

    await expect(client.postForm("https://oauth.example.test/token", {}, "test", "refresh")).rejects.toMatchObject({ kind: "response-too-large", status: 502 });
  });

  test("preserves Retry-After as a bounded account retry deadline", async () => {
    const client = new OAuthHttpClient({
      nowMs: () => Date.parse("2026-08-10T00:00:00.000Z"),
      fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "15" } }),
    });

    const error = await client.postForm("https://oauth.example.test/token", {}, "test", "refresh").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(OAuthDriverError);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAt: "2026-08-10T00:00:15.000Z" });
  });
  test("allows only public HTTPS OAuth endpoints", async () => {
    const client = new OAuthHttpClient({ fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders }) });

    await expect(client.postForm("http://oauth.example.test/token", {}, "test", "refresh")).rejects.toMatchObject({ kind: "validation", status: 400 });
    await expect(client.postForm("https://127.0.0.1/token", {}, "test", "refresh")).rejects.toMatchObject({ kind: "validation", status: 400 });
  });

  test("the env fallback preserves Retry-After and rejects non-JSON success bodies", async () => {
    const common = {
      resolveProvider: async () => "codex",
      nowMs: () => Date.parse("2026-08-10T00:00:00.000Z"),
      env: {
        CARTETHYIA_OAUTH_CODEX_TOKEN_URL: "https://oauth.example.test/token",
        CARTETHYIA_OAUTH_CODEX_CLIENT_ID: "client",
        CARTETHYIA_OAUTH_CODEX_CLIENT_SECRET: "secret",
      },
      lookup: async () => [{ address: "8.8.8.8" }],
    };
    const transient = createEnvOAuthRefresher({ ...common, fetchFn: async () => new Response(null, { status: 429, headers: { "retry-after": "20" } }) });
    const result = await transient.refresh({ accountId: "account-1", token: { accessToken: "old", expiresAtMs: 1, refreshToken: "refresh", kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ statusCode: 429, retryAt: "2026-08-10T00:00:20.000Z" });

    const malformed = createEnvOAuthRefresher({ ...common, fetchFn: async () => new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }) });
    const malformedResult = await malformed.refresh({ accountId: "account-1", token: { accessToken: "old", expiresAtMs: 1, refreshToken: "refresh", kind: "oauth" } });
    expect(malformedResult).toMatchObject({ ok: false });
  });
});

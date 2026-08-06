import { describe, expect, test } from "bun:test";
import { CodexOAuthDriver } from "../../src/auth/oauth/codex";
import { OAuthDriverError } from "../../src/auth/oauth/base";
import type { OAuthFetch } from "../../src/auth/oauth/base";

function formResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch(responder: (url: string, body: URLSearchParams, init: RequestInit) => Response): { fetch: OAuthFetch; lastUrl: () => string; lastBody: () => URLSearchParams } {
  let url = "";
  let body = new URLSearchParams();
  const fetch: OAuthFetch = (input, init) => {
    url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    body = new URLSearchParams(raw);
    return Promise.resolve(responder(url, body, init as RequestInit));
  };
  return { fetch, lastUrl: () => url, lastBody: () => body };
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=/g, "");
  const body = btoa(JSON.stringify(payload)).replace(/=/g, "");
  return `${header}.${body}.sig`;
}

describe("CodexOAuthDriver — start (Authorization Code + PKCE)", () => {
  test("builds the authorize URL with PKCE challenge and Codex-specific params", async () => {
    const driver = new CodexOAuthDriver();
    const result = await driver.start({ providerId: "codex", codeChallenge: "challenge-xyz", state: "st-1" });
    expect(result.state).toBe("st-1");
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  });

  test("throws a validation error when the PKCE challenge is missing", () => {
    const driver = new CodexOAuthDriver();
    // challenge() throws synchronously before start() wraps in Promise.resolve,
    // so this is a synchronous throw, not a rejected promise.
    expect(() => driver.start({ providerId: "codex" })).toThrow(OAuthDriverError);
  });
});

describe("CodexOAuthDriver — exchange", () => {
  test("posts the authorization code and extracts the ChatGPT account id from the access-token JWT", async () => {
    const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" } });
    const { fetch, lastUrl, lastBody } = recordingFetch(() => formResponse({ access_token: access, refresh_token: "ref-1", expires_in: 3600, scope: "openid" }));
    const driver = new CodexOAuthDriver({ fetch });
    const tokenSet = await driver.exchange({ providerId: "codex", code: "auth-code", codeVerifier: "verifier-1" });
    expect(tokenSet.accessToken).toBe(access);
    expect(tokenSet.refreshToken).toBe("ref-1");
    expect(tokenSet.providerAccountId).toBe("acc-9");
    expect(lastUrl()).toBe("https://auth.openai.com/oauth/token");
    expect(lastBody().get("grant_type")).toBe("authorization_code");
    expect(lastBody().get("code")).toBe("auth-code");
    expect(lastBody().get("code_verifier")).toBe("verifier-1");
  });

  test("throws on a non-OK token response", async () => {
    const { fetch } = recordingFetch(() => formResponse({ error: "bad" }, 400));
    const driver = new CodexOAuthDriver({ fetch });
    await expect(driver.exchange({ providerId: "codex", code: "auth-code", codeVerifier: "v" })).rejects.toBeInstanceOf(OAuthDriverError);
  });
});

describe("CodexOAuthDriver — refresh", () => {
  test("posts the refresh token grant and returns a refreshed token set", async () => {
    const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" } });
    const { fetch, lastBody } = recordingFetch(() => formResponse({ access_token: access, refresh_token: "ref-2", expires_in: 3600 }));
    const driver = new CodexOAuthDriver({ fetch });
    const tokenSet = await driver.refresh({ providerId: "codex", accountId: "acc-9", refreshToken: "ref-1" });
    expect(tokenSet.accessToken).toBe(access);
    expect(lastBody().get("grant_type")).toBe("refresh_token");
    expect(lastBody().get("refresh_token")).toBe("ref-1");
  });
});

describe("CodexOAuthDriver — buildHeaders", () => {
  test("carries the Bearer token and Codex wire headers", () => {
    const driver = new CodexOAuthDriver();
    const headers = driver.buildHeaders({ providerId: "codex", accountId: null, credential: "tok-1" });
    expect(headers.authorization).toBe("Bearer tok-1");
    expect(headers["openai-beta"]).toBe("responses=experimental");
    expect(headers.originator).toBe("pi");
    expect(headers.version).toBeDefined();
    expect(headers.accept).toBe("text/event-stream");
  });
});

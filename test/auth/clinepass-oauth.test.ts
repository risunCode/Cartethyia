import { describe, expect, test } from "bun:test";
import { ClinePassOAuthDriver } from "../../src/auth/oauth/clinepass";
import { OAuthDriverError } from "../../src/auth/oauth/base";
import type { OAuthFetch } from "../../src/auth/oauth/base";

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function fixedFetch(responder: (url: string, init: RequestInit | undefined) => Response): OAuthFetch {
  return (input, init) => Promise.resolve(responder(String(input), init));
}

const NOW = 1_000_000;

describe("ClinePassOAuthDriver — start", () => {
  test("builds the authorize URL with the default callback and a fresh state", async () => {
    const driver = new ClinePassOAuthDriver({ nowMs: () => NOW });
    const result = await driver.start({ providerId: "clinepass" });
    expect(result.authorizationUrl).toContain("https://api.cline.bot/api/v1/auth/authorize?");
    expect(result.authorizationUrl).toContain("callback_url=http%3A%2F%2F127.0.0.1%3A1456%2Fcallback");
    expect(result.state).toHaveLength(36);
    expect(result.expiresAtMs).toBe(NOW + 300_000);
  });

  test("honors an explicit redirectUri and state", async () => {
    const driver = new ClinePassOAuthDriver({ nowMs: () => NOW });
    const result = await driver.start({ providerId: "clinepass", redirectUri: "http://localhost:9999/cb", state: "st-1" });
    expect(result.state).toBe("st-1");
    expect(result.authorizationUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb");
  });
});

describe("ClinePassOAuthDriver — exchange (browser-token fast path)", () => {
  test("decodes a base64 JSON callback code into a token set without touching the network", async () => {
    const fetch = fixedFetch(() => { throw new Error("network should not be called"); });
    const driver = new ClinePassOAuthDriver({ fetch, nowMs: () => NOW });
    const code = btoa(JSON.stringify({ access_token: "tok-1", refresh_token: "ref-1", email: "u@e.com" }));
    const tokenSet = await driver.exchange({ providerId: "clinepass", code });
    expect(tokenSet.accessToken).toBe("tok-1");
    expect(tokenSet.refreshToken).toBe("ref-1");
    expect(tokenSet.email).toBe("u@e.com");
  });

  test("falls back to the token endpoint when the code is not decodable JSON", async () => {
    const fetch = fixedFetch(() => jsonResponse({ access_token: "tok-2", expires_at: "2026-08-05T00:00:00.000Z" }));
    const driver = new ClinePassOAuthDriver({ fetch, nowMs: () => NOW });
    const tokenSet = await driver.exchange({ providerId: "clinepass", code: "raw-code" });
    expect(tokenSet.accessToken).toBe("tok-2");
    expect(tokenSet.expiresAt).toBe("2026-08-05T00:00:00.000Z");
  });

  test("throws OAuthDriverError when the response is missing an access token", async () => {
    const fetch = fixedFetch(() => jsonResponse({ refresh_token: "ref" }));
    const driver = new ClinePassOAuthDriver({ fetch, nowMs: () => NOW });
    await expect(driver.exchange({ providerId: "clinepass", code: "raw-code" })).rejects.toBeInstanceOf(OAuthDriverError);
  });
});

describe("ClinePassOAuthDriver — refresh", () => {
  test("posts the refresh token and returns a new token set", async () => {
    const fetch = fixedFetch(() => jsonResponse({ access_token: "tok-3" }));
    const driver = new ClinePassOAuthDriver({ fetch, nowMs: () => NOW });
    const tokenSet = await driver.refresh({ providerId: "clinepass", accountId: "acc-1", refreshToken: "ref-1" });
    expect(tokenSet.accessToken).toBe("tok-3");
  });

  test("throws on a non-OK response", async () => {
    const fetch = fixedFetch(() => jsonResponse({ error: "invalid" }, 401));
    const driver = new ClinePassOAuthDriver({ fetch, nowMs: () => NOW });
    await expect(driver.refresh({ providerId: "clinepass", accountId: "acc-1", refreshToken: "ref-1" })).rejects.toBeInstanceOf(OAuthDriverError);
  });
});

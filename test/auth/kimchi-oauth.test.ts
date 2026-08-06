import { describe, expect, test } from "bun:test";
import { KimchiOAuthDriver } from "../../src/auth/oauth/kimchi";
import { OAuthDriverError } from "../../src/auth/oauth/base";
import type { OAuthFetch } from "../../src/auth/oauth/base";

const NOW = 1_000_000;

function okResponse(): Response {
  return new Response(JSON.stringify({ supported: true }), { status: 200, headers: { "content-type": "application/json" } });
}

function failResponse(status: number): Response {
  return new Response("nope", { status });
}

function fetchReturning(response: Response): OAuthFetch {
  return () => Promise.resolve(response);
}

describe("KimchiOAuthDriver — start", () => {
  test("builds the cli-auth URL with the default callback and state", async () => {
    const driver = new KimchiOAuthDriver({ nowMs: () => NOW });
    const result = await driver.start({ providerId: "kimchi" });
    expect(result.authorizationUrl).toContain("https://app.kimchi.dev/cli-auth?");
    expect(result.authorizationUrl).toContain("callback=http%3A%2F%2F127.0.0.1%3A1457%2Fcallback");
    expect(result.state).toHaveLength(36);
    expect(result.expiresAtMs).toBe(NOW + 300_000);
  });

  test("honors an explicit redirectUri and state", async () => {
    const driver = new KimchiOAuthDriver({ nowMs: () => NOW });
    const result = await driver.start({ providerId: "kimchi", redirectUri: "http://localhost:9999/cb", state: "st-1" });
    expect(result.state).toBe("st-1");
    expect(result.authorizationUrl).toContain("callback=http%3A%2F%2Flocalhost%3A9999%2Fcb");
  });
});

describe("KimchiOAuthDriver — exchange", () => {
  test("extracts the token from a callback URL and validates it", async () => {
    const driver = new KimchiOAuthDriver({ fetch: fetchReturning(okResponse()), nowMs: () => NOW });
    const tokenSet = await driver.exchange({ providerId: "kimchi", code: "http://127.0.0.1:1457/callback?token=tok-1" });
    expect(tokenSet.accessToken).toBe("tok-1");
    expect(tokenSet.expiresAt).toBe(new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString());
  });

  test("accepts an access_token query param as well", async () => {
    const driver = new KimchiOAuthDriver({ fetch: fetchReturning(okResponse()), nowMs: () => NOW });
    const tokenSet = await driver.exchange({ providerId: "kimchi", code: "http://127.0.0.1:1457/callback?access_token=tok-2" });
    expect(tokenSet.accessToken).toBe("tok-2");
  });

  test("accepts a plain pasted token", async () => {
    const driver = new KimchiOAuthDriver({ fetch: fetchReturning(okResponse()), nowMs: () => NOW });
    const tokenSet = await driver.exchange({ providerId: "kimchi", code: "pasted-token" });
    expect(tokenSet.accessToken).toBe("pasted-token");
  });

  test("throws when the callback contains no token", async () => {
    const driver = new KimchiOAuthDriver({ fetch: fetchReturning(okResponse()), nowMs: () => NOW });
    await expect(driver.exchange({ providerId: "kimchi", code: "  " })).rejects.toBeInstanceOf(OAuthDriverError);
  });

  test("throws authorization_denied when validation rejects the token", async () => {
    // Create a fresh Response per call so the body is not single-consumed.
    const fetch: OAuthFetch = () => Promise.resolve(failResponse(401));
    const driver = new KimchiOAuthDriver({ fetch, nowMs: () => NOW });
    try {
      await driver.exchange({ providerId: "kimchi", code: "bad-token" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthDriverError);
      expect((error as OAuthDriverError).kind).toBe("authorization_denied");
      expect((error as OAuthDriverError).status).toBe(401);
    }
  });

  test("treats a validation network failure as not-ok (rejected)", async () => {
    const fetch: OAuthFetch = () => Promise.reject(new Error("network down"));
    const driver = new KimchiOAuthDriver({ fetch, nowMs: () => NOW });
    await expect(driver.exchange({ providerId: "kimchi", code: "tok" })).rejects.toBeInstanceOf(OAuthDriverError);
  });
});

describe("KimchiOAuthDriver — refresh", () => {
  test("always rejects because browser tokens are non-refreshable", async () => {
    const driver = new KimchiOAuthDriver();
    await expect(driver.refresh({ providerId: "kimchi", accountId: "acc-1", refreshToken: "r" })).rejects.toBeInstanceOf(OAuthDriverError);
    try {
      await driver.refresh({ providerId: "kimchi", accountId: "acc-1", refreshToken: "r" });
    } catch (error) {
      expect((error as OAuthDriverError).kind).toBe("validation");
    }
  });
});

describe("KimchiOAuthDriver — buildHeaders", () => {
  test("returns a Bearer header for a plain credential", () => {
    const driver = new KimchiOAuthDriver();
    expect(driver.buildHeaders({ providerId: "kimchi", accountId: null, credential: "tok" })).toEqual({ authorization: "Bearer tok" });
  });

  test("extracts accessToken from a JSON credential", () => {
    const driver = new KimchiOAuthDriver();
    const headers = driver.buildHeaders({ providerId: "kimchi", accountId: null, credential: JSON.stringify({ accessToken: "json-tok" }) });
    expect(headers.authorization).toBe("Bearer json-tok");
  });

  test("returns empty headers for an empty credential", () => {
    const driver = new KimchiOAuthDriver();
    expect(driver.buildHeaders({ providerId: "kimchi", accountId: null, credential: "" })).toEqual({});
  });
});

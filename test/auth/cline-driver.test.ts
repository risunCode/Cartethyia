import { describe, expect, test } from "bun:test";
import {
  CLINE_DEVICE_GRANT_TYPE,
  CLINE_DEVICE_DEFAULT_EXPIRES_IN_SECONDS,
  CLINE_TOKEN_PATH,
  CLINE_API_BASE_URL,
  CLINE_REFRESH_PATH,
  CLINE_WORKOS_API_BASE_URL,
  CLINE_WORKOS_CLIENT_ID,
  ClineOAuthDriver,
} from "../../src/auth/oauth/cline";
import type { OAuthFetch } from "../../src/auth/oauth/base";
import { OAuthDriverError } from "../../src/auth/oauth/base";

interface FetchCall {
  readonly url: string;
  readonly body: URLSearchParams;
  readonly rawBody: string;
  readonly headers: Record<string, string>;
}

function recordingFetch(responder: (call: FetchCall, index: number) => Response): { fetch: OAuthFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: OAuthFetch = (input, init) => {
    const url = String(input);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = new URLSearchParams(rawBody);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key] = String(value);
    calls.push({ url, body, rawBody, headers });
    return Promise.resolve(responder(calls[calls.length - 1] as FetchCall, calls.length - 1));
  };
  return { fetch, calls };
}

function tokenResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("ClineOAuthDriver (WorkOS device flow)", () => {
  test("start requests a device code from WorkOS and exposes the verification URI", async () => {
    const { fetch, calls } = recordingFetch(() =>
      tokenResponse({
        device_code: "device-1",
        user_code: "USER-CODE",
        verification_uri: "https://api.workos.com/activate",
        verification_uri_complete: "https://api.workos.com/activate?user_code=USER-CODE",
        expires_in: 300,
        interval: 5,
      }),
    );
    const driver = new ClineOAuthDriver({ fetch, clientId: "test-client", nowMs: () => 1_000_000 });
    const result = await driver.start({ providerId: "cline", state: "st-1" });
    expect(result.authorizationUrl).toBe("https://api.workos.com/activate?user_code=USER-CODE");
    expect(result.state).toBe("st-1");
    expect(result.expiresAtMs).toBe(1_000_000 + 300_000);
    const call = calls[0] as FetchCall;
    expect(call.url).toBe(`${CLINE_WORKOS_API_BASE_URL}/user_management/authorize/device`);
    expect(call.body.get("client_id")).toBe("test-client");
  });

  test("falls back to the verification URI when the complete variant is absent", async () => {
    const { fetch } = recordingFetch(() => tokenResponse({ device_code: "d", user_code: "u", verification_uri: "https://api.workos.com/activate", expires_in: 300, interval: 5 }));
    const driver = new ClineOAuthDriver({ fetch, clientId: "c" });
    const result = await driver.start({ providerId: "cline", state: "st" });
    expect(result.authorizationUrl).toBe("https://api.workos.com/activate");
  });

  test("uses the official production client id by default", () => {
    const driver = new ClineOAuthDriver();
    const explicit = new ClineOAuthDriver({ clientId: "custom" });
    expect((driver as { clientId: string }).clientId).toBe(CLINE_WORKOS_CLIENT_ID);
    expect((explicit as { clientId: string }).clientId).toBe("custom");
  });

  test("rejects a malformed device authorization response", async () => {
    const { fetch } = recordingFetch(() => tokenResponse({ error: "invalid_client" }, 400));
    const driver = new ClineOAuthDriver({ fetch, clientId: "c" });
    await expect(driver.start({ providerId: "cline" })).rejects.toThrow(OAuthDriverError);
  });

  test("polls until the user authorizes, then returns tokens", async () => {
    const { fetch, calls } = recordingFetch((_call, index) => {
      if (index === 0) return tokenResponse({ device_code: "device-1", user_code: "USER-CODE", verification_uri: "https://api.workos.com/activate", expires_in: 300, interval: 1 });
      if (index === 1) return tokenResponse({ error: "authorization_pending" });
      if (index === 2) return tokenResponse({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3_600 });
      if (index === 3) return tokenResponse({ success: true, data: { accessToken: "registered-access-1", refreshToken: "registered-refresh-1", expiresAt: "2030-01-01T00:00:00.000Z", userInfo: { clineUserId: "cline-user-1", email: "dev@example.com" } } });
      throw new Error("unexpected Cline registration call");
    });
    const driver = new ClineOAuthDriver({ fetch, clientId: "c", nowMs: () => 1_000_000 });
    await driver.start({ providerId: "cline", state: "st" });
    const tokens = await driver.exchange({ providerId: "cline", state: "st", code: "" });
    expect(tokens.accessToken).toBe("registered-access-1");
    expect(tokens.refreshToken).toBe("registered-refresh-1");
    expect(tokens.providerAccountId).toBe("cline-user-1");
    expect(tokens.email).toBe("dev@example.com");
    expect(tokens.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    const poll = calls[1] as FetchCall;
    expect(poll.url).toBe(`${CLINE_WORKOS_API_BASE_URL}${CLINE_TOKEN_PATH}`);
    expect(poll.body.get("grant_type")).toBe(CLINE_DEVICE_GRANT_TYPE);
    expect(poll.body.get("device_code")).toBe("device-1");
    expect(poll.body.get("client_id")).toBe("c");
  });

  test("accepts an explicit device code without a start session", async () => {
    const { fetch } = recordingFetch((_call, index) => index === 0
      ? tokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3_600 })
      : tokenResponse({ success: true, data: { accessToken: "registered-a", refreshToken: "registered-r", expiresAt: "2030-01-01T00:00:00.000Z" } }));
    const driver = new ClineOAuthDriver({ fetch, clientId: "c" });
    const tokens = await driver.exchange({ providerId: "cline", code: "device-9" });
    expect(tokens.accessToken).toBe("registered-a");
  });

  test("rejects an exchange without a start session or device code", async () => {
    const { fetch } = recordingFetch(() => tokenResponse({}));
    const driver = new ClineOAuthDriver({ fetch, clientId: "c" });
    await expect(driver.exchange({ providerId: "cline", code: "" })).rejects.toThrow(/active start session/);
  });

  test("maps access_denied to a non-retryable authorization failure", async () => {
    const { fetch } = recordingFetch((_call, index) => {
      if (index === 0) return tokenResponse({ device_code: "device-1", user_code: "USER-CODE", verification_uri: "https://api.workos.com/activate", expires_in: 300, interval: 5 });
      return tokenResponse({ error: "access_denied" }, 400);
    });
    const driver = new ClineOAuthDriver({ fetch, clientId: "c", nowMs: () => 1_000_000 });
    await driver.start({ providerId: "cline", state: "st" });
    await expect(driver.exchange({ providerId: "cline", state: "st", code: "" })).rejects.toThrow(OAuthDriverError);
  });

  test("times out after the device expires", async () => {
    let now = 1_000_000;
    const { fetch } = recordingFetch((_call, index) => {
      if (index === 0) return tokenResponse({ device_code: "device-1", user_code: "USER-CODE", verification_uri: "https://api.workos.com/activate", expires_in: 300, interval: 5 });
      return tokenResponse({ error: "authorization_pending" }, 400);
    });
    const driver = new ClineOAuthDriver({ fetch, clientId: "c", nowMs: () => now });
    await driver.start({ providerId: "cline", state: "st" });
    now += CLINE_DEVICE_DEFAULT_EXPIRES_IN_SECONDS * 1_000 + 1;
    await expect(driver.exchange({ providerId: "cline", state: "st", code: "" })).rejects.toThrow(/timed out/);
  });

  test("refreshes through the official Cline API with the refresh grant", async () => {
    const { fetch, calls } = recordingFetch(() => tokenResponse({ success: true, data: { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2030-01-01T00:00:00.000Z" } }));
    const driver = new ClineOAuthDriver({ fetch, clientId: "c", nowMs: () => 2_000_000 });
    const tokens = await driver.refresh({ providerId: "cline", accountId: "account-1", refreshToken: "refresh-1" });
    expect(tokens.accessToken).toBe("access-2");
    expect(tokens.refreshToken).toBe("refresh-2");
    const call = calls[0] as FetchCall;
    expect(call.url).toBe(`${CLINE_API_BASE_URL}${CLINE_REFRESH_PATH}`);
    expect(JSON.parse(call.rawBody)).toEqual({ refreshToken: "refresh-1", grantType: "refresh_token" });
  });

  test("has no revoke capability (official SDK has no token revocation endpoint)", () => {
    const driver = new ClineOAuthDriver();
    expect(Object.hasOwn(driver, "revoke")).toBe(false);
  });
});
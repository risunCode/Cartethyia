import { describe, expect, test } from "bun:test";
import { createAuthDriverRegistry, resolveAuthDriverCapabilities } from "../../src/application/auth/drivers";
import { AnthropicOAuthDriver } from "../../src/application/auth/oauth/anthropic";
import { AntigravityOAuthDriver } from "../../src/application/auth/oauth/antigravity";
import { ClineOAuthDriver } from "../../src/application/auth/oauth/cline";
import { ClinePassOAuthDriver } from "../../src/application/auth/oauth/clinepass";
import { CodexOAuthDriver } from "../../src/application/auth/oauth/codex";
import { CursorOAuthDriver } from "../../src/application/auth/oauth/cursor";
import { GrokBuildOAuthDriver } from "../../src/application/auth/oauth/grokbuild";
import { KimchiOAuthDriver } from "../../src/application/auth/oauth/kimchi";
import { DevinOAuthDriver } from "../../src/application/auth/oauth/devin";
import { KiroOAuthDriver } from "../../src/application/auth/oauth/kiro";
import type { AuthDriver, RefreshTokenInput, TokenSet } from "../../src/application/auth/contracts";

function response(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const input = (providerId: string): RefreshTokenInput => ({ providerId, accountId: `${providerId}-account`, refreshToken: "refresh-old" });

async function refresh(driver: AuthDriver, providerId: string): Promise<TokenSet> {
  if (driver.refresh === undefined) throw new Error(`${providerId} has no refresh implementation`);
  return driver.refresh(input(providerId));
}

function withResponse(body: Record<string, unknown>): { fetch: () => Promise<Response>; nowMs: () => number } {
  return { fetch: async () => response(body), nowMs: () => Date.parse("2026-08-10T00:00:00.000Z") };
}

describe("registered OAuth provider lifecycle", () => {
  test("registers every refresh-capable provider with explicit capability metadata", () => {
    const registry = createAuthDriverRegistry([
      { providerId: "antigravity", driver: new AntigravityOAuthDriver() },
      { providerId: "claude", driver: new AnthropicOAuthDriver() },
      { providerId: "cline", driver: new ClineOAuthDriver() },
      { providerId: "clinepass", driver: new ClinePassOAuthDriver() },
      { providerId: "grok-build", driver: new GrokBuildOAuthDriver() },
      { providerId: "kiro", driver: new KiroOAuthDriver() },
      { providerId: "kimchi", driver: new KimchiOAuthDriver({ fetch: async () => response({}) }) },
    ]);
    expect(registry.list().map((entry) => entry.providerId)).toEqual(["codex", "cursor", "devin", "antigravity", "claude", "cline", "clinepass", "grok-build", "kiro", "kimchi"]);
    expect(registry.list().filter((entry) => entry.providerId !== "kimchi").every((entry) => resolveAuthDriverCapabilities(entry.driver).supportsRefresh)).toBe(true);
    expect(resolveAuthDriverCapabilities(registry.get("kimchi")!)).toMatchObject({ supportsBrowser: true, supportsDevice: false, supportsRefresh: false, accessOnly: true });
  });

  test("refreshes Codex and preserves rotated refresh credentials", async () => {
    const driver = new CodexOAuthDriver(withResponse({ access_token: "codex-access", refresh_token: "codex-refresh", expires_in: 3600 }));
    await expect(refresh(driver, "codex")).resolves.toMatchObject({ accessToken: "codex-access", refreshToken: "codex-refresh" });
  });
  test("preserves the Codex refresh token when rotation omits it", async () => {
    const driver = new CodexOAuthDriver(withResponse({ access_token: "codex-access", expires_in: 3600 }));
    await expect(refresh(driver, "codex")).resolves.toMatchObject({ accessToken: "codex-access", refreshToken: "refresh-old" });
  });
  test("preserves ClinePass refresh token when refresh response omits rotation", async () => {
    const driver = new ClinePassOAuthDriver(withResponse({ accessToken: "clinepass-access", expiresAt: "2026-08-10T01:00:00.000Z" }));
    await expect(refresh(driver, "clinepass")).resolves.toMatchObject({ accessToken: "clinepass-access", refreshToken: "refresh-old" });
  });
  test("uses Codex device authorization without opening the fixed localhost callback", async () => {
    const calls: string[] = [];
    let pollCount = 0;
    const driver = new CodexOAuthDriver({
      nowMs: () => Date.parse("2026-08-10T00:00:00.000Z"),
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/deviceauth/usercode")) return response({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "3" });
        if (url.endsWith("/deviceauth/token")) {
          pollCount += 1;
          if (pollCount === 1) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 403, headers: { "content-type": "application/json" } });
          return response({ authorization_code: "authorization-code", code_verifier: "device-verifier" });
        }
        return response({ access_token: "codex-access", refresh_token: "codex-refresh", expires_in: 3600 });
      },
    });
    const started = await driver.start?.({ providerId: "codex", state: "device-state", flow: "device" });
    expect(started).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 3, state: "device-state", flow: "device" });
    await expect(driver.poll?.("device-state")).resolves.toMatchObject({ status: "pending", intervalSeconds: 3 });
    await expect(driver.poll?.("device-state")).resolves.toMatchObject({ status: "completed", tokenSet: { accessToken: "codex-access", refreshToken: "codex-refresh" } });
    expect(calls).toEqual([
      "POST https://auth.openai.com/api/accounts/deviceauth/usercode",
      "POST https://auth.openai.com/api/accounts/deviceauth/token",
      "POST https://auth.openai.com/api/accounts/deviceauth/token",
      "POST https://auth.openai.com/oauth/token",
    ]);
  });
  test("keeps Codex browser PKCE authorization available alongside device code", async () => {
    const driver = new CodexOAuthDriver();
    const started = await driver.start?.({
      providerId: "codex",
      state: "browser-state",
      redirectUri: "http://localhost:1455/auth/callback",
      codeChallenge: "challenge",
      flow: "browser",
    });
    expect(started).toMatchObject({ state: "browser-state" });
    const authorization = new URL(started?.authorizationUrl ?? "");
    expect(authorization.origin).toBe("https://auth.openai.com");
    expect(authorization.pathname).toBe("/oauth/authorize");
    expect(authorization.searchParams.get("code_challenge")).toBe("challenge");
    expect(authorization.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  });

  test("runs Cursor deep-control polling and refreshes rotated credentials", async () => {
    const calls: string[] = [];
    const responses = [
      new Response(null, { status: 404 }),
      response({ accessToken: "cursor-access", refreshToken: "cursor-refresh" }),
      response({ accessToken: "cursor-access", refreshToken: "cursor-refresh" }),
    ];
    const driver = new CursorOAuthDriver({
      fetch: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return responses.shift() ?? new Response(null, { status: 404 });
      },
      nowMs: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });
    const started = await driver.start({ providerId: "cursor", state: "cursor-state", flow: "device" });
    const authorization = new URL(started.authorizationUrl);
    expect(started).toMatchObject({ state: "cursor-state", flow: "device", verificationUri: "https://cursor.com/loginDeepControl" });
    expect(authorization.searchParams.get("challenge")).toBeTruthy();
    expect(authorization.searchParams.get("uuid")).toBeTruthy();
    await expect(driver.poll?.("cursor-state")).resolves.toMatchObject({ status: "pending", intervalSeconds: 2 });
    await expect(driver.poll?.("cursor-state")).resolves.toMatchObject({ status: "completed", tokenSet: { accessToken: "cursor-access", refreshToken: "cursor-refresh" } });
    expect(calls[0]).toContain("https://api2.cursor.sh/auth/poll?uuid=");
    await expect(refresh(driver, "cursor")).resolves.toMatchObject({ accessToken: "cursor-access", refreshToken: "cursor-refresh" });
    expect(calls[2]).toBe("POST https://api2.cursor.sh/auth/exchange_user_api_key");
  });

  test("refreshes Anthropic without re-fetching organization identity", async () => {
    const driver = new AnthropicOAuthDriver(withResponse({ access_token: "claude-access", refresh_token: "claude-refresh", expires_in: 3600, account: { uuid: "account", email_address: "user@example.test" } }));
    await expect(refresh(driver, "claude")).resolves.toMatchObject({ accessToken: "claude-access", providerAccountId: "account", email: "user@example.test" });
  });

  test("refreshes Antigravity with the OAuth token response", async () => {
    const driver = new AntigravityOAuthDriver(withResponse({ access_token: "google-access", refresh_token: "google-refresh", expires_in: 3600 }));
    await expect(refresh(driver, "antigravity")).resolves.toMatchObject({ accessToken: "google-access", refreshToken: "google-refresh" });
  });

  test("refreshes Cline and ClinePass through their provider response shapes", async () => {
    const cline = new ClineOAuthDriver(withResponse({ success: true, data: { accessToken: "cline-access", refreshToken: "cline-refresh", expiresIn: 3600 } }));
    const clinePass = new ClinePassOAuthDriver(withResponse({ accessToken: "clinepass-access", refreshToken: "clinepass-refresh", expiresIn: 3600 }));
    await expect(refresh(cline, "cline")).resolves.toMatchObject({ accessToken: "cline-access", refreshToken: "cline-refresh" });
    await expect(refresh(clinePass, "clinepass")).resolves.toMatchObject({ accessToken: "clinepass-access", refreshToken: "clinepass-refresh" });
  });

  test("refreshes Grok Build and Kiro without losing the prior refresh token", async () => {
    const grok = new GrokBuildOAuthDriver(withResponse({ access_token: "grok-access", expires_in: 3600 }));
    const kiro = new KiroOAuthDriver(withResponse({ accessToken: "kiro-access", expiresIn: 3600 }));
    await expect(refresh(grok, "grok-build")).resolves.toMatchObject({ accessToken: "grok-access", refreshToken: "refresh-old" });
    await expect(refresh(kiro, "kiro")).resolves.toMatchObject({ accessToken: "kiro-access", refreshToken: "refresh-old" });
  });
  test("refreshes Kiro builder credentials through the regional OIDC endpoint", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const driver = new KiroOAuthDriver({
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return response({ accessToken: "kiro-access", refreshToken: "kiro-refresh", expiresIn: 3600 });
      },
      nowMs: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });
    const credential = JSON.stringify({ accessToken: "old-access", refreshToken: "refresh-old", clientId: "client-id", clientSecret: "client-secret", region: "us-west-2" });

    await expect(driver.refresh({ providerId: "kiro", accountId: "kiro-account", refreshToken: "refresh-old", credential })).resolves.toMatchObject({
      accessToken: "kiro-access",
      refreshToken: "kiro-refresh",
    });
    expect(request?.url).toBe("https://oidc.us-west-2.amazonaws.com/token");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-old",
      grantType: "refresh_token",
    });
    expect(new Headers(request?.init?.headers).get("user-agent")).toBeNull();
  });

  test("uses the desktop Kiro refresh contract for social credentials", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const driver = new KiroOAuthDriver({
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return response({ accessToken: "kiro-social-access", expiresIn: 3600 });
      },
    });

    await expect(driver.refresh({ providerId: "kiro", accountId: "kiro-account", refreshToken: "social-refresh", credential: JSON.stringify({ accessToken: "old-access", authMethod: "google" }) })).resolves.toMatchObject({
      accessToken: "kiro-social-access",
      refreshToken: "social-refresh",
    });
    expect(request?.url).toBe("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken");
    expect(new Headers(request?.init?.headers).get("user-agent")).toBe("kiro-cli/1.0.0");
    expect(JSON.parse(String(request?.init?.body))).toEqual({ refreshToken: "social-refresh" });
  });

  test("uses Kimchi browser token callback instead of Kimi device authorization", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const driver = new KimchiOAuthDriver({
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return response({ providers: [] });
      },
      nowMs: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });
    const started = await driver.start({ providerId: "kimchi", state: "kimchi-state", flow: "browser" });
    expect(started).toMatchObject({ state: "kimchi-state", flow: "browser" });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe("https://app.kimchi.dev");
    expect(authorization.pathname).toBe("/cli-auth");
    expect(authorization.searchParams.get("callback")).toBe("http://127.0.0.1:1457/callback");
    expect(authorization.searchParams.get("state")).toBe("kimchi-state");
    await expect(driver.exchange?.({ providerId: "kimchi", code: "kimchi-access", state: "kimchi-state" })).resolves.toEqual({ accessToken: "kimchi-access" });
    expect(request?.url).toBe("https://api.cast.ai/v1/llm/openai/supported-providers");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer kimchi-access");
  });
  test("uses Devin PKCE callback exchange and keeps the session token refreshable", async () => {
    const driver = new DevinOAuthDriver(withResponse({ token: "devin-token" }));
    const started = await driver.start({ providerId: "devin", state: "devin-state", codeChallenge: "challenge" });
    expect(new URL(started.authorizationUrl).searchParams.get("code_challenge")).toBe("challenge");
    await expect(driver.exchange?.({ providerId: "devin", code: "authorization-code", codeVerifier: "verifier" })).resolves.toMatchObject({ accessToken: "devin-token", refreshToken: "devin-token" });
    await expect(refresh(driver, "devin")).resolves.toMatchObject({ accessToken: "refresh-old", refreshToken: "refresh-old" });
  });
});

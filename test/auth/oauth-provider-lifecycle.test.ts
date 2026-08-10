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
    expect(registry.list().map((entry) => entry.providerId)).toEqual(["codex", "cursor", "antigravity", "claude", "cline", "clinepass", "grok-build", "kiro", "kimchi"]);
    expect(registry.list().every((entry) => resolveAuthDriverCapabilities(entry.driver).supportsRefresh === (entry.providerId !== "kimchi"))).toBe(true);
  });

  test("refreshes Codex and preserves rotated refresh credentials", async () => {
    const driver = new CodexOAuthDriver(withResponse({ access_token: "codex-access", refresh_token: "codex-refresh", expires_in: 3600 }));
    await expect(refresh(driver, "codex")).resolves.toMatchObject({ accessToken: "codex-access", refreshToken: "codex-refresh" });
  });
  test("preserves the Codex refresh token when rotation omits it", async () => {
    const driver = new CodexOAuthDriver(withResponse({ access_token: "codex-access", expires_in: 3600 }));
    await expect(refresh(driver, "codex")).resolves.toMatchObject({ accessToken: "codex-access", refreshToken: "refresh-old" });
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

  test("keeps Kimchi explicitly access-only", async () => {
    const driver = new KimchiOAuthDriver({ fetch: async () => response({}) });
    expect(resolveAuthDriverCapabilities(driver)).toMatchObject({ supportsRefresh: false, accessOnly: true });
    await expect(driver.refresh?.(input("kimchi"))).rejects.toMatchObject({ status: 400 });
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createAccount, listAccounts } from "../src/console/db/repos/accounts";
import { closeDbForTests } from "../src/console/db/client";
import { tokenKeeper } from "../src/tokenkeeper";
import { useIsolatedDataDir } from "./console/helpers";

function codexToken(accountId: string, email: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("TokenKeeper OAuth lifecycle", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    useIsolatedDataDir();
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    tokenKeeper.stop();
    closeDbForTests();
  });

  test("completes Codex Authorization Code + PKCE and persists an OAuth account", async () => {
    const start = await tokenKeeper.startLogin("openai-codex", "Codex test account");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    expect(start.authorizationUrl).toContain("auth.openai.com/oauth/authorize");
    expect(start.authorizationUrl).toContain("code_challenge_method=S256");
    expect(start.authorizationUrl).not.toContain("device");
    expect(state).toBeTruthy();

    fetchSpy.mockResolvedValueOnce(response({
      access_token: codexToken("workspace-1", "operator@example.com"),
      refresh_token: "codex-refresh-token",
      expires_in: 3600,
    }));

    const status = await tokenKeeper.completeLogin(start.sessionId, `http://localhost:1455/auth/callback?code=auth-code&state=${encodeURIComponent(state!)}`);
    expect(status.status).toBe("completed");
    expect(status.accountId).toBeTruthy();

    const account = listAccounts("openai-codex")[0];
    expect(account?.credentialKind).toBe("oauth");
    expect(account?.credentialHint).toBe("operator@example.com");
    expect(account?.health?.status).toBe("healthy");
    expect(account?.health?.lastRefreshAt).toBeTruthy();
    expect(JSON.stringify(account)).not.toContain("codex-refresh-token");

    tokenKeeper.deleteCredential(status.accountId!);
  });

  test("refreshes an expired Codex credential and exposes sanitized 502 health", async () => {
    const account = createAccount({
      provider: "openai-codex",
      name: "Codex refresh account",
      credentialKind: "oauth",
      credential: JSON.stringify({
        version: 1,
        provider: "openai-codex",
        refreshToken: "refresh-before-rotation",
        accessToken: "expired-access",
        accessExpiresAt: Date.now() - 1,
        accountId: "workspace-2",
        email: "refresh@example.com",
        authorizedAt: Date.now(),
        updatedAt: Date.now(),
      }),
      credentialHint: "refresh@example.com",
    });
    fetchSpy.mockResolvedValueOnce(response({
      access_token: codexToken("workspace-2", "refresh@example.com"),
      refresh_token: "refresh-after-rotation",
      expires_in: 3600,
    }));

    const lease = await tokenKeeper.getTokenLease(account.id);
    expect(lease.accountId).toBe("workspace-2");
    expect(lease.accessToken).toContain("header.");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(listAccounts("openai-codex")[0]?.health?.status).toBe("healthy");

    tokenKeeper.recordProviderFailure(account.id, 502, "timeout", "gateway timeout Bearer secret-must-not-log");
    const failed = listAccounts("openai-codex")[0];
    expect(failed?.health?.status).toBe("error");
    expect(failed?.health?.statusCode).toBe(502);
    expect(failed?.health?.errorKind).toBe("timeout");
    expect(failed?.health?.sanitizedMessage).not.toContain("secret-must-not-log");

    tokenKeeper.deleteCredential(account.id);
  });

  test("completes Anthropic Authorization Code + PKCE with bootstrap identity", async () => {
    const start = await tokenKeeper.startLogin("anthropic-oauth", "Claude test account");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    expect(start.authorizationUrl).toContain("claude.ai/oauth/authorize");
    expect(start.authorizationUrl).toContain("user%3Ainference");

    fetchSpy
      .mockResolvedValueOnce(response({
        access_token: "anthropic-access-token",
        refresh_token: "anthropic-refresh-token",
        expires_in: 3600,
        account: { uuid: "anthropic-account", email_address: "claude@example.com" },
        organization: { uuid: "anthropic-org", name: "Operator Org" },
      }))
      .mockResolvedValueOnce(response({ oauth_account: { account_uuid: "anthropic-account", account_email: "claude@example.com", organization_uuid: "anthropic-org", organization_name: "Operator Org" } }));

    const status = await tokenKeeper.completeLogin(start.sessionId, `http://localhost:54545/callback?code=anthropic-code&state=${encodeURIComponent(state!)}`);
    expect(status.status).toBe("completed");
    expect(listAccounts("anthropic-oauth")[0]?.credentialKind).toBe("oauth");
    expect(listAccounts("anthropic-oauth")[0]?.credentialHint).toBe("claude@example.com");

    tokenKeeper.deleteCredential(status.accountId!);
  });
});

import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_GRANT_TTL_MS,
  AnthropicOAuthDriver,
} from "../../src/auth/oauth";
import { OAuthDriverError } from "../../src/auth/oauth";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Route {
  match: (url: string) => boolean;
  respond: () => Response;
}

function callAt(calls: readonly CapturedCall[], index: number): CapturedCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`missing captured call ${index}`);
  return call;
}

function stubFetch(routes: Route[]): { calls: CapturedCall[]; fetch: FetchStub } {
  const calls: CapturedCall[] = [];
  const fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const route = routes.find((candidate) => candidate.match(call.url));
    if (!route) throw new Error(`unexpected fetch call: ${call.url}`);
    return route.respond();
  }) as FetchStub;
  return { calls, fetch };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW_MS = 1_750_000_000_000;
const REDIRECT_URI = "http://127.0.0.1:54545/callback";

describe("AnthropicOAuthDriver.start", () => {
  test("builds the claude.ai authorization URL with PKCE and the Claude Code scopes", async () => {
    const driver = new AnthropicOAuthDriver();
    const result = await driver.start({ providerId: "claude", redirectUri: REDIRECT_URI, codeChallenge: "challenge-1", state: "state-1" });
    const url = new URL(result.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(result.state).toBe("state-1");
  });
});

describe("AnthropicOAuthDriver.exchange", () => {
  test("exchanges the code and lifts account and org identity from the token response", async () => {
    const { calls, fetch } = stubFetch([
      {
        match: (url) => url === "https://api.anthropic.com/v1/oauth/token",
        respond: () =>
          json({
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 28_800,
            account: { uuid: "acct-1", email_address: "dev@example.com" },
            organization: { uuid: "org-1", name: "Personal" },
          }),
      },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.exchange({ providerId: "claude", code: "code-1", state: "state-1", redirectUri: REDIRECT_URI, codeVerifier: "verifier-1" });

    const call = callAt(calls, 0);
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: "code-1",
      state: "state-1",
      redirect_uri: REDIRECT_URI,
      code_verifier: "verifier-1",
    });
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("application/json");

    expect(set.accessToken).toBe("at-1");
    expect(set.refreshToken).toBe("rt-1");
    expect(set.providerAccountId).toBe("acct-1");
    expect(set.email).toBe("dev@example.com");
    expect(set.orgId).toBe("org-1");
    expect(set.orgName).toBe("Personal");
    expect(new Date(set.expiresAt as string).getTime()).toBe(NOW_MS + 28_800_000 - 300_000);
    // Identity came from the token response: no bootstrap round-trip.
    expect(calls.length).toBe(1);
  });

  test("falls back to the Claude Code bootstrap endpoint for identity", async () => {
    const { calls, fetch } = stubFetch([
      {
        match: (url) => url === "https://api.anthropic.com/v1/oauth/token",
        respond: () => json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }),
      },
      {
        match: (url) => url.includes("/api/claude_cli/bootstrap"),
        respond: () =>
          json({
            oauth_account: {
              account_uuid: "acct-2",
              account_email: "boot@example.com",
              organization_uuid: "org-2",
              organization_name: "Team",
            },
          }),
      },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.exchange({ providerId: "claude", code: "code-2", redirectUri: REDIRECT_URI, codeVerifier: "verifier-2" });

    expect(set.providerAccountId).toBe("acct-2");
    expect(set.email).toBe("boot@example.com");
    expect(set.orgId).toBe("org-2");
    expect(set.orgName).toBe("Team");
    const bootstrapCall = callAt(calls, 1);
    expect(bootstrapCall.url).toContain("entrypoint=cli");
    expect(bootstrapCall.url).toContain("model=claude-opus-4-8");
    expect((bootstrapCall.init.headers as Record<string, string>).authorization).toBe("Bearer at-2");
    expect((bootstrapCall.init.headers as Record<string, string>)["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  test("degrades to the partial token-response identity when bootstrap fails", async () => {
    const { fetch } = stubFetch([
      { match: (url) => url === "https://api.anthropic.com/v1/oauth/token", respond: () => json({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600, account: { uuid: "acct-3" } }) },
      { match: (url) => url.includes("/api/claude_cli/bootstrap"), respond: () => new Response("boom", { status: 500 }) },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.exchange({ providerId: "claude", code: "code-3", redirectUri: REDIRECT_URI, codeVerifier: "verifier-3" });
    expect(set.providerAccountId).toBe("acct-3");
    expect(set.email).toBeUndefined();
  });

  test("rejects malformed token responses as validation errors", async () => {
    const { fetch } = stubFetch([
      { match: (url) => url === "https://api.anthropic.com/v1/oauth/token", respond: () => json({ access_token: "at-4", refresh_token: "rt-4" }) },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const failure = await driver.exchange({ providerId: "claude", code: "code-4", redirectUri: REDIRECT_URI, codeVerifier: "verifier-4" }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).kind).toBe("validation");
  });

  test("propagates token endpoint HTTP failures as typed driver errors", async () => {
    const { fetch } = stubFetch([
      { match: (url) => url === "https://api.anthropic.com/v1/oauth/token", respond: () => json({ error: "invalid_grant" }, 400) },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const failure = await driver.exchange({ providerId: "claude", code: "code-5", redirectUri: REDIRECT_URI, codeVerifier: "verifier-5" }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).status).toBe(400);
    expect((failure as OAuthDriverError).retryable).toBe(false);
  });
});

describe("AnthropicOAuthDriver.refresh", () => {
  test("refreshes with the Claude Code beta headers and rotates the refresh token", async () => {
    const { calls, fetch } = stubFetch([
      {
        match: (url) => url === "https://api.anthropic.com/v1/oauth/token",
        respond: () => json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800, account: { uuid: "acct-1", email_address: "dev@example.com" } }),
      },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.refresh({ providerId: "claude", accountId: "acct-1", refreshToken: "rt-old" });

    const call = callAt(calls, 0);
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ grant_type: "refresh_token", client_id: ANTHROPIC_OAUTH_CLIENT_ID, refresh_token: "rt-old" });
    const headers = call.init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["user-agent"]).toBeUndefined();

    expect(set.accessToken).toBe("at-new");
    expect(set.refreshToken).toBe("rt-new");
    expect(set.providerAccountId).toBe("acct-1");
    expect(set.email).toBe("dev@example.com");
    // Org identity is never re-read on refresh.
    expect(set.orgId).toBeUndefined();
    expect(set.orgName).toBeUndefined();
  });

  test("keeps the stored refresh token when the response omits rotation", async () => {
    const { fetch } = stubFetch([
      { match: (url) => url === "https://api.anthropic.com/v1/oauth/token", respond: () => json({ access_token: "at-new", expires_in: 3600 }) },
    ]);
    const driver = new AnthropicOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.refresh({ providerId: "claude", accountId: "acct-1", refreshToken: "rt-old" });
    expect(set.accessToken).toBe("at-new");
    expect(set.refreshToken).toBe("rt-old");
  });
});

describe("AnthropicOAuthDriver grant lifetime", () => {
  test("exposes the ~30-day grant family heuristic", () => {
    expect(ANTHROPIC_OAUTH_GRANT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

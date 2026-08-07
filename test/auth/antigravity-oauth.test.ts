import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_CALLBACK_URL,
  ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
  ANTIGRAVITY_SCOPES,
  AntigravityOAuthDriver,
  encodeAntigravityCredential,
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

/** Returns a fetch stub with canned routes plus every call it saw. */
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
const REDIRECT_URI = "http://127.0.0.1:51121/oauth-callback";

describe("AntigravityOAuthDriver.start", () => {
  test("builds the Google authorization URL with PKCE, offline access, and consent", async () => {
    const driver = new AntigravityOAuthDriver();
    const result = await driver.start({ providerId: "antigravity", redirectUri: REDIRECT_URI, codeChallenge: "challenge-1", state: "state-1" });
    const url = new URL(result.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(ANTIGRAVITY_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(result.state).toBe("state-1");
    expect(result.expiresAtMs).toBeGreaterThan(NOW_MS);
  });

  test("uses the registered localhost callback when redirect URI is omitted", async () => {
    const driver = new AntigravityOAuthDriver();
    const result = await driver.start({ providerId: "antigravity", codeChallenge: "challenge-1", state: "state-default" });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(ANTIGRAVITY_CALLBACK_URL);
  });

  test("generates state when none is supplied", async () => {
    const driver = new AntigravityOAuthDriver();
    const result = await driver.start({ providerId: "antigravity", redirectUri: REDIRECT_URI, codeChallenge: "challenge-1" });
    expect(result.state.length).toBeGreaterThan(0);
  });

  test("rejects start without a PKCE code challenge", async () => {
    const driver = new AntigravityOAuthDriver();
    const failure = await driver.start({ providerId: "antigravity", redirectUri: REDIRECT_URI }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).status).toBe(400);
  });
});

describe("AntigravityOAuthDriver.exchange", () => {
  test("exchanges the code with client credentials and returns the provisioned project id", async () => {
    const { calls, fetch } = stubFetch([
      { match: (url) => url === "https://oauth2.googleapis.com/token", respond: () => json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "cloud-platform" }) },
      { match: (url) => url.includes("userinfo"), respond: () => json({ email: "dev@example.com" }) },
      { match: (url) => url.endsWith("/v1internal:loadCodeAssist"), respond: () => json({ cloudaicompanionProject: "proj-123" }) },
    ]);
    const driver = new AntigravityOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.exchange({ providerId: "antigravity", code: "code-1", redirectUri: REDIRECT_URI });

    const tokenCall = callAt(calls, 0);
    expect(tokenCall.url).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = new URLSearchParams(tokenCall.init.body as string);
    expect(tokenBody.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(tokenBody.get("client_secret")).toBe(ANTIGRAVITY_CLIENT_SECRET);
    expect(tokenBody.get("code")).toBe("code-1");
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("redirect_uri")).toBe(REDIRECT_URI);

    expect(set.accessToken).toBe("at-1");
    expect(set.refreshToken).toBe("rt-1");
    expect(set.scope).toBe("cloud-platform");
    expect(set.providerAccountId).toBe("proj-123");
    expect(set.email).toBe("dev@example.com");
    // now + 3600s, skewed by the 5-minute refresh margin
    expect(new Date(set.expiresAt as string).getTime()).toBe(NOW_MS + 3_600_000 - 300_000);

    const loadCall = callAt(calls, 2);
    const loadBody = JSON.parse(loadCall.init.body as string) as Record<string, unknown>;
    expect(loadBody.metadata).toEqual(ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA);
    expect((loadCall.init.headers as Record<string, string>).authorization).toBe("Bearer at-1");
    expect(calls.length).toBe(3);
  });

  test("provisions a project via onboardUser when none exists, picking the default tier", async () => {
    let onboardCount = 0;
    const { calls, fetch } = stubFetch([
      { match: (url) => url === "https://oauth2.googleapis.com/token", respond: () => json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }) },
      { match: (url) => url.includes("userinfo"), respond: () => new Response("not json", { status: 500 }) },
      { match: (url) => url.endsWith("/v1internal:loadCodeAssist"), respond: () => json({ allowedTiers: [{ id: "tier-a" }, { id: "tier-b", isDefault: true }] }) },
      {
        match: (url) => url.endsWith("/v1internal:onboardUser"),
        respond: () => {
          onboardCount += 1;
          if (onboardCount === 1) return json({ done: false });
          return json({ done: true, response: { cloudaicompanionProject: { id: "proj-new" } } });
        },
      },
    ]);
    const driver = new AntigravityOAuthDriver({ fetch, nowMs: () => NOW_MS, onboardingIntervalMs: 1 });
    const set = await driver.exchange({ providerId: "antigravity", code: "code-2", redirectUri: REDIRECT_URI });

    expect(set.providerAccountId).toBe("proj-new");
    expect(set.email).toBeUndefined();
    expect(onboardCount).toBe(2);
    const onboardBody = JSON.parse(callAt(calls, 3).init.body as string) as Record<string, unknown>;
    expect(onboardBody.tierId).toBe("tier-b");
    expect(onboardBody.metadata).toEqual(ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA);
  });

  test("fails with a provisioning error when onboarding never yields a project", async () => {
    const { calls, fetch } = stubFetch([
      { match: (url) => url === "https://oauth2.googleapis.com/token", respond: () => json({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 }) },
      { match: (url) => url.includes("userinfo"), respond: () => json({}) },
      { match: (url) => url.endsWith("/v1internal:loadCodeAssist"), respond: () => json({}) },
      { match: (url) => url.endsWith("/v1internal:onboardUser"), respond: () => json({ done: false }) },
    ]);
    const driver = new AntigravityOAuthDriver({ fetch, nowMs: () => NOW_MS, onboardingIntervalMs: 0, onboardingMaxAttempts: 3 });
    const failure = await driver.exchange({ providerId: "antigravity", code: "code-3", redirectUri: REDIRECT_URI }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).kind).toBe("provisioning");
    expect(calls.filter((call) => call.url.endsWith("/v1internal:onboardUser")).length).toBe(3);
  });

  test("propagates token endpoint failures as typed driver errors", async () => {
    const { fetch } = stubFetch([
      { match: (url) => url === "https://oauth2.googleapis.com/token", respond: () => json({ error: "invalid_client" }, 401) },
    ]);
    const driver = new AntigravityOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const failure = await driver.exchange({ providerId: "antigravity", code: "code-4", redirectUri: REDIRECT_URI }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OAuthDriverError);
    expect((failure as OAuthDriverError).status).toBe(401);
    expect((failure as OAuthDriverError).retryable).toBe(false);
  });
});

describe("AntigravityOAuthDriver.refresh", () => {
  test("refreshes with client credentials and keeps the existing refresh token when rotation is absent", async () => {
    const { calls, fetch } = stubFetch([
      { match: (url) => url === "https://oauth2.googleapis.com/token", respond: () => json({ access_token: "at-new", expires_in: 1800 }) },
    ]);
    const driver = new AntigravityOAuthDriver({ fetch, nowMs: () => NOW_MS });
    const set = await driver.refresh({ providerId: "antigravity", accountId: "proj-123", refreshToken: "rt-old" });

    const body = new URLSearchParams(callAt(calls, 0).init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old");
    expect(body.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(body.get("client_secret")).toBe(ANTIGRAVITY_CLIENT_SECRET);

    expect(set.accessToken).toBe("at-new");
    expect(set.refreshToken).toBe("rt-old");
    expect(new Date(set.expiresAt as string).getTime()).toBe(NOW_MS + 1_800_000 - 300_000);
  });
});

describe("encodeAntigravityCredential", () => {
  test("round-trips the composite request credential the adapter accepts", () => {
    const encoded = encodeAntigravityCredential("at-1", "proj-123");
    expect(JSON.parse(encoded)).toEqual({ accessToken: "at-1", projectId: "proj-123" });
  });
});

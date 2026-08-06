import { describe, expect, test } from "bun:test";
import { KiroOAuthDriver, parseKiroCredential } from "../../src/auth/oauth/kiro";
import { OAuthDriverError } from "../../src/auth/oauth/base";
import type { OAuthFetch } from "../../src/auth/oauth/base";

const START_NOW_MS = Date.parse("2026-08-04T12:00:00.000Z");

interface RouteHandler {
  (url: string, init: RequestInit): Response;
}

function fakeFetch(handlers: Array<{ match: (url: string) => boolean; respond: RouteHandler }>): OAuthFetch {
  return async (input, init = {}) => {
    const url = String(input);
    for (const handler of handlers) {
      if (handler.match(url)) return handler.respond(url, init);
    }
    return new Response("not found", { status: 404 });
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function registerHandler(): { match: (url: string) => boolean; respond: RouteHandler } {
  return {
    match: (url) => url.includes("/client/register"),
    respond: () => jsonResponse({ clientId: "cid-1", clientSecret: "csec-1" }),
  };
}

function deviceHandler(): { match: (url: string) => boolean; respond: RouteHandler } {
  return {
    match: (url) => url.includes("/device_authorization"),
    respond: () =>
      jsonResponse({
        deviceCode: "dc-1",
        userCode: "UC-1234",
        verificationUriComplete: "https://view.awsapps.com/start/activate?user_code=UC-1234",
        interval: 5,
        expiresIn: 600,
      }),
  };
}

function tokenHandler(respond: RouteHandler): { match: (url: string) => boolean; respond: RouteHandler } {
  return { match: (url) => url.endsWith("/token"), respond };
}

function makeDriver(
  handlers: Array<{ match: (url: string) => boolean; respond: RouteHandler }>,
  options: { nowMs?: () => number; maxSessions?: number; defaultRegion?: string } = {},
): KiroOAuthDriver {
  return new KiroOAuthDriver({
    fetch: fakeFetch(handlers),
    nowMs: options.nowMs ?? (() => START_NOW_MS),
    maxSessions: options.maxSessions,
    defaultRegion: options.defaultRegion,
  });
}

describe("KiroOAuthDriver start (device flow)", () => {
  test("registers a public client, starts device authorization, and stores a session", async () => {
    const registerBody: Record<string, unknown>[] = [];
    const deviceBody: Record<string, unknown>[] = [];
    const driver = makeDriver([
      {
        match: (url) => url.includes("/client/register"),
        respond: (url, init) => {
          registerBody.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ clientId: "cid-1", clientSecret: "csec-1" });
        },
      },
      {
        match: (url) => url.includes("/device_authorization"),
        respond: (url, init) => {
          deviceBody.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ deviceCode: "dc-1", userCode: "UC-1234", verificationUriComplete: "https://view.awsapps.com/start/activate?user_code=UC-1234", interval: 5, expiresIn: 600 });
        },
      },
    ]);
    const result = await driver.start({ providerId: "kiro" });
    expect(result.userCode).toBe("UC-1234");
    expect(result.verificationUri).toBe("https://view.awsapps.com/start/activate?user_code=UC-1234");
    expect(result.authorizationUrl).toBe(result.verificationUri);
    expect(result.intervalSeconds).toBe(5);
    expect(result.expiresAtMs).toBe(START_NOW_MS + 600_000);
    expect(result.state.length).toBeGreaterThan(0);
    expect(driver.sessionCount()).toBe(1);
    const registration = registerBody[0] as Record<string, unknown>;
    expect(registration.clientName).toBe("kiro-oauth-client");
    expect(registration.clientType).toBe("public");
    expect(registration.grantTypes).toEqual(["device_code", "refresh_token"]);
    expect(registration.scopes).toEqual(["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"]);
    const device = deviceBody[0] as Record<string, unknown>;
    expect(device).toEqual({ clientId: "cid-1", clientSecret: "csec-1", startUrl: "https://view.awsapps.com/start" });
  });

  test("honors an injected state as the session id", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler()]);
    const result = await driver.start({ providerId: "kiro", state: "sess-abc" });
    expect(result.state).toBe("sess-abc");
    expect(driver.sessionCount()).toBe(1);
  });

  test("rejects starting a non-kiro provider", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler()]);
    await expect(driver.start({ providerId: "grok" })).rejects.toBeInstanceOf(OAuthDriverError);
  });

  test("evicts the oldest session past the bounded cap", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler()], { maxSessions: 1 });
    const first = await driver.start({ providerId: "kiro" });
    await driver.start({ providerId: "kiro" });
    expect(driver.sessionCount()).toBe(1);
    expect(await driver.poll(first.state)).toEqual({ status: "expired" });
  });
});

describe("KiroOAuthDriver poll", () => {
  test("returns pending while the token endpoint reports authorization_pending", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler(), tokenHandler(() => jsonResponse({ error: "authorization_pending" }, 400))]);
    const { state } = await driver.start({ providerId: "kiro" });
    expect(await driver.poll(state)).toEqual({ status: "pending", intervalSeconds: 5 });
    expect(driver.sessionCount()).toBe(1);
  });

  test("returns pending on slow_down and on an empty error field", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler(), tokenHandler(() => jsonResponse({ error: "slow_down" }, 400))]);
    const { state } = await driver.start({ providerId: "kiro" });
    expect(await driver.poll(state)).toEqual({ status: "pending", intervalSeconds: 5 });
    const driver2 = makeDriver([registerHandler(), deviceHandler(), tokenHandler(() => jsonResponse({}, 400))]);
    const second = await driver2.start({ providerId: "kiro" });
    expect(await driver2.poll(second.state)).toEqual({ status: "pending", intervalSeconds: 5 });
  });

  test("completes with a token set carrying the device metadata and consumes the session", async () => {
    const sent: Record<string, unknown>[] = [];
    const driver = makeDriver([
      registerHandler(),
      deviceHandler(),
      {
        match: (url) => url.endsWith("/token"),
        respond: (url, init) => {
          sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ refreshToken: "rt-1", accessToken: "at-1", expiresIn: 3600 });
        },
      },
    ]);
    const { state } = await driver.start({ providerId: "kiro" });
    const result = await driver.poll(state);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.tokenSet.accessToken).toBe("at-1");
    expect(result.tokenSet.refreshToken).toBe("rt-1");
    expect(result.tokenSet.expiresAt).toBe(new Date(START_NOW_MS + 3600_000).toISOString());
    expect(result.tokenSet.region).toBe("us-east-1");
    expect(result.tokenSet.authMethod).toBe("builder-id");
    expect(result.tokenSet.clientId).toBe("cid-1");
    expect(result.tokenSet.clientSecret).toBe("csec-1");
    expect(driver.sessionCount()).toBe(0);
    const grant = sent[0] as Record<string, unknown>;
    expect(grant.grantType).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(grant.deviceCode).toBe("dc-1");
  });

  test("reports expired for unknown or past-deadline sessions", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler()]);
    expect(await driver.poll("no-such-session")).toEqual({ status: "expired" });
    const clock = { now: START_NOW_MS };
    const timeTravel = makeDriver([registerHandler(), deviceHandler()], { nowMs: () => clock.now });
    const { state } = await timeTravel.start({ providerId: "kiro" });
    clock.now = START_NOW_MS + 601_000;
    expect(await timeTravel.poll(state)).toEqual({ status: "expired" });
  });

  test("throws a typed error on non-pending upstream failures", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler(), tokenHandler(() => jsonResponse({ error: "invalid_grant" }, 400))]);
    const { state } = await driver.start({ providerId: "kiro" });
    const error = await driver.poll(state).catch((caught) => caught);
    expect(error).toBeInstanceOf(OAuthDriverError);
    expect((error as OAuthDriverError).status).toBe(400);
  });
});

describe("KiroOAuthDriver exchange", () => {
  test("completes the flow through the contract exchange path", async () => {
    const driver = makeDriver([
      registerHandler(),
      deviceHandler(),
      tokenHandler(() => jsonResponse({ refreshToken: "rt-1", accessToken: "at-1", expiresIn: 3600 })),
    ]);
    const { state } = await driver.start({ providerId: "kiro" });
    const tokenSet = await driver.exchange({ providerId: "kiro", code: "dc-1", state });
    expect(tokenSet.accessToken).toBe("at-1");
    expect(tokenSet.refreshToken).toBe("rt-1");
    expect(driver.sessionCount()).toBe(0);
  });

  test("fails with a typed error when the session is missing or expired", async () => {
    const driver = makeDriver([registerHandler(), deviceHandler()]);
    const error = await driver.exchange({ providerId: "kiro", code: "dc-1", state: "gone" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(OAuthDriverError);
    expect((error as OAuthDriverError).status).toBe(410);
  });
});

describe("KiroOAuthDriver refresh", () => {
  test("refreshes through the desktop endpoint under the contract shape", async () => {
    const sent: Record<string, unknown>[] = [];
    const driver = makeDriver([
      {
        match: (url) => url.includes("/refreshToken"),
        respond: (url, init) => {
          sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ accessToken: "at-refreshed", expiresIn: 3600 });
        },
      },
    ]);
    const tokenSet = await driver.refresh({ providerId: "kiro", accountId: "acc-1", refreshToken: "rt-1" });
    expect(sent[0]).toEqual({ refreshToken: "rt-1" });
    expect(tokenSet.accessToken).toBe("at-refreshed");
    expect(tokenSet.refreshToken).toBe("rt-1");
    expect(tokenSet.expiresAt).toBe(new Date(START_NOW_MS + 3600_000).toISOString());
  });

  test("refreshBundle prefers the regional endpoint when client credentials are stored", async () => {
    const urls: string[] = [];
    const driver = makeDriver([
      {
        match: (url) => url.includes("oidc.eu-west-1.amazonaws.com/token"),
        respond: (url, init) => {
          urls.push(url);
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          expect(body.grantType).toBe("refresh_token");
          expect(body.clientId).toBe("cid-1");
          return jsonResponse({ accessToken: "at-regional", expiresIn: 900 });
        },
      },
    ]);
    const refreshed = await driver.refreshBundle({ accessToken: "old", refreshToken: "rt-1", clientId: "cid-1", clientSecret: "csec-1", region: "eu-west-1", authMethod: "builder-id" });
    expect(urls).toEqual(["https://oidc.eu-west-1.amazonaws.com/token"]);
    expect(refreshed.accessToken).toBe("at-regional");
    expect(refreshed.refreshToken).toBe("rt-1");
    expect(refreshed.authMethod).toBe("builder-id");
    expect(refreshed.expiresAt).toBe(new Date(START_NOW_MS + 900_000).toISOString());
  });

  test("refreshBundle falls back to the desktop endpoint without client credentials", async () => {
    const urls: string[] = [];
    const driver = makeDriver([
      {
        match: (url) => url.includes("/refreshToken"),
        respond: (url) => {
          urls.push(url);
          return jsonResponse({ accessToken: "at-desktop", expiresIn: 3600 });
        },
      },
    ]);
    const refreshed = await driver.refreshBundle({ accessToken: "old", refreshToken: "rt-1" });
    expect(urls).toEqual(["https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"]);
    expect(refreshed.accessToken).toBe("at-desktop");
  });

  test("rejects bundles without a refresh token", async () => {
    const driver = makeDriver([]);
    const error = await driver.refreshBundle({ accessToken: "at-1" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(OAuthDriverError);
    expect((error as OAuthDriverError).status).toBe(400);
  });
});

describe("KiroOAuthDriver buildHeaders", () => {
  test("emits the bearer header plus token-type headers for api_key and external_idp", () => {
    const driver = makeDriver([]);
    expect(driver.buildHeaders({ providerId: "kiro", accountId: null, credential: "plain-token" })).toMatchObject({ authorization: "Bearer plain-token" });
    const apiKey = driver.buildHeaders({ providerId: "kiro", accountId: null, credential: JSON.stringify({ accessToken: "at-1", authMethod: "api_key" }) });
    expect(apiKey.authorization).toBe("Bearer at-1");
    expect(apiKey.tokentype).toBe("API_KEY");
    const external = driver.buildHeaders({ providerId: "kiro", accountId: null, credential: JSON.stringify({ accessToken: "at-1", authMethod: "external_idp" }) });
    expect(external.TokenType).toBe("EXTERNAL_IDP");
  });

  test("rejects empty credentials", () => {
    const driver = makeDriver([]);
    expect(() => driver.buildHeaders({ providerId: "kiro", accountId: null, credential: "" })).toThrow(OAuthDriverError);
  });
});

describe("parseKiroCredential", () => {
  test("parses the persisted bundle and tolerates snake_case token keys", () => {
    const bundle = parseKiroCredential(JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1", authMethod: "idc", region: "eu-west-1", clientId: "cid-1", clientSecret: "csec-1", profileArn: "arn:profile/1" }));
    expect(bundle).toEqual({ accessToken: "at-1", refreshToken: "rt-1", authMethod: "idc", region: "eu-west-1", clientId: "cid-1", clientSecret: "csec-1", profileArn: "arn:profile/1" });
    const snake = parseKiroCredential(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2" }));
    expect(snake?.accessToken).toBe("at-2");
    expect(snake?.refreshToken).toBe("rt-2");
  });

  test("returns null for raw tokens and non-bundle JSON", () => {
    expect(parseKiroCredential("raw-token")).toBeNull();
    expect(parseKiroCredential(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseKiroCredential("not json at all")).toBeNull();
  });
});

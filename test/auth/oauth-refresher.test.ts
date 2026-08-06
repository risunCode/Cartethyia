import { describe, expect, test } from "bun:test";
import type { OAuthRefresher } from "../../src/auth/credentials";
import type { OAuthFetch } from "../../src/auth/oauth/base";
import type { AuthDriverRegistry } from "../../src/auth/drivers";
import type { AuthDriver } from "../../src/auth";
import { MapAuthDriverRegistry, OAuthDriverError, createDriverAwareOAuthRefresher, createEnvOAuthRefresher } from "../../src/auth";

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PUBLIC_LOOKUP: (h: string) => Promise<readonly { address: string }[]> = async () => [{ address: "8.8.8.8" }];

describe("createEnvOAuthRefresher", () => {
  const env = {
    CARTETHYIA_OAUTH_CLAUDE_TOKEN_URL: "https://auth.example.com/token",
    CARTETHYIA_OAUTH_CLAUDE_CLIENT_ID: "cid",
    CARTETHYIA_OAUTH_CLAUDE_CLIENT_SECRET: "csecret",
  };

  test("refreshes a token with bounded parse", async () => {
    const fetchFn: OAuthFetch = async () => jsonResponse(200, { access_token: "tok-1", expires_in: 3600, refresh_token: "rt-2" });
    const r = createEnvOAuthRefresher({ resolveProvider: async () => "claude", env, fetchFn, lookup: PUBLIC_LOOKUP, nowMs: () => 1_000_000 });
    const result = await r.refresh({ accountId: "acc", token: { accessToken: "old", refreshToken: "rt-1", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.accessToken).toBe("tok-1");
      expect(result.token.refreshToken).toBe("rt-2");
      expect(result.token.expiresAtMs).toBe(1_000_000 + 3600 * 1000);
    }
  });

  test("keeps previous refresh token when not rotated", async () => {
    const fetchFn: OAuthFetch = async () => jsonResponse(200, { access_token: "tok-2" });
    const r = createEnvOAuthRefresher({ resolveProvider: async () => "claude", env, fetchFn, lookup: PUBLIC_LOOKUP });
    const result = await r.refresh({ accountId: "acc", token: { accessToken: "old", refreshToken: "rt-keep", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.refreshToken).toBe("rt-keep");
  });

  test("unavailable token or missing config", async () => {
    const r = createEnvOAuthRefresher({ resolveProvider: async () => "claude", env, fetchFn: async () => jsonResponse(200, {}), lookup: PUBLIC_LOOKUP });
    const noProvider = await r.refresh({ accountId: "x", token: null });
    expect(noProvider.ok).toBe(false);
    const noRefresh = await r.refresh({ accountId: "x", token: { accessToken: "a", refreshToken: null, expiresAtMs: null, kind: "oauth" } });
    expect(noRefresh.ok).toBe(false);

    const r2 = createEnvOAuthRefresher({ resolveProvider: async () => "unsetprovider", env: {}, fetchFn: async () => jsonResponse(200, {}), lookup: PUBLIC_LOOKUP });
    const missingConfig = await r2.refresh({ accountId: "x", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(missingConfig.ok).toBe(false);
  });

  test("HTTP 401 maps to authentication_failed, non-ok server to provider_unavailable", async () => {
    const r401 = createEnvOAuthRefresher({ resolveProvider: async () => "claude", env, fetchFn: async () => jsonResponse(401, { error: "bad" }), lookup: PUBLIC_LOOKUP });
    const res401 = await r401.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(res401.ok).toBe(false);
    if (!res401.ok) expect(res401.error.kind).toBe("authentication_failed");

    const r500 = createEnvOAuthRefresher({ resolveProvider: async () => "claude", env, fetchFn: async () => jsonResponse(500, {}), lookup: PUBLIC_LOOKUP });
    const res500 = await r500.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(res500.ok).toBe(false);
    if (!res500.ok) expect(res500.error.kind).toBe("provider_unavailable");
  });

  test("invalid token body maps to protocol error", async () => {
    const r = createEnvOAuthRefresher({ resolveProvider: async () => "claude", env, fetchFn: async () => jsonResponse(200, { no_access_token: true }), lookup: PUBLIC_LOOKUP });
    const result = await r.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("provider_protocol_error");
  });
});

function driver(overrides: Partial<AuthDriver>): AuthDriver {
  return { kind: "oauth", buildHeaders: () => ({}), ...overrides };
}

describe("driver-aware OAuth refresher", () => {
  test("refreshes through the provider driver and normalizes the token record", async () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", driver({ refresh: async () => ({ accessToken: "new-access", refreshToken: "rotated-refresh", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }));
    const refresher = createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => "codex" });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.accessToken).toBe("new-access");
      expect(result.token.refreshToken).toBe("rotated-refresh");
      expect(result.token.expiresAtMs).toBeGreaterThan(Date.now());
    }
  });

  test("keeps the previous refresh token when the driver does not rotate it", async () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", driver({ refresh: async () => ({ accessToken: "new-access", expiresAt: new Date().toISOString() }) }));
    const refresher = createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => "codex" });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "keep-refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.refreshToken).toBe("keep-refresh");
  });

  test("maps a 401 driver failure to a non-retryable authentication failure", async () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", driver({ refresh: async () => { throw new OAuthDriverError("auth", "refresh rejected", 401, false); } }));
    const refresher = createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => "codex" });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("authentication_failed");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("maps a retryable 5xx driver failure and bounds the message", async () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", driver({ refresh: async () => { throw new OAuthDriverError("upstream", "x".repeat(500), 503, true); } }));
    const refresher = createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => "codex" });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("provider_unavailable");
      expect(result.error.retryable).toBe(true);
      expect(result.error.sanitizedMessage.length).toBeLessThanOrEqual(245);
    }
  });

  test("falls back to the bounded env refresher when no driver is registered", async () => {
    const registry = new MapAuthDriverRegistry();
    const fallback = createEnvOAuthRefresher({
      resolveProvider: async () => "sample",
      env: { CARTETHYIA_OAUTH_SAMPLE_TOKEN_URL: "https://token.example.com/refresh", CARTETHYIA_OAUTH_SAMPLE_CLIENT_ID: "client", CARTETHYIA_OAUTH_SAMPLE_CLIENT_SECRET: "secret" },
      lookup: async () => [{ address: "93.184.216.34" }],
      fetchFn: async () => new Response(JSON.stringify({ access_token: "env-access", refresh_token: "env-refresh", expires_in: 3_600 }), { status: 200 }),
    });
    const refresher = createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => "sample", fallback });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.accessToken).toBe("env-access");
      expect(result.token.refreshToken).toBe("env-refresh");
    }
  });

  test("fails with credential_unavailable when neither driver nor fallback handles the provider", async () => {
    const refresher = createDriverAwareOAuthRefresher({ drivers: new MapAuthDriverRegistry(), resolveProvider: async () => "unknown" });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("credential_unavailable");
  });

  test("rejects an unusable driver token record without persisting", async () => {
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", driver({ refresh: async () => ({ accessToken: "", expiresAt: new Date().toISOString() }) }));
    const refresher = createDriverAwareOAuthRefresher({ drivers: registry, resolveProvider: async () => "codex" });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
  });
});

describe("bounded env OAuth refresher", () => {
  test("rejects an oversized response body", async () => {
    const refresher = createEnvOAuthRefresher({
      resolveProvider: async () => "sample",
      env: { CARTETHYIA_OAUTH_SAMPLE_TOKEN_URL: "https://token.example.com/refresh", CARTETHYIA_OAUTH_SAMPLE_CLIENT_ID: "client", CARTETHYIA_OAUTH_SAMPLE_CLIENT_SECRET: "secret" },
      fetchFn: async () => new Response(JSON.stringify({ access_token: "a".repeat(4_000), expires_in: 60 }), { status: 200 }),
      lookup: async () => [{ address: "93.184.216.34" }],
      maxBytes: 1_024,
    });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("provider_protocol_error");
  });

  test("rejects a non-HTTPS token URL through the SSRF guard", async () => {
    const refresher = createEnvOAuthRefresher({
      resolveProvider: async () => "sample",
      env: { CARTETHYIA_OAUTH_SAMPLE_TOKEN_URL: "http://token.example.com/refresh", CARTETHYIA_OAUTH_SAMPLE_CLIENT_ID: "client", CARTETHYIA_OAUTH_SAMPLE_CLIENT_SECRET: "secret" },
    });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("credential_unavailable");
  });

  test("rejects a 401 token endpoint response as authentication failure", async () => {
    const refresher = createEnvOAuthRefresher({
      resolveProvider: async () => "sample",
      env: { CARTETHYIA_OAUTH_SAMPLE_TOKEN_URL: "https://token.example.com/refresh", CARTETHYIA_OAUTH_SAMPLE_CLIENT_ID: "client", CARTETHYIA_OAUTH_SAMPLE_CLIENT_SECRET: "secret" },
      fetchFn: async () => new Response("denied", { status: 401 }),
      lookup: async () => [{ address: "93.184.216.34" }],
    });
    const result = await refresher.refresh({ accountId: "account-1", token: { accessToken: "old", refreshToken: "refresh", expiresAtMs: 1, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("authentication_failed");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("createDriverAwareOAuthRefresher", () => {
  function registry(driver?: { refresh: (i: { providerId: string; refreshToken: string }) => Promise<{ accessToken: string; refreshToken?: string }> }): AuthDriverRegistry {
    return {
      get: () => (driver ? { kind: "oauth", refresh: driver.refresh, buildHeaders: () => ({}) } : null),
      has: () => driver !== undefined,
      list: () => [],
      register: () => {},
    } as unknown as AuthDriverRegistry;
  }

  test("uses registered driver", async () => {
    const driver = { refresh: async () => ({ accessToken: "tok-driver", refreshToken: "rt-driver" }) };
    const r = createDriverAwareOAuthRefresher({ drivers: registry(driver), resolveProvider: async () => "codex" });
    const result = await r.refresh({ accountId: "a", token: { accessToken: "old", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.accessToken).toBe("tok-driver");
  });

  test("missing provider id → credential_unavailable", async () => {
    const r = createDriverAwareOAuthRefresher({ drivers: registry(), resolveProvider: async () => null });
    const result = await r.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("credential_unavailable");
  });

  test("driver missing refresh token → credential_unavailable", async () => {
    const driver = { refresh: async () => ({ accessToken: "t" }) };
    const r = createDriverAwareOAuthRefresher({ drivers: registry(driver), resolveProvider: async () => "codex" });
    const result = await r.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: null, expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("credential_unavailable");
  });

  test("falls back when no driver registered", async () => {
    const fallback: OAuthRefresher = {
      refresh: async () => ({ ok: true, token: { accessToken: "fb", refreshToken: null, expiresAtMs: null, kind: "oauth" } }),
    };
    const r = createDriverAwareOAuthRefresher({ drivers: registry(), resolveProvider: async () => "claude", fallback });
    const result = await r.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.accessToken).toBe("fb");
  });

  test("driver 401 → authentication_failed, no driver & no fallback → credential_unavailable", async () => {
    const badDriver = {
      refresh: async () => {
        throw new OAuthDriverError("auth", "bad creds", 401, false);
      },
    };
    const r = createDriverAwareOAuthRefresher({ drivers: registry(badDriver), resolveProvider: async () => "codex" });
    const result = await r.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("authentication_failed");

    const rNo = createDriverAwareOAuthRefresher({ drivers: registry(), resolveProvider: async () => "claude" });
    const resNo = await rNo.refresh({ accountId: "a", token: { accessToken: "a", refreshToken: "rt", expiresAtMs: null, kind: "oauth" } });
    expect(resNo.ok).toBe(false);
    if (!resNo.ok) expect(resNo.error.kind).toBe("credential_unavailable");
  });
});

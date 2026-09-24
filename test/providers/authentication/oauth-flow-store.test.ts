import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RedisClient } from "../../../src/persistence/redis";
import {
  generateOAuthState,
  generatePkcePair,
  OAuthFlowStore,
  readJsonResponse,
  type DeviceFlowCorrelation,
  type PendingOAuthFlow,
} from "../../../src/providers/authentication/oauth-flow-store";
import { oauthCallbackUrl, requirePublicOrigin } from "../../../src/config";
import { classifyOAuthRefreshFailure } from "../../../src/providers/authentication/oauth-refresh-service";

function fakeRedis(shared?: Map<string, string>): RedisClient {
  const store = shared ?? new Map<string, string>();
  const nextTick = () => Promise.resolve();
  return {
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => {
      await nextTick();
      return store.get(key) ?? null;
    },
    del: async (key: string) => {
      await nextTick();
      const existed = store.delete(key);
      return existed ? 1 : 0;
    },
    eval: async (_script: string, _numKeys: number, ...args: string[]) => {
      await nextTick();
      // Only our atomic consume script is expected: GET+DEL atomically
      const key = args[0];
      if (!key) return null;
      const v = store.get(key) ?? null;
      if (v) store.delete(key);
      return v;
    },
  } as unknown as RedisClient;
}

const samplePending: PendingOAuthFlow = {
  providerId: "claude",
  codeVerifier: "verifier-123",
  accountLabel: "team-account",
  tenantId: null,
  redirectUri: "http://127.0.0.1:59653/callback",
};

const sampleDevice: DeviceFlowCorrelation = {
  providerId: "codex",
  accountLabel: "work-account",
  tenantId: "tenant-1",
};

const sampleDeviceState: Record<string, unknown> = {
  deviceAuthId: "device-123",
  userCode: "ABCD-1234",
  intervalSeconds: 5,
};

describe("client-kit.test.ts", () => {
  const ORIGINAL = process.env.CARTETHYIA_PUBLIC_ORIGIN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
    else process.env.CARTETHYIA_PUBLIC_ORIGIN = ORIGINAL;
  });

  describe("generatePkcePair", () => {
    test("produces a URL-safe verifier with no padding", () => {
      const { codeVerifier } = generatePkcePair();
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    });

    test("challenge is the S256 hash of the verifier", () => {
      const { codeVerifier, codeChallenge } = generatePkcePair();
      const expected = createHash("sha256")
        .update(codeVerifier)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(codeChallenge).toBe(expected);
    });

    test("generates distinct pairs on each call", () => {
      const a = generatePkcePair();
      const b = generatePkcePair();
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });
  });

  describe("generateOAuthState", () => {
    test("produces a URL-safe opaque token", () => {
      const state = generateOAuthState();
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test("generates distinct values on each call", () => {
      expect(generateOAuthState()).not.toBe(generateOAuthState());
    });
  });

  describe("requirePublicOrigin", () => {
    test("throws when unset", () => {
      delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
      expect(() => requirePublicOrigin()).toThrow("CARTETHYIA_PUBLIC_ORIGIN");
    });

    test("strips a trailing slash", () => {
      process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://cartethyia.example.com/";
      expect(requirePublicOrigin()).toBe("https://cartethyia.example.com");
    });
  });

  describe("oauthCallbackUrl", () => {
    test("builds the fixed per-provider callback path", () => {
      process.env.CARTETHYIA_PUBLIC_ORIGIN = "https://cartethyia.example.com";
      expect(oauthCallbackUrl("claude")).toBe(
        "https://cartethyia.example.com/console/api/providers/claude/oauth/callback",
      );
    });
  });

  describe("readJsonResponse", () => {
    test("retains a bounded error body for OAuth failure classification", async () => {
      const body = `invalid_grant${"x".repeat(600)}`;
      await expect(readJsonResponse(new Response(body, { status: 400 }), "OAuth")).rejects.toThrow(
        body.slice(0, 500),
      );
    });
  });
});

describe("oauth-flow-store.test.ts", () => {
  describe("OAuthFlowStore — pending (single-use)", () => {
    test("round-trips a saved flow through consumePending", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.savePending("state-1", samplePending);
      const consumed = await store.consumePending("state-1");
      expect(consumed).toEqual(samplePending);
    });

    test("consuming a state deletes it — a second consume returns undefined", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.savePending("state-1", samplePending);
      await store.consumePending("state-1");
      const second = await store.consumePending("state-1");
      expect(second).toBeUndefined();
    });

    test("consuming an unknown state returns undefined", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      const consumed = await store.consumePending("never-saved");
      expect(consumed).toBeUndefined();
    });

    test("different states do not collide", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.savePending("state-a", { ...samplePending, providerId: "codex" });
      await store.savePending("state-b", { ...samplePending, providerId: "cursor" });
      expect((await store.consumePending("state-a"))?.providerId).toBe("codex");
      expect((await store.consumePending("state-b"))?.providerId).toBe("cursor");
    });

    test("atomic consume-once: two concurrent consumers, only one wins", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.savePending("race-state", samplePending);
      const [first, second] = await Promise.all([
        store.consumePending("race-state"),
        store.consumePending("race-state"),
      ]);
      const successes = [first, second].filter((v) => v !== undefined);
      const failures = [first, second].filter((v) => v === undefined);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(successes[0]).toEqual(samplePending);
    });
  });

  describe("OAuthFlowStore — device (repeatable)", () => {
    test("get returns the saved correlation without deleting it", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.saveDevice("device-1", sampleDevice);
      expect(await store.getDevice("device-1")).toEqual(sampleDevice);
      expect(await store.getDevice("device-1")).toEqual(sampleDevice);
    });

    test("get returns undefined for an unknown deviceAuthId", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      expect(await store.getDevice("missing")).toBeUndefined();
    });

    test("delete removes the correlation", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.saveDevice("device-1", sampleDevice);
      await store.deleteDevice("device-1");
      expect(await store.getDevice("device-1")).toBeUndefined();
    });
  });

  describe("OAuthFlowStore — device start state (Redis-backed, survives restart)", () => {
    test("round-trips provider-private device state", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.saveDeviceState("codex-1", sampleDeviceState);
      expect(await store.getDeviceState("codex-1")).toEqual(sampleDeviceState);
      await store.deleteDeviceState("codex-1");
      expect(await store.getDeviceState("codex-1")).toBeUndefined();
    });

    test("device state survives what simulates a restart (fresh store instance, same Redis backing)", async () => {
      const shared = new Map<string, string>();
      const storeA = new OAuthFlowStore(fakeRedis(shared));
      await storeA.saveDevice("device-1", sampleDevice);
      await storeA.saveDeviceState("codex-1", sampleDeviceState);
      await storeA.savePending("state-1", samplePending);

      // Simulate restart: new store instance with same backing map
      const storeB = new OAuthFlowStore(fakeRedis(shared));
      expect(await storeB.getDevice("device-1")).toEqual(sampleDevice);
      expect(await storeB.getDeviceState("codex-1")).toEqual(sampleDeviceState);
      expect(await storeB.consumePending("state-1")).toEqual(samplePending);
    });

    test("different kinds do not collide (pending vs device vs device-state)", async () => {
      const store = new OAuthFlowStore(fakeRedis());
      await store.savePending("id-1", samplePending);
      await store.saveDevice("id-1", sampleDevice);
      await store.saveDeviceState("id-1", sampleDeviceState);
      expect((await store.consumePending("id-1"))?.providerId).toBe(samplePending.providerId);
      expect(await store.getDevice("id-1")).toEqual(sampleDevice);
      expect(await store.getDeviceState("id-1")).toEqual(sampleDeviceState);
    });
  });
});

describe("refresh-service.test.ts", () => {
  describe("classifyOAuthRefreshFailure", () => {
    test("classifies invalid_grant as definitive", () => {
      expect(classifyOAuthRefreshFailure({ message: '{"error":"invalid_grant"}' })).toBe(
        "definitive",
      );
    });

    test("classifies invalid_token as definitive", () => {
      expect(classifyOAuthRefreshFailure({ message: "invalid_token: token is malformed" })).toBe(
        "definitive",
      );
    });

    test("classifies unauthorized_client as definitive", () => {
      expect(classifyOAuthRefreshFailure({ message: "unauthorized_client" })).toBe("definitive");
    });

    test("classifies an explicit revoked message as definitive", () => {
      expect(classifyOAuthRefreshFailure({ message: "token has been revoked by the user" })).toBe(
        "definitive",
      );
    });

    test("classifies refresh_token expired phrasing as definitive", () => {
      expect(classifyOAuthRefreshFailure({ message: "The refresh_token has expired" })).toBe(
        "definitive",
      );
    });

    test("classifies a bare 401 with no matching body as definitive", () => {
      expect(classifyOAuthRefreshFailure({ status: 401, message: "Unauthorized" })).toBe(
        "definitive",
      );
    });

    test("classifies a timeout as transient", () => {
      expect(classifyOAuthRefreshFailure({ message: "fetch timed out" })).toBe("transient");
    });

    test("classifies a 5xx as transient", () => {
      expect(classifyOAuthRefreshFailure({ status: 503, message: "Service Unavailable" })).toBe(
        "transient",
      );
    });

    test("classifies a 429 as transient", () => {
      expect(classifyOAuthRefreshFailure({ status: 429, message: "rate limited" })).toBe("transient");
    });

    test("classifies a 403/forbidden as transient (not a refresh-endpoint revocation signal)", () => {
      expect(classifyOAuthRefreshFailure({ status: 403, message: "Forbidden" })).toBe("transient");
    });

    test("classifies temporarily-unavailable phrasing as transient", () => {
      expect(
        classifyOAuthRefreshFailure({ status: 500, message: "service temporarily unavailable" }),
      ).toBe("transient");
    });
  });
});

import {
  buildPkceAuthorizeUrl,
  composeAbortSignal,
  expiryFromSeconds,
  isDevicePollPending,
  nonEmptyTrimmedString,
  parseDeviceAuthStart,
  truncateUpstreamText,
} from "../../../src/providers/authentication/oauth-flow-store";

describe("device-flow helpers", () => {
  test("parseDeviceAuthStart accepts a complete payload", () => {
    const parsed = parseDeviceAuthStart({
      device_code: "dev-1",
      user_code: "USER-1",
      verification_uri: "https://example.com/activate",
      verification_uri_complete: "https://example.com/activate?code=USER-1",
      interval: 5,
      expires_in: 600,
    });
    expect(parsed).toMatchObject({
      deviceCode: "dev-1",
      userCode: "USER-1",
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });
  });

  test("parseDeviceAuthStart falls back on missing or invalid fields", () => {
    expect(parseDeviceAuthStart(null)).toBeUndefined();
    expect(parseDeviceAuthStart({ device_code: "d" })).toBeUndefined();
    const fallback = parseDeviceAuthStart(
      { device_code: "d", user_code: "u", verification_uri: "https://x.test/" },
      { intervalSeconds: 7, expiresInSeconds: 70 },
    );
    expect(fallback?.intervalSeconds).toBe(7);
    expect(fallback?.expiresInSeconds).toBe(70);
  });

  test("isDevicePollPending matches only the two pending codes", () => {
    expect(isDevicePollPending("authorization_pending")).toBe(true);
    expect(isDevicePollPending("slow_down")).toBe(true);
    expect(isDevicePollPending("expired_token")).toBe(false);
    expect(isDevicePollPending(undefined)).toBe(false);
  });

  test("nonEmptyTrimmedString trims and rejects empties", () => {
    expect(nonEmptyTrimmedString("  x  ")).toBe("x");
    expect(nonEmptyTrimmedString("   ")).toBeUndefined();
    expect(nonEmptyTrimmedString(42)).toBeUndefined();
  });

  test("truncateUpstreamText caps long bodies", () => {
    expect(truncateUpstreamText("short")).toBe("short");
    expect(truncateUpstreamText("x".repeat(600)).length).toBeLessThanOrEqual(500);
  });

  test("expiryFromSeconds floors invalid input at the fallback", () => {
    expect(expiryFromSeconds(60).getTime()).toBeGreaterThan(Date.now());
    expect(expiryFromSeconds("bad").getTime()).toBeGreaterThan(Date.now());
  });

  test("buildPkceAuthorizeUrl assembles query params", () => {
    const url = buildPkceAuthorizeUrl({
      authorizeUrl: "https://auth.test/authorize",
      clientId: "cid",
      redirectUri: "http://127.0.0.1:59653/callback",
      codeChallenge: "chal",
      state: "st",
      scope: "a b",
    });
    expect(url.startsWith("https://auth.test/authorize?")).toBe(true);
    expect(url).toContain("code_challenge=chal");
    expect(url).toContain("state=st");
  });

  test("composeAbortSignal aborts on timeout without a parent signal", async () => {
    const signal = composeAbortSignal(undefined, 10);
    expect(signal.aborted).toBe(false);
    await Bun.sleep(30);
    expect(signal.aborted).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BuddyOAuthClient,
  buddyAccountLabel,
  coercingResponseCode,
  strictResponseCode,
  type BuddyOAuthVariant,
} from "../../../../src/providers/integrations/buddy/buddy-oauth-shared";
import {
  CODEBUDDY_CN_VARIANT,
  CODEBUDDY_INTL_VARIANT,
} from "../../../../src/providers/integrations/buddy/codebuddy-oauth";
import { WORKBUDDY_OAUTH_VARIANT } from "../../../../src/providers/integrations/buddy/workbuddy-oauth";
import {
  VERSION_SOURCES,
  _resetCodeBuddyVersionCache,
  _resetWorkBuddyVersionCache,
  getWorkBuddyCliVersion,
  getWorkBuddyClientVersion,
} from "../../../../src/providers/operations/client-versions";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function recorder(responses: Response[]): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const next = responses[index++];
    if (next === undefined) throw new Error("unexpected fetch call");
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const okStart = () =>
  new Response(JSON.stringify({ code: 0, data: { state: "s-1", authUrl: "https://gw/authorize" } }));

/**
 * One entry per regional variant of the buddy device-login flow. The shared
 * client is the same object for all three, so the only thing that can retarget
 * a provider's login is its variant — which is exactly what these assertions
 * pin.
 */
const VARIANTS: Array<{
  label: string;
  variant: BuddyOAuthVariant;
  origin: string;
  platform: string;
  userAgent: string | (() => string);
}> = [
  {
    label: "cb",
    variant: CODEBUDDY_INTL_VARIANT,
    origin: "https://www.codebuddy.ai/v2",
    platform: "ide",
    userAgent: `IDE/${VERSION_SOURCES.codebuddy.fallback} CodeBuddy/${VERSION_SOURCES.codebuddy.fallback}`,
  },
  {
    label: "cbcn",
    variant: CODEBUDDY_CN_VARIANT,
    origin: "https://copilot.tencent.com/v2",
    platform: "CLI",
    userAgent: `CLI/${VERSION_SOURCES.codebuddy.fallback} CodeBuddy/${VERSION_SOURCES.codebuddy.fallback}`,
  },
  {
    label: "workbuddy",
    variant: WORKBUDDY_OAUTH_VARIANT,
    origin: "https://www.workbuddy.ai/v2",
    platform: "CLI",
    // Computed per test, after the version cache reset: the variant resolves
    // discovery before composing its user agent, so the expectation has to be
    // built at the same moment rather than at module evaluation.
    userAgent: () => {
      const client = getWorkBuddyClientVersion();
      return `WorkBuddy/${client} WorkBuddy AI/${client} CLI/${getWorkBuddyCliVersion()}`;
    },
  },
];

describe("buddy family device login", () => {
  beforeEach(() => {
    _resetCodeBuddyVersionCache(VERSION_SOURCES.codebuddy.fallback);
    _resetWorkBuddyVersionCache(VERSION_SOURCES.workbuddyCli.fallback);
  });
  afterEach(() => {
    _resetCodeBuddyVersionCache();
    _resetWorkBuddyVersionCache();
  });

  for (const entry of VARIANTS) {
    test(`${entry.label} starts device login at its own gateway with its own identity`, async () => {
      const { calls, fetcher } = recorder([okStart()]);
      await new BuddyOAuthClient(entry.variant, fetcher).startDeviceAuth();
      expect(calls).toEqual([
        {
          url: `${entry.origin}/plugin/auth/state?platform=${entry.platform}`,
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent":
              typeof entry.userAgent === "function" ? entry.userAgent() : entry.userAgent,
            "x-domain": entry.variant.domain,
            "x-no-authorization": "true",
            "x-no-user-id": "true",
            "x-product": "SaaS",
            "x-requested-with": "XMLHttpRequest",
          },
          body: "{}",
        },
      ]);
    });

    test(`${entry.label} polls and refreshes at its own gateway`, async () => {
      const { calls, fetcher } = recorder([
        new Response(JSON.stringify({ code: 0, data: { accessToken: "a-1", refreshToken: "r-1", expiresIn: 60 } })),
        new Response(JSON.stringify({ code: 0, data: { accessToken: "a-2", refreshToken: "r-2", expiresIn: 60 } })),
      ]);
      const client = new BuddyOAuthClient(entry.variant, fetcher);
      await client.pollDeviceAuth("dev-1");
      await client.refresh("r-1");
      expect(calls[0]?.url).toBe(`${entry.origin}/plugin/auth/token?state=dev-1`);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.headers["x-no-enterprise-id"]).toBe("true");
      expect(calls[0]?.headers["x-no-department-info"]).toBe("true");
      expect(calls[1]?.url).toBe(`${entry.origin}/plugin/auth/token/refresh`);
      expect(calls[1]?.headers["x-refresh-token"]).toBe("r-1");
      expect(calls[1]?.headers["x-auth-refresh-source"]).toBe("plugin");
    });
  }

  test("a malformed code reads as failure only under the strict reading", () => {
    // WorkBuddy's gateway is read through `Number()`, which turns a null code
    // into 0 — success. That divergence is deliberate and preserved; unifying
    // the two readings would reject a response WorkBuddy accepts.
    expect(strictResponseCode({ code: null })).toBeUndefined();
    expect(coercingResponseCode({ code: null })).toBe(0);
    expect(strictResponseCode({ code: true })).toBeUndefined();
    expect(coercingResponseCode({ code: true })).toBe(1);
    // Both readings accept a numeric string and reject a non-numeric one.
    expect(strictResponseCode({ code: "0" })).toBe(0);
    expect(coercingResponseCode({ code: "0" })).toBe(0);
    expect(strictResponseCode({ code: "abc" })).toBeUndefined();
    expect(coercingResponseCode({ code: "abc" })).toBeUndefined();
    expect(WORKBUDDY_OAUTH_VARIANT.responseCode).toBe(coercingResponseCode);
    expect(CODEBUDDY_INTL_VARIANT.responseCode).toBe(strictResponseCode);
    expect(CODEBUDDY_CN_VARIANT.responseCode).toBe(strictResponseCode);
  });

  test("the account label reads identity claims, and never invents one", () => {
    const jwt = (claims: Record<string, unknown>): string =>
      `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    expect(buddyAccountLabel(jwt({ email: "a@b.test", given_name: "Jane", family_name: "Doe" }))).toBe(
      "Jane Doe <a@b.test>",
    );
    expect(buddyAccountLabel(jwt({ preferred_username: "dev@b.test" }))).toBe("dev@b.test");
    expect(buddyAccountLabel("opaque-token")).toBeUndefined();
    expect(buddyAccountLabel("")).toBeUndefined();
  });
});

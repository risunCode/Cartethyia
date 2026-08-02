import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { fetchOAuthQuota, fetchQoderQuota } from "../src/tokenkeeper/quota";
import type { TokenLease } from "../src/tokenkeeper/types";

function lease(provider: TokenLease["provider"]): TokenLease {
  return {
    credentialId: "credential-1",
    provider,
    accessToken: "access-token",
    expiresAt: Date.now() + 60_000,
    accountId: "account-1",
    providerMetadata: { chatgptAccountId: "workspace-1" },
  };
}

describe("OAuth quota fetchers", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("parses Codex plan, windows, reset times, and account headers", async () => {
    fetchSpy.mockResolvedValue(Response.json({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_800_000_000 },
      },
      additional_rate_limits: [{
        limit_name: "Monthly",
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } },
      }],
    }));

    const quota = await fetchOAuthQuota("openai-codex", lease("openai-codex"));

    expect(quota.error).toBeNull();
    expect(quota.plan).toBe("Plus");
    expect(quota.windows.map((window) => [window.label, window.kind, window.remainingPercent])).toEqual([
      ["5 Hour", "session", 75],
      ["7 Day", "weekly", 60],
      ["Monthly · Primary", "monthly", 90],
    ]);
    expect(quota.windows[0]?.resetsAt).toBeString();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "Bearer access-token",
      "chatgpt-account-id": "workspace-1",
    });
  });

  test("parses Anthropic session, weekly, scoped, and monthly windows", async () => {
    fetchSpy.mockResolvedValue(Response.json({
      five_hour: { utilization: 22, resets_at: "2026-08-02T05:00:00Z" },
      seven_day: { utilization: 55, resets_at: "2026-08-08T00:00:00Z" },
      limits: [{
        kind: "weekly_scoped",
        utilization: 35,
        resets_at: "2026-08-08T00:00:00Z",
        scope: { model: { display_name: "Claude Opus" } },
      }],
      extra_usage: { monthly_limit: 100, used_credits: 15 },
    }));

    const quota = await fetchOAuthQuota("anthropic-oauth", lease("anthropic-oauth"));

    expect(quota.error).toBeNull();
    expect(quota.windows.map((window) => [window.label, window.kind, window.usedPercent])).toEqual([
      ["5 Hour", "session", 22],
      ["7 Day", "weekly", 55],
      ["7 Day · Claude Opus", "weekly", 35],
      ["Monthly", "monthly", 15],
    ]);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "Bearer access-token",
      "anthropic-beta": expect.any(String),
    });
  });

  test("parses Antigravity shared backend quota windows", async () => {
    fetchSpy.mockResolvedValue(Response.json({
      models: {
        "gemini-3.1-pro-low": {
          modelProvider: "MODEL_PROVIDER_GOOGLE",
          quotaInfo: { remainingFraction: 0.72, resetTime: "2026-08-03T00:00:00Z", windowId: "daily", windowLabel: "Daily" },
        },
        "claude-sonnet-4-6": {
          modelProvider: "MODEL_PROVIDER_ANTHROPIC",
          weeklyQuotaInfo: { remainingFraction: 0.4, resetTime: "2026-08-09T00:00:00Z", windowLabel: "Weekly" },
        },
      },
    }));
    const quota = await fetchOAuthQuota("google-antigravity", { ...lease("google-antigravity"), providerMetadata: { projectId: "project-1" } });
    expect(quota.error).toBeNull();
    expect(quota.windows.map((window) => [window.label, window.kind, window.usedPercent])).toEqual([
      ["Google · Daily", "daily", 28],
      ["Anthropic · Weekly", "weekly", 60],
    ]);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(JSON.parse(String((init as RequestInit | undefined)?.body))).toEqual({ project: "project-1" });
  });

  test("parses Qoder user and organization credit quotas", async () => {
    fetchSpy
      .mockResolvedValueOnce(Response.json({ id: "qoder-user", securityOauthToken: "job-token", refreshToken: "refresh-token", name: "Qoder User", userType: "personal_standard" }))
      .mockResolvedValueOnce(Response.json({ expiresAt: "2026-09-01T00:00:00Z", userQuota: { total: 100, used: 25, remaining: 75, unit: "credits" }, orgResourcePackage: { total: 500, used: 100, remaining: 400, unit: "credits" } }));
    const quota = await fetchQoderQuota("pt-test");
    expect(quota).toMatchObject({ plan: "Qoder AI Plan", error: null });
    expect(quota.windows.map((window) => [window.label, window.usedPercent, window.remainingPercent])).toEqual([["User Quota", 25, 75], ["Org Resource Package", 20, 80]]);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
    expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer job-token" });
  });

  test("returns a sanitized error for upstream failures", async () => {
    fetchSpy.mockResolvedValue(new Response("upstream detail", { status: 429 }));

    const quota = await fetchOAuthQuota("openai-codex", lease("openai-codex"));

    expect(quota.plan).toBeNull();
    expect(quota.windows).toEqual([]);
    expect(quota.error).toBe("Quota endpoint returned HTTP 429.");
  });
});

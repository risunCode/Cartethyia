import { describe, expect, test } from "bun:test";
import {
  fetchGithubQuota,
  parseGithubQuota,
} from "../../src/providers/integrations/github/github-quota";
import { totalRemainingCredit } from "../../src/providers/quota/quota-contracts";

describe("GitHub Copilot quota", () => {
  test("parses the Copilot usage snapshot response", () => {
    const quota = parseGithubQuota({
      login: "octocat",
      copilot_plan: "individual",
      quota_reset_date: "2026-11-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          remaining: 225,
          percent_remaining: 75,
        },
        chat: {
          entitlement: 200,
          percent_remaining: 76.5,
        },
        completions: {
          entitlement: 2_000,
          remaining: 16,
          percent_remaining: 0.8,
        },
      },
    });

    expect(quota.plan).toBe("individual");
    expect(quota.accountLabel).toBe("octocat");
    expect(quota.windows).toMatchObject([
      {
        kind: "premium_interactions",
        label: "Premium Requests",
        accounting: "pooled",
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: "2026-11-01T00:00:00.000Z",
        used: 75,
        limit: 300,
      },
      {
        kind: "chat",
        label: "Chat Requests",
        accounting: "pooled",
        usedPercent: 23.5,
        remainingPercent: 76.5,
        resetsAt: "2026-11-01T00:00:00.000Z",
        used: 47,
        limit: 200,
      },
      {
        kind: "completions",
        label: "Completions",
        accounting: "independent",
        usedPercent: 99.2,
        resetsAt: "2026-11-01T00:00:00.000Z",
        used: 1_984,
        limit: 2_000,
      },
    ]);
    expect(quota.windows[2]?.remainingPercent).toBeCloseTo(0.8);
    expect(totalRemainingCredit(quota.windows)).toBe(378);
  });

  test("does not expose an empty zero-entitlement snapshot as 0 / 0 credits", () => {
    const quota = parseGithubQuota({
      quota_snapshots: {
        premium_interactions: {
          entitlement: "0",
          quota_remaining: 0,
          percent_remaining: 0,
        },
      },
    });

    expect(quota.windows).toEqual([]);
  });

  test("requests usage with the GitHub token, not the minted Copilot token", async () => {
    let requestedUrl = "";
    let authorization = "";
    const fetcher: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({
          copilot_plan: "business",
          quota_snapshots: {
            premium_interactions: { entitlement: 100, remaining: 50, percent_remaining: 50 },
          },
        }), { headers: { "content-type": "application/json" } });
      },
      { preconnect: fetch.preconnect.bind(fetch) },
    );

    const quota = await fetchGithubQuota(JSON.stringify({
      access: "minted-copilot-token",
      apiHost: "api.individual.githubcopilot.com",
      github: "github-oauth-token",
    }), fetcher);

    expect(requestedUrl).toBe("https://api.github.com/copilot_internal/user");
    expect(authorization).toBe("Bearer github-oauth-token");
    expect(quota.windows).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { fetchProviderQuota as collectProviderQuota } from "../../../src/providers/quota/quota-support";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";
import { jsonResponse } from "../../helpers/sse-fixtures";

const providerRegistry = createDefaultProviderRegistry();
const fetchProviderQuota = (providerId: string, credential: string, fetcher: typeof fetch = fetch) =>
  collectProviderQuota(providerRegistry, providerId, credential, fetcher);


describe("provider quota dispatch", () => {
  test("ollamacloud dispatches to the Ollama fetcher instead of unsupported", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: unknown) => {
      seen.push(String(input));
      if (String(input).endsWith("/api/me")) return jsonResponse({ Plan: "pro" });
      return jsonResponse({ limits: { session: { usage: 0.5 }, weekly: { usage: 0.25 } } });
    }) as unknown as typeof fetch;

    const result = await fetchProviderQuota("ollamacloud", "secret", fetcher);

    expect(result.error).toBeNull();
    expect(result.windows.length).toBeGreaterThan(0);
    expect(seen.some((url) => url.includes("ollama.com"))).toBe(true);
  });

  test("maps the free-plan monthly usage window", async () => {
    const fetcher = (async (input: unknown) => {
      if (String(input).endsWith("/api/me")) return jsonResponse({ Plan: "free" });
      return jsonResponse({ limits: { monthly: { usage: 0.25, models: [] } } });
    }) as unknown as typeof fetch;

    const result = await fetchProviderQuota("ollamacloud", "secret", fetcher);

    expect(result).toMatchObject({
      plan: "Free",
      windows: [{ kind: "monthly", label: "Monthly", usedPercent: 25 }],
      error: null,
    });
  });

  test("Claude parses model-scoped and generic limit buckets", async () => {
    const fetcher = (async () =>
      jsonResponse({
        plan_type: "max",
        five_hour: { utilization: 12, resets_at: "2026-09-08T01:00:00Z" },
        seven_day_opus: { utilization: 34, resets_at: "2026-09-14T01:00:00Z" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 56,
            resets_at: "2026-09-14T01:00:00Z",
            scope: { model: { display_name: "Fable" } },
          },
        ],
      })) as unknown as typeof fetch;

    const result = await fetchProviderQuota("claude", "claude-limits-test", fetcher);

    expect(result.plan).toBe("max");
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "session", usedPercent: 12 }),
        expect.objectContaining({ kind: "weekly_opus", usedPercent: 34 }),
        expect.objectContaining({ kind: "weekly_scoped", label: "7 Day (Fable)", usedPercent: 56 }),
      ]),
    );
  });

  test("an unknown provider reports unsupported quota", async () => {
    const result = await fetchProviderQuota("not-a-provider", "secret");
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("not available");
  });
});

describe("subscription provider quota fetchers", () => {
  test("Muse reads rolling and weekly subscription windows through the OAuth envelope", async () => {
    let seenUrl = "";
    let seenAuthorization = "";
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuthorization = String((init?.headers as Record<string, string>)?.authorization);
      return jsonResponse({
        user_email: "user@example.com",
        subs_tier_name: "pro",
        subs_usage: {
          window: {
            used_percent: 25,
            resets_at: "2026-09-08T01:00:00Z",
            window_duration_mins: 300,
          },
          weekly: {
            used_percent: 60,
            resets_at: "2026-09-14T01:00:00Z",
          },
        },
      });
    }) as unknown as typeof fetch;

    const result = await fetchProviderQuota(
      "muse",
      JSON.stringify({ oauthAccessToken: "oauth-token", apiKey: "minted-key" }),
      fetcher,
    );

    expect(seenUrl).toBe("https://api.meta.ai/muse-code/key");
    expect(seenAuthorization).toBe("Bearer oauth-token");
    expect(result.plan).toBe("pro");
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "300m", usedPercent: 25 }),
        expect.objectContaining({ kind: "1w", usedPercent: 60 }),
      ]),
    );
  });

  test("Kimi uses the persisted per-account device id and parses aggregate plus rolling limits", async () => {
    let seenUrl = "";
    let seenDeviceId = "";
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input);
      seenDeviceId = String((init?.headers as Record<string, string>)?.["X-Msh-Device-Id"]);
      return jsonResponse({
        usage: { used: 10, limit: 100, resetTime: "2026-09-14T01:00:00Z" },
        limits: [
          {
            detail: { used: 20, limit: 100, resetTime: "2026-09-08T01:00:00Z" },
            window: { duration: 5, timeUnit: "HOUR" },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await fetchProviderQuota(
      "kimi",
      JSON.stringify({ accessToken: "kimi-access", deviceId: "tenant-account-device" }),
      fetcher,
    );

    expect(seenUrl).toBe("https://api.kimi.com/coding/v1/usages");
    expect(seenDeviceId).toBe("tenant-account-device");
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "7d", usedPercent: 10 }),
        expect.objectContaining({ kind: "5h", usedPercent: 20 }),
      ]),
    );
  });
});

describe("CodeBuddy billing quota", () => {
  test("splits recurring refill and one-shot bonus packages", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [
                {
                  PackageName: "CodeBuddy Pro",
                  CycleCapacityUsedPrecise: "6.54",
                  CycleCapacitySizePrecise: "500",
                  CycleStartTime: "2026-09-01T00:00:00Z",
                  CycleEndTime: "2026-10-01T00:00:00Z",
                  DeductionEndTime: "2026-12-31T00:00:00Z",
                },
                {
                  PackageName: "Bonus",
                  CapacityUsedPrecise: "12",
                  CapacitySizePrecise: "100",
                  CycleEndTime: "2026-09-20T00:00:00Z",
                  DeductionEndTime: "2026-09-20T00:00:00Z",
                },
              ],
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const result = await fetchProviderQuota("cbcn", "cn-access-token", fetcher);

    expect(seenUrl).toBe("https://copilot.tencent.com/v2/billing/meter/get-user-resource");
    expect(seenAuth).toBe("Bearer cn-access-token");
    expect(result.source).toBe("cbcn");
    expect(result.plan).toBe("CodeBuddy Pro");
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Monthly",
          kind: "quota:monthly",
          used: 6.54,
          limit: 500,
          recurring: true,
        }),
        expect.objectContaining({
          label: "Bonus Pack 1",
          kind: "bonus:1",
          used: 12,
          limit: 100,
          recurring: false,
        }),
      ]),
    );
  });

  test("uses the international billing host and IDE fingerprint", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({
        code: 0,
        data: { Response: { Data: { Accounts: [
          {
            PackageName: "CodeBuddy",
            CycleCapacityUsed: 1,
            CycleCapacitySize: 10,
            CycleStartTime: "2026-09-01T00:00:00Z",
            CycleEndTime: "2026-10-01T00:00:00Z",
            DeductionEndTime: "2026-12-31T00:00:00Z",
          },
        ] } } },
      });
    }) as unknown as typeof fetch;
    const result = await fetchProviderQuota("cb", "intl-token", fetcher);

    expect(seenUrl).toBe("https://www.codebuddy.ai/v2/billing/meter/get-user-resource");
    expect(seenHeaders.get("x-ide-type")).toBe("IDE");
    expect(seenHeaders.get("x-ide-name")).toBe("IDE");
    expect(result.source).toBe("cb");
    expect(result.windows[0]?.usedPercent).toBe(10);
  });
});

describe("Devin quota", () => {
  test("parses prompt credits with plan reset and no flow row", async () => {
    let seenUrl = "";
    const fetcher = (async (input: unknown) => {
      seenUrl = String(input);
      return jsonResponse({
        userStatus: {
          teamsTier: "pro",
          planStatus: {
            availablePromptCredits: 400,
            usedPromptCredits: 100,
            availableFlowCredits: 45,
            usedFlowCredits: 5,
            planEnd: "2026-10-01T00:00:00Z",
          },
        },
        planInfo: { planName: "Devin Pro" },
      });
    }) as unknown as typeof fetch;
    const result = await fetchProviderQuota("devin", "session-token", fetcher);
    expect(seenUrl).toBe(
      "https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    );
    expect(result.plan).toBe("Devin Pro");
    expect(result.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "prompt-credits", usedPercent: 20 }),
      ]),
    );
    expect(result.windows.some((window) => window.kind === "flow-credits")).toBe(false);
  });

  test("drops untouched Prompt Credits and the Flow row entirely", async () => {
    const fetcher = (async () =>
      jsonResponse({
        userStatus: {
          teamsTier: "pro",
          planStatus: {
            availablePromptCredits: 2500,
            usedPromptCredits: 0,
            planEnd: "2026-10-01T00:00:00Z",
          },
        },
        planInfo: { planName: "Devin Pro" },
      })) as unknown as typeof fetch;
    const result = await fetchProviderQuota("devin", "session-token", fetcher);
    expect(result.windows).toEqual([]);
  });
});

describe("Cursor quota", () => {
  test("skips zero-usage model buckets instead of emitting 0% windows", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls > 1) return jsonResponse({});
      return jsonResponse({
        "gpt-4": { used: 0, limit: 100 },
        "gpt-4o": { used: 5, limit: 100 },
      });
    }) as unknown as typeof fetch;
    const result = await fetchProviderQuota("cursor", "token", fetcher);
    expect(result.windows.map((window) => window.label)).toEqual(["gpt-4o"]);
    expect(result.windows[0]).toMatchObject({ usedPercent: 5 });
  });

  test("shows only the two rails and drops unrecognized shapes", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "user_01test" })).toString("base64url");
    const jwt = `${header}.${body}.sig`;
    const fetcher = (async (input: unknown) => {
      if (String(input).includes("usage-summary")) {
        return jsonResponse({
          billingCycleEnd: "2026-10-04T10:02:07.040Z",
          individualUsage: {
            plan: { autoPercentUsed: 0, apiPercentUsed: 0 },
          },
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const result = await fetchProviderQuota("cursor", jwt, fetcher);
    // The two rails are the canonical rows and render even at zero.
    expect(result.windows.map((window) => window.label)).toEqual([
      "Cursor Models",
      "Other Models",
    ]);
    expect(result.error).toBeNull();
  });

  test("drops unrecognized shapes instead of emitting a fake Usage row", async () => {
    const fetcher = (async () =>
      jsonResponse({
        mystery: { used: 5 },
      })) as unknown as typeof fetch;
    const result = await fetchProviderQuota("cursor", "token", fetcher);
    expect(result.windows).toEqual([]);
    expect(result.error).toBeNull();
  });
});

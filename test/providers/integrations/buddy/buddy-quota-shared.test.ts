import { describe, expect, test } from "bun:test";
import {
  billingNum,
  fetchTencentBillingQuota,
  parseBillingResetTime,
} from "../../../../src/providers/integrations/buddy/buddy-quota-shared";
import type { FetchLike } from "../../../../src/providers/quota/quota-contracts";

function envelope(accounts: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: accounts } } } });
}

function jsonFetcher(body: string, status = 200): FetchLike {
  return (async () => new Response(body, { status })) as unknown as FetchLike;
}

function callQuota(fetcher: FetchLike) {
  return fetchTencentBillingQuota({
    source: "probe",
    display: "Probe",
    url: "https://probe.example/v2/billing/meter/get-user-resource",
    headers: { "X-Probe": "1" },
    credential: "secret-token",
    fetcher,
    defaultPlan: "Fallback Plan",
  });
}

describe("parseBillingResetTime", () => {
  test("reads seconds, millis, numeric strings, and ISO strings", () => {
    expect(parseBillingResetTime(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parseBillingResetTime(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parseBillingResetTime("1700000000000")).toBe(new Date(1_700_000_000_000).toISOString());
    expect(parseBillingResetTime("2024-01-01T00:00:00.000Z")).toBe("2024-01-01T00:00:00.000Z");
    expect(parseBillingResetTime(new Date(1_700_000_000_000))).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  test("returns null for absent and unparseable values", () => {
    expect(parseBillingResetTime(null)).toBeNull();
    expect(parseBillingResetTime(undefined)).toBeNull();
    expect(parseBillingResetTime("")).toBeNull();
    expect(parseBillingResetTime("   ")).toBeNull();
    expect(parseBillingResetTime(Number.NaN)).toBeNull();
    expect(parseBillingResetTime(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseBillingResetTime("not-a-date")).toBeNull();
    expect(parseBillingResetTime({})).toBeNull();
  });
});

describe("billingNum", () => {
  test("prefers the precise field and falls back to the plain one", () => {
    expect(billingNum("12", 5)).toBe(12);
    expect(billingNum(undefined, 5)).toBe(5);
    expect(billingNum(null, 5)).toBe(5);
  });

  test("yields zero for non-finite input rather than NaN", () => {
    expect(billingNum("nope", undefined)).toBe(0);
    expect(billingNum(Number.NaN, Number.NaN)).toBe(0);
  });
});

describe("fetchTencentBillingQuota", () => {
  test("splits refills from bonuses and labels cadences with dedup", async () => {
    const result = await callQuota(
      jsonFetcher(
        envelope([
          {
            PackageName: "Pro",
            CycleStartTime: "2024-01-01T00:00:00.000Z",
            CycleEndTime: "2024-01-08T00:00:00.000Z",
            DeductionEndTime: "2024-01-15T00:00:00.000Z",
            CycleCapacityUsedPrecise: "50",
            CycleCapacitySizePrecise: "100",
          },
          {
            CycleStartTime: "2024-01-08T00:00:00.000Z",
            CycleEndTime: "2024-01-15T00:00:00.000Z",
            DeductionEndTime: "2024-01-25T00:00:00.000Z",
            CycleCapacityUsed: 25,
            CycleCapacitySize: 100,
          },
          {
            CycleStartTime: "2024-02-01T00:00:00.000Z",
            CycleEndTime: "2024-02-01T12:00:00.000Z",
            DeductionEndTime: "2024-02-05T00:00:00.000Z",
            CycleCapacityUsed: 1,
            CycleCapacitySize: 4,
          },
          {
            CycleEndTime: "2024-03-15T00:00:00.000Z",
            DeductionEndTime: "2024-03-15T00:00:00.000Z",
            CapacityUsedPrecise: "3",
            CapacitySizePrecise: "6",
          },
          {
            CycleEndTime: "2024-03-01T00:00:00.000Z",
            DeductionEndTime: "2024-03-01T00:00:00.000Z",
            CapacityUsedPrecise: "2",
            CapacitySizePrecise: "10",
          },
        ]),
      ),
    );

    expect(result.error).toBeNull();
    expect(result.source).toBe("probe");
    // Plan comes from the earliest refill, not the fallback.
    expect(result.plan).toBe("Pro");

    // Refills first (ascending expiry), then bonuses numbered by expiry.
    expect(result.windows.map((w) => [w.kind, w.label, w.recurring])).toEqual([
      ["quota:weekly", "Weekly", true],
      ["quota:weekly_2", "Weekly 2", true],
      ["quota:daily", "Daily", true],
      ["bonus:1", "Bonus Pack 1", false],
      ["bonus:2", "Bonus Pack 2", false],
    ]);

    const [weekly, , daily, bonusOne] = result.windows;
    expect(weekly?.usedPercent).toBe(50);
    expect(weekly?.remainingPercent).toBe(50);
    expect(weekly?.used).toBe(50);
    expect(weekly?.limit).toBe(100);
    expect(weekly?.resetsAt).toBe("2024-01-08T00:00:00.000Z");
    expect(daily?.usedPercent).toBe(25);
    expect(bonusOne?.usedPercent).toBe(20);
    // Bonus windows are lifetime, so they carry the cycle expiry they were sorted by.
    expect(bonusOne?.resetsAt).toBe("2024-03-01T00:00:00.000Z");
  });

  test("falls back to the provider plan name when the payload names no package", async () => {
    const result = await callQuota(
      jsonFetcher(
        envelope([
          {
            CycleEndTime: "2024-01-08T00:00:00.000Z",
            DeductionEndTime: "2024-01-15T00:00:00.000Z",
            CycleCapacityUsed: 1,
            CycleCapacitySize: 2,
          },
        ]),
      ),
    );
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Fallback Plan");
  });

  test("reports a non-zero envelope code as a quota error", async () => {
    const result = await callQuota(jsonFetcher(JSON.stringify({ code: 40001, msg: "denied" })));
    expect(result.error).toBe("Probe quota error: denied");
    expect(result.windows).toEqual([]);
  });

  test("reports rejected credentials distinctly from transport failures", async () => {
    expect((await callQuota(jsonFetcher("", 401))).error).toBe(
      "Probe credential invalid or expired.",
    );
    expect((await callQuota(jsonFetcher("", 503))).error).toBe("Probe quota API error (503).");
  });

  test("reports an empty account list instead of an empty window set", async () => {
    const result = await callQuota(jsonFetcher(envelope([])));
    expect(result.error).toBe("Probe connected. No credit package found.");
    expect(result.plan).toBeNull();
  });

  test("reports invalid JSON rather than throwing", async () => {
    const result = await callQuota(jsonFetcher("<html>gateway</html>"));
    expect(result.error).toBe("Probe quota response returned invalid JSON");
  });

  test("refuses an unusable credential before issuing a request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response(envelope([]));
    }) as unknown as FetchLike;
    const result = await fetchTencentBillingQuota({
      source: "probe",
      display: "Probe",
      url: "https://probe.example/v2/billing/meter/get-user-resource",
      headers: {},
      credential: "   ",
      fetcher,
      defaultPlan: "Fallback Plan",
    });
    expect(result.error).toBe("Probe credential not available.");
    expect(called).toBe(false);
  });

  test("accepts an OAuth envelope credential and sends it as the bearer", async () => {
    let authorization: string | undefined;
    const fetcher = (async (_url: string, init: { headers: Record<string, string> }) => {
      authorization = init.headers["Authorization"];
      return new Response(envelope([]));
    }) as unknown as FetchLike;
    await fetchTencentBillingQuota({
      source: "probe",
      display: "Probe",
      url: "https://probe.example/v2/billing/meter/get-user-resource",
      headers: {},
      credential: JSON.stringify({ accessToken: "oauth-access" }),
      fetcher,
      defaultPlan: "Fallback Plan",
    });
    expect(authorization).toBe("Bearer oauth-access");
  });

  // The window shape is a contract with the Console; guard the fields the
  // dashboard reads directly rather than only the derived percentages.
  test("keeps a zero-capacity window with no percentage rather than dropping it", async () => {
    const result = await callQuota(
      jsonFetcher(
        envelope([
          {
            CycleStartTime: "2024-01-01T00:00:00.000Z",
            CycleEndTime: "2024-01-01T00:00:00.000Z",
            DeductionEndTime: "2024-01-04T00:00:00.000Z",
            CycleCapacityUsed: 0,
            CycleCapacitySize: 0,
          },
        ]),
      ),
    );
    const window = result.windows[0];
    expect(window?.kind).toBe("quota:daily");
    expect(window?.usedPercent).toBeNull();
    expect(window?.remainingPercent).toBeNull();
    expect(window?.limit).toBe(0);
  });
});

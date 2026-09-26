import { describe, expect, test } from "bun:test";
import { fetchCursorQuota } from "../../../../src/providers/integrations/cursor/cursor-quota";

const USAGE_A = "https://api2.cursor.sh/auth/usage";
const USAGE_B = "https://api2.cursor.sh/api/usage";
const SUMMARY = "https://cursor.com/api/usage-summary";

/** A fetcher that answers the given URLs and throws for anything else. */
function fetcherFor(bodies: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = bodies[url];
    if (body === undefined) throw new Error(`no fixture for ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly accept: string | null;
  readonly cookie: string | null;
}

/** Like {@link fetcherFor}, but records every request the quota client makes. */
function recordingFetcher(bodies: Record<string, unknown>): {
  fetcher: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      accept: headers.get("accept"),
      cookie: headers.get("cookie"),
    });
    const body = bodies[url];
    if (body === undefined) throw new Error(`no fixture for ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** An access token whose JWT `sub` claim yields a user id. */
function jwtWithUser(userId = "user-1"): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ sub: `auth0|${userId}` })}.sig`;
}

describe("fetchCursorQuota", () => {
  test("rejects an empty credential", async () => {
    await expect(fetchCursorQuota("  ", fetcherFor({}))).rejects.toThrow("empty");
  });

  test("parses percent usage into a quota window", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: {
          individualUsage: {
            plan: { autoPercentUsed: 42, plan: "Pro" },
          },
        },
        [USAGE_B]: {},
      }),
    );
    expect(result.source).toBe("cursor");
    expect(result.plan).toBe("Pro");
    expect(result.error).toBeNull();
    expect(result.windows[0]).toMatchObject({
      kind: "quota",
      label: "Cursor Models",
      usedPercent: 42,
      remainingPercent: 58,
    });
  });

  test("parses a data-wrapped percent payload", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { data: { individualUsage: { plan: { autoPercentUsed: 42 } } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]?.usedPercent).toBe(42);
  });

  test("prefers the API percent over the total percent and the auto percent", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { apiPercentUsed: 20, totalPercentUsed: 33 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]?.usedPercent).toBe(20);
  });

  test("falls back to totalPercentUsed when the other percents are absent", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { totalPercentUsed: 33 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]?.usedPercent).toBe(33);
  });

  test("reads percent usage from the overall block when no plan block exists", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { overall: { autoPercentUsed: 15 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]?.usedPercent).toBe(15);
  });

  test("derives a percent from a cents bucket with a positive limit", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { limit: 1000, used: 250, plan: "Pro" } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.plan).toBe("Pro");
    expect(result.windows[0]).toMatchObject({
      label: "Cursor Models",
      usedPercent: 25,
      remainingPercent: 75,
    });
  });

  test("derives the used amount from the remaining cents when used is absent", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { limit: 1000, remaining: 400 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]?.usedPercent).toBe(60);
  });

  test("reports a fully unconsumed cents bucket as zero percent", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { limit: 1000, used: 0, remaining: 1000 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]).toMatchObject({ usedPercent: 0, remainingPercent: 100 });
  });

  test("ignores a disabled cents bucket", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: {
          individualUsage: { plan: { enabled: false, limit: 1000, used: 250 } },
        },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows).toEqual([]);
  });

  test("ignores a cents bucket whose limit is zero", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { limit: 0, used: 500 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows).toEqual([]);
  });

  test("parses the on-demand bucket when the plan carries no percent", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: {
          individualUsage: { plan: { plan: "Pro" }, onDemand: { limit: 2000, used: 500 } },
        },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]).toMatchObject({ label: "On-Demand", usedPercent: 25 });
  });

  test("ignores an on-demand bucket that carries no consumption", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { individualUsage: { plan: { plan: "Pro" }, onDemand: { limit: 2000 } } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows).toEqual([]);
  });

  test("parses a bucketed usage object keyed by feature", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: {
          someBucket: { numRequests: 50, maxRequestUsage: 200 },
          billingCycleEnd: "2026-01-01T00:00:00.000Z",
        },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]).toMatchObject({
      kind: "cursor:someBucket",
      label: "someBucket",
      usedPercent: 25,
      used: 50,
      limit: 200,
      resetsAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("parses amount and usd aliases in a bucketed usage object", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { premium: { amountUsed: 10, usdLimit: 40 } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows[0]).toMatchObject({ label: "premium", usedPercent: 25 });
  });

  test("ignores a bucketed usage object with no limit", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { someBucket: { numRequests: 50 } },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows).toEqual([]);
  });

  test("falls back to a single used/limit pair", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({ [USAGE_A]: { used: 30, limit: 100 }, [USAGE_B]: {} }),
    );
    expect(result.windows[0]).toMatchObject({ label: "Quota", usedPercent: 30 });
  });

  test("falls back to a single remaining/limit pair", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({ [USAGE_A]: { remaining: 25, limit: 100 }, [USAGE_B]: {} }),
    );
    expect(result.windows[0]?.usedPercent).toBe(75);
  });

  test("falls back to a single percentUsed", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({ [USAGE_A]: { percentUsed: 55 }, [USAGE_B]: {} }),
    );
    // The single used/limit fallback converts through a fraction, so the
    // percentage is compared to tolerance rather than bit-exactly.
    expect(result.windows[0]?.usedPercent).toBeCloseTo(55, 10);
  });

  test("falls back to a single totalPercentUsed", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({ [USAGE_A]: { totalPercentUsed: 65 }, [USAGE_B]: {} }),
    );
    expect(result.windows[0]?.usedPercent).toBeCloseTo(65, 10);
  });

  test("parses a windows array of percent entries", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: {
          windows: [
            { kind: "daily", label: "Daily Requests", percentUsed: 40 },
            { kind: "monthly", label: "Monthly", usedPercent: 12 },
          ],
        },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({
      kind: "daily",
      label: "Daily Requests",
      usedPercent: 40,
    });
    expect(result.windows[1]).toMatchObject({ kind: "monthly", usedPercent: 12 });
  });

  test("skips windows entries without a positive percent", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: { windows: [{ kind: "daily", percentUsed: 0 }, { label: "no percent" }] },
        [USAGE_B]: {},
      }),
    );
    expect(result.windows).toEqual([]);
  });

  test("returns a neutral empty state when endpoints answer no windows", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({ [USAGE_A]: {}, [USAGE_B]: {} }),
    );
    expect(result.error).toBeNull();
    expect(result.windows).toEqual([]);
  });

  test("ignores zero-percent usage (no misleading full bar)", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({
        [USAGE_A]: {
          individualUsage: { plan: { autoPercentUsed: 0 } },
        },
        [USAGE_B]: {},
      }),
    );
    expect(result.error).toBeNull();
    expect(result.windows).toEqual([]);
  });

  test("returns an error result when every endpoint fails", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchCursorQuota("tok-123", failing);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("network down");
  });
});

describe("fetchCursorQuota usage summary", () => {
  test("reads both model rails from the usage-summary endpoint", async () => {
    const token = jwtWithUser();
    const { fetcher, calls } = recordingFetcher({
      [USAGE_A]: {},
      [USAGE_B]: {},
      [SUMMARY]: {
        individualUsage: {
          plan: { autoPercentUsed: 30, apiPercentUsed: 12, plan: "Pro" },
        },
      },
    });
    const result = await fetchCursorQuota(token, fetcher);
    expect(result.plan).toBe("Pro");
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({
      kind: "cursor-models",
      label: "Cursor Models",
      usedPercent: 30,
    });
    expect(result.windows[1]).toMatchObject({
      kind: "other-models",
      label: "Other Models",
      usedPercent: 12,
    });

    const summaryCall = calls.find((call) => call.url === SUMMARY);
    if (summaryCall === undefined) throw new Error("expected a usage-summary request");
    expect(summaryCall.method).toBe("GET");
    expect(summaryCall.accept).toBe("application/json");
    expect(summaryCall.cookie).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent(`user-1::${token}`)}`,
    );
  });

  test("omits a rail that carries no percent", async () => {
    const result = await fetchCursorQuota(
      jwtWithUser(),
      fetcherFor({
        [USAGE_A]: {},
        [USAGE_B]: {},
        [SUMMARY]: { individualUsage: { plan: { autoPercentUsed: 30, plan: "Pro" } } },
      }),
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.label).toBe("Cursor Models");
  });

  test("does not query the usage summary without a user id", async () => {
    const { fetcher, calls } = recordingFetcher({ [USAGE_A]: {}, [USAGE_B]: {} });
    const result = await fetchCursorQuota("tok-123", fetcher);
    expect(calls.some((call) => call.url === SUMMARY)).toBe(false);
    expect(result.windows).toEqual([]);
  });

  test("keeps the primary windows when the usage summary fails", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === SUMMARY) throw new Error("summary down");
      if (url === USAGE_A) {
        return new Response(
          JSON.stringify({ individualUsage: { plan: { autoPercentUsed: 42, plan: "Pro" } } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCursorQuota(jwtWithUser(), fetcher);
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Pro");
    expect(result.windows[0]?.usedPercent).toBe(42);
  });

  test("uses the usage summary when the primary endpoints fail", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== SUMMARY) throw new Error("primary down");
      return new Response(
        JSON.stringify({
          individualUsage: { plan: { autoPercentUsed: 30, apiPercentUsed: 12 } },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchCursorQuota(jwtWithUser(), fetcher);
    expect(result.error).toBeNull();
    expect(result.windows.map((window) => window.kind)).toEqual([
      "cursor-models",
      "other-models",
    ]);
  });

  test("returns the neutral empty state when the summary has no plan block", async () => {
    const result = await fetchCursorQuota(
      jwtWithUser(),
      fetcherFor({
        [USAGE_A]: {},
        [USAGE_B]: {},
        [SUMMARY]: { individualUsage: { onDemand: {} } },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.plan).toBe("Cursor");
  });
});

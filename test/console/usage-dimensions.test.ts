import { describe, expect, test } from "bun:test";
import { USAGE_DIMENSIONS } from "../../src/console/domains/stats/contracts";
import { createObservabilityRoutes } from "../../src/console/domains/stats/contracts";

/**
 * The `by-<dimension>` route is parametric, so a dimension is reachable only
 * if it is in `USAGE_DIMENSIONS` — the same tuple the operations validator and
 * the dashboard mirror read. Before this, the route file registered four
 * hand-written paths and the validator restated the same four members, so
 * adding a dimension meant editing both and forgetting one was silent.
 */
const seen: string[] = [];

function app(): ReturnType<typeof createObservabilityRoutes> {
  return createObservabilityRoutes({
    accessResolver: () => ({
      id: "session-1",
      tenantId: "tenant-1",
      scopes: ["dashboard:read"],
      admissionIdentity: "admin@example.test",
    }),
    store: {
      usageBy: async (_tenantId: string, dimension: string) => {
        seen.push(dimension);
        return {
          rows: [
            {
              name: "row",
              requests: 3,
              input: 10,
              output: 5,
              cached: 0,
              total: 15,
              errors: 1,
              costUsd: null,
              cacheHitRate: 0,
              avgTokensPerSec: 0,
            },
          ],
        };
      },
    },
  } as never);
}

describe("usage breakdown dimensions", () => {
  test("every canonical dimension has a reachable route", async () => {
    for (const dimension of USAGE_DIMENSIONS) {
      seen.length = 0;
      const response = await app().handle(
        new Request(`http://localhost/system/usage/by-${dimension}?period=24h`),
      );
      expect(response.status).toBe(200);
      // The route must forward the dimension it matched, not a default.
      expect(seen).toEqual([dimension]);
    }
  });

  test("an unknown dimension answers 404, not a fallback row set", async () => {
    const response = await app().handle(
      new Request("http://localhost/system/usage/by-bogus?period=24h"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("invalid_dimension");
  });

  test("the tuple contains the client_ip dimension", () => {
    expect([...USAGE_DIMENSIONS]).toContain("client_ip");
  });
});

import { isSupportedUsagePeriod } from "../../src/console/domains/stats/contracts";

describe("isSupportedUsagePeriod", () => {
  test("accepts the unbounded token and bounded windows", () => {
    expect(isSupportedUsagePeriod("all")).toBe(true);
    expect(isSupportedUsagePeriod("24h")).toBe(true);
    expect(isSupportedUsagePeriod("7d")).toBe(true);
    expect(isSupportedUsagePeriod("30d")).toBe(true);
  });

  test("rejects typos and out-of-range windows", () => {
    expect(isSupportedUsagePeriod("week")).toBe(false);
    expect(isSupportedUsagePeriod("")).toBe(false);
    expect(isSupportedUsagePeriod("0h")).toBe(false);
    expect(isSupportedUsagePeriod("9000h")).toBe(false);
    expect(isSupportedUsagePeriod("400d")).toBe(false);
    expect(isSupportedUsagePeriod("24m")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { fetchCursorQuota } from "../../../../src/providers/integrations/cursor/cursor-quota";

function fetcherFor(bodies: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = bodies[url];
    if (body === undefined) throw new Error(`no fixture for ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe("fetchCursorQuota", () => {
  const USAGE_A = "https://api2.cursor.sh/auth/usage";
  const USAGE_B = "https://api2.cursor.sh/api/usage";

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
    expect(result.error).toBeNull();
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.windows[0]?.usedPercent).toBe(42);
  });

  test("returns a neutral empty state when endpoints answer no windows", async () => {
    const result = await fetchCursorQuota(
      "tok-123",
      fetcherFor({ [USAGE_A]: {}, [USAGE_B]: {} }),
    );
    expect(result.error).toBeNull();
    expect(result.windows).toEqual([]);
  });

  test("returns an error result when every endpoint fails", async () => {
    const failing = (async () => {
      throw new Error("network down");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const result = await fetchCursorQuota("tok-123", failing);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("network down");
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
});

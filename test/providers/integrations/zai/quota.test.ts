import { describe, expect, test } from "bun:test";
import { fetchZaiQuota } from "../../../../src/providers/integrations/zai/zai-quota";
import { jsonResponse } from "../../../helpers/sse-fixtures";

const QUOTA_URL = "https://api.z.ai/api/paas/v4/quota";
const BILLING_URL = "https://api.z.ai/api/coding/paas/v4/billing";


describe("fetchZaiQuota", () => {
  test("fraction remaining maps to used percent", async () => {
    const result = await fetchZaiQuota("token", (async () =>
      jsonResponse({ data: { remainingFraction: 0.25 } })) as unknown as typeof fetch);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(75);
    expect(result.error).toBeNull();
    expect(result.plan).toBe("Z.AI");
  });

  test("absolute remaining with limit resolves proportionally", async () => {
    const result = await fetchZaiQuota("token", (async () =>
      jsonResponse({ data: { remaining: 250, limit: 1000 } })) as unknown as typeof fetch);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(75);
  });

  test("used over limit resolves as a ratio", async () => {
    const result = await fetchZaiQuota("token", (async () =>
      jsonResponse({ data: { used: 30, limit: 100 } })) as unknown as typeof fetch);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(30);
  });

  test("explicit percent is the fallback when no fraction or ratio resolves", async () => {
    const result = await fetchZaiQuota("token", (async () =>
      jsonResponse({ data: { percentUsed: 42 } })) as unknown as typeof fetch);
    expect(result.windows[0]?.usedPercent).toBe(42);
  });

  test("reads the nested quota envelope", async () => {
    const result = await fetchZaiQuota("token", (async () =>
      jsonResponse({ quota: { remainingFraction: 0.1, percentUsed: 90 } })) as unknown as typeof fetch);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(90);
  });

  test("unparseable bodies yield the no-data result", async () => {
    const result = await fetchZaiQuota("token", (async () =>
      jsonResponse({ data: {} })) as unknown as typeof fetch);
    expect(result.windows).toHaveLength(0);
    expect(result.error).toBe("No ZAI plan");
  });

  test("falls back to the billing endpoint when the quota endpoint fails", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: unknown) => {
      seen.push(String(input));
      if (String(input) === QUOTA_URL) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse({ data: { remainingFraction: 0.5 } });
    }) as unknown as typeof fetch;
    const result = await fetchZaiQuota("token", fetcher);
    expect(seen).toEqual([QUOTA_URL, BILLING_URL]);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(50);
  });

  test("a word-bounded 404 short-circuits to the no-plan result", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: unknown) => {
      seen.push(String(input));
      return jsonResponse({ error: "no plan (404)" }, 404);
    }) as unknown as typeof fetch;
    const result = await fetchZaiQuota("token", fetcher);
    expect(seen).toEqual([QUOTA_URL]);
    expect(result.error).toBe("No ZAI plan");
  });

  test("a longer digit run is not misread as a 404", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: unknown) => {
      seen.push(String(input));
      if (String(input) === QUOTA_URL) return jsonResponse({ error: "gateway 14040" }, 502);
      return jsonResponse({ data: { remainingFraction: 0.5 } });
    }) as unknown as typeof fetch;
    const result = await fetchZaiQuota("token", fetcher);
    expect(seen).toEqual([QUOTA_URL, BILLING_URL]);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(50);
  });

  test("an empty credential is rejected", async () => {
    await expect(fetchZaiQuota("  ", (async () => jsonResponse({})) as unknown as typeof fetch))
      .rejects.toThrow("ZAI credential is empty.");
  });
});

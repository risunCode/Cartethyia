import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/transport/gateway-error";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import { flagPoolCooldown } from "../../src/network/pool-health";

function rateLimitError(retryAfterMs?: number): GatewayError {
  return new GatewayError("quota_exceeded", 429, "Provider x rate limit", {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function fakeDb(calls: Array<Record<string, unknown>>) {
  return {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        calls.push(row);
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("flagPoolCooldown", () => {
  test("flags the volatile cooldown and mirrors one durable audit row", async () => {
    const selector = new NetworkPoolSelector();
    const rows: Array<Record<string, unknown>> = [];
    flagPoolCooldown(selector, fakeDb(rows), "pool-health-a", "OpenAI", rateLimitError(60_000));
    // The volatile flag resolves through the selector immediately (async write).
    await Bun.sleep(10);
    const state = await selector.isProviderCooldown("pool-health-a", "openai");
    expect(state.inCooldown).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityKind: "pool",
      networkPoolId: "pool-health-a",
      toStatus: "cooldown",
    });
  });

  test("falls back to the 15-minute default with no retryAfterMs", async () => {
    const selector = new NetworkPoolSelector();
    const rows: Array<Record<string, unknown>> = [];
    const before = Date.now();
    flagPoolCooldown(selector, fakeDb(rows), "pool-health-b", "xai", rateLimitError());
    await Bun.sleep(10);
    const state = await selector.isProviderCooldown("pool-health-b", "xai");
    expect(state.inCooldown).toBe(true);
    // Default 15 min: still cooling well after one minute from now.
    expect((state.resetsAt?.getTime() ?? 0)).toBeGreaterThan(before + 60_000);
    expect(rows).toHaveLength(1);
  });

  test("coalesces a repeated 429 for the same pair within the window", async () => {
    const selector = new NetworkPoolSelector();
    const rows: Array<Record<string, unknown>> = [];
    const db = fakeDb(rows);
    flagPoolCooldown(selector, db, "pool-health-c", "groq", rateLimitError(5_000));
    // Let the first audit write land its coalescing stamp before the repeat:
    // both flag paths are void-fired, so a synchronous second call races it.
    await Bun.sleep(10);
    flagPoolCooldown(selector, db, "pool-health-c", "GROQ", rateLimitError(5_000));
    await Bun.sleep(10);
    // Same pair (provider lowercased) inside the 15-min window: one row.
    expect(rows).toHaveLength(1);
  });

  test("a failing audit insert never rejects the dispatch path", async () => {
    const selector = new NetworkPoolSelector();
    const db = {
      insert: () => ({
        values: async () => {
          throw new Error("db down");
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // Must not throw: both writes are void-fired with internal catch.
    flagPoolCooldown(selector, db, "pool-health-d", "mistral", rateLimitError(5_000));
    await Bun.sleep(10);
    const state = await selector.isProviderCooldown("pool-health-d", "mistral");
    expect(state.inCooldown).toBe(true);
  });
});

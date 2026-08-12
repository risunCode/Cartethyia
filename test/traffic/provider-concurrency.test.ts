import { describe, expect, test } from "bun:test";
import { ProviderConcurrencyRegistry, providerModelKey } from "../../src/traffic/provider-concurrency";

describe("ProviderConcurrencyRegistry", () => {
  test("queues by provider/model and releases an idempotent lease", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 1, maxWaiters: 2 });
    const first = await registry.acquire("provider-a", "model-a");
    const secondPromise = registry.acquire("provider-a", "model-a");

    expect(registry.getMetrics("provider-a", "model-a")).toMatchObject({ limit: 1, active: 1, waiting: 1 });

    await first.release();
    const second = await secondPromise;
    expect(registry.getMetrics("provider-a", "model-a")).toMatchObject({ limit: 1, active: 1, waiting: 0 });

    await second.release();
    await second.release();
    expect(registry.getMetrics("provider-a", "model-a")).toMatchObject({ limit: 1, active: 0, waiting: 0 });
  });

  test("removes an aborted waiter without consuming capacity", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 1, maxWaiters: 1 });
    const first = await registry.acquire("provider-b", "model-b");
    const controller = new AbortController();
    const waiting = registry.acquire("provider-b", "model-b", controller.signal);

    controller.abort(new Error("caller stopped waiting"));
    await expect(waiting).rejects.toThrow("caller stopped waiting");
    expect(registry.getMetrics("provider-b", "model-b")).toMatchObject({ active: 1, waiting: 0 });

    await first.release();
    expect(registry.activeCount("provider-b", "model-b")).toBe(0);
  });

  test("bounds waiters and keeps provider/model keys collision-safe", async () => {
    const registry = new ProviderConcurrencyRegistry({ limit: 1, maxWaiters: 0 });
    const first = await registry.acquire("ab", "c");
    const rejected = registry.acquire("ab", "c");

    expect(providerModelKey("ab", "c")).not.toBe(providerModelKey("a", "bc"));
    await expect(rejected).rejects.toMatchObject({ kind: "concurrency_exceeded", retryable: true, routeScope: "provider" });

    await first.release();
  });

  test("keeps unlimited behavior when no cap is configured", async () => {
    const registry = new ProviderConcurrencyRegistry();
    const leases = await Promise.all(Array.from({ length: 8 }, () => registry.acquire("uncapped", "model")));

    expect(registry.activeCount("uncapped", "model")).toBe(8);
    await Promise.all(leases.map((lease) => lease.release()));
    expect(registry.activeCount("uncapped", "model")).toBe(0);
  });
});

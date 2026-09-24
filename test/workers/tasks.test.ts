import { describe, expect, test } from "bun:test";
import { ScheduledTaskRegistry } from "../../src/workers/tasks";

describe("ScheduledTaskRegistry", () => {
  test("runNow runs a named task immediately, bypassing its interval", async () => {
    let calls = 0;
    const registry = new ScheduledTaskRegistry();
    registry.register({ name: "on-demand", intervalMs: 60_000, run: () => void calls++ });
    await registry.runNow("on-demand");
    expect(calls).toBe(1);
  });

  test("runNow on an unregistered task name is a no-op", async () => {
    const registry = new ScheduledTaskRegistry();
    const result = await registry.runNow("missing");
    expect(result).toBeUndefined();
  });

  test("a concurrent runNow call is skipped while the task is still in flight", async () => {
    const gate = Promise.withResolvers<void>();
    let starts = 0;
    let completions = 0;
    const registry = new ScheduledTaskRegistry();
    registry.register({
      name: "gated",
      intervalMs: 60_000,
      run: async () => {
        starts++;
        await gate.promise;
        completions++;
      },
    });

    // Both calls are issued before either awaits anything internally, so
    // the re-entrancy guard is observed deterministically — no real clock
    // involved.
    const first = registry.runNow("gated");
    const second = registry.runNow("gated");
    await second;
    expect(starts).toBe(1);
    expect(completions).toBe(0);

    gate.resolve();
    await first;
    expect(completions).toBe(1);
  });

  test("a throwing task is caught and does not block a later run", async () => {
    let calls = 0;
    const registry = new ScheduledTaskRegistry();
    registry.register({
      name: "flaky",
      intervalMs: 60_000,
      run: () => {
        calls++;
        throw new Error("boom");
      },
    });
    await registry.runNow("flaky");
    await registry.runNow("flaky");
    expect(calls).toBe(2);
  });

  test("start schedules recurring ticks and stop cancels them", async () => {
    let calls = 0;
    const registry = new ScheduledTaskRegistry();
    registry.register({ name: "ticking", intervalMs: 5, run: () => void calls++ });
    registry.start();
    await Bun.sleep(40);
    await registry.stop();
    const afterStop = calls;
    expect(afterStop).toBeGreaterThanOrEqual(2);
    await Bun.sleep(30);
    expect(calls).toBe(afterStop);
  });

  test("start is idempotent — a second call schedules no duplicate timers", async () => {
    const registry = new ScheduledTaskRegistry();
    registry.register({ name: "ticking", intervalMs: 5, run: () => {} });
    // Same class under test (not external input): read the private timer
    // list once to assert scheduling without depending on wall-clock ticks.
    const internals: { timers: unknown[] } = registry as unknown as { timers: unknown[] };
    registry.start();
    registry.start();
    expect(internals.timers).toHaveLength(1);
    await registry.stop();
    expect(internals.timers).toHaveLength(0);
    // Stopping re-arms start: a restart after stop schedules exactly one.
    registry.start();
    expect(internals.timers).toHaveLength(1);
    await registry.stop();
  });
});
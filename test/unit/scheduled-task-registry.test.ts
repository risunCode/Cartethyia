import { afterEach, describe, expect, test } from "bun:test";
import { ScheduledTaskRegistry } from "../../src/workers/tasks";

/**
 * Late-registration and lifecycle rules of `ScheduledTaskRegistry`, as units.
 *
 * Production registers most tasks before `start()` (dependencies.ts) and some
 * after the registry exists but still before `start()` (app.ts), but nothing
 * about the registry's contract enforces that ordering — and the wiring depends
 * on `main.ts` calling `start()` last. These cases pin the guarantees the
 * wiring silently relies on: a task registered after `start()` runs, timers
 * are never stacked by a second `start()`, and `stop()` clears everything.
 */

const registries: ScheduledTaskRegistry[] = [];

function makeRegistry(): ScheduledTaskRegistry {
  const registry = new ScheduledTaskRegistry();
  registries.push(registry);
  return registry;
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.stop();
});

/** Waits long enough for an interval to fire at least `minRuns` times. */
function waitForRuns(count: () => number, minRuns: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = () => {
      if (count() >= minRuns) resolve();
      else if (Date.now() > deadline) reject(new Error(`only ${count()} runs after 2s`));
      else setTimeout(check, 10);
    };
    check();
  });
}

describe("ScheduledTaskRegistry late registration", () => {
  test("a task registered after start() gets a timer and runs", async () => {
    const registry = makeRegistry();
    registry.register({ name: "early", intervalMs: 10, run: () => {} });
    registry.start();
    let lateRuns = 0;
    registry.register({ name: "late", intervalMs: 10, run: () => { lateRuns += 1; } });
    await waitForRuns(() => lateRuns, 2);
    expect(lateRuns).toBeGreaterThan(0);
  });

  test("a task registered after start() with zero prior tasks still runs", async () => {
    const registry = makeRegistry();
    registry.start();
    let runs = 0;
    registry.register({ name: "only", intervalMs: 10, run: () => { runs += 1; } });
    await waitForRuns(() => runs, 2);
    expect(runs).toBeGreaterThan(0);
  });

  test("a second start() does not stack a second timer on a late task", async () => {
    const registry = makeRegistry();
    registry.start();
    let runs = 0;
    registry.register({ name: "t", intervalMs: 100, run: () => { runs += 1; } });
    registry.start(); // hot-reload-style second call
    await new Promise((resolve) => setTimeout(resolve, 260));
    await registry.stop();
    // One timer fires ~2 times in 260 ms; a stacked duplicate would fire ~4.
    // The 2x gap keeps this deterministic against timer jitter.
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThanOrEqual(3);
  });

  test("stop() clears late-registered timers and start() schedules again", async () => {
    const registry = makeRegistry();
    registry.start();
    let runs = 0;
    registry.register({ name: "t", intervalMs: 10, run: () => { runs += 1; } });
    await waitForRuns(() => runs, 1);
    await registry.stop();
    const atStop = runs;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toBe(atStop); // timer cleared, no further runs
    registry.start();
    await waitForRuns(() => runs, atStop + 1);
    expect(runs).toBeGreaterThan(atStop); // rescheduled after restart
  });

  test("runNow still finds a late-registered task by name", async () => {
    const registry = makeRegistry();
    registry.start();
    let runs = 0;
    registry.register({ name: "manual", intervalMs: 60_000, run: () => { runs += 1; } });
    await registry.runNow("manual");
    expect(runs).toBe(1);
  });
});

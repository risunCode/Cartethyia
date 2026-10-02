/**
 * Deterministic time for suites that would otherwise sleep.
 *
 * The previous suite awaited real timers — `Bun.sleep(10)` to let a health
 * sweep tick, `setTimeout(…, 50)` to let a cooldown lapse — and then asserted
 * on the result. That is a race against the scheduler, not a test: on a loaded
 * machine the sleep returns before the work is done and the assertion fails,
 * and on an idle one it passes while proving nothing about the boundary.
 *
 * Two tools replace it, chosen by what the code under test actually reads:
 *
 * - `withFrozenTime` pins `Date.now()` when the subject reads the wall clock
 *   directly (a cooldown deadline comparison, a TTL check).
 * - `withFakeTimers` advances Bun's timer queue when the subject *schedules*
 *   work (a retry backoff, a debounce). No wall-clock time passes at all.
 *
 * Both restore the real clock in a `finally`, so a failing assertion cannot
 * leave a later test running against frozen time.
 */
import { setSystemTime } from "bun:test";

/**
 * Runs `body` with `Date.now()` and `new Date()` pinned to `atMs`.
 *
 * Only the wall clock is affected: real timers still fire, so a suite that
 * needs both a fixed `now` and a live `setTimeout` keeps working.
 */
export async function withFrozenTime<T>(atMs: number, body: () => Promise<T> | T): Promise<T> {
  setSystemTime(new Date(atMs));
  try {
    return await body();
  } finally {
    setSystemTime();
  }
}

/**
 * Runs `body` with Bun's timers detached from the wall clock, then advances
 * them by `advanceMs`.
 *
 * Use when the subject schedules work whose *timing* is the assertion — a
 * backoff delay, a debounce window, a TTL reaper. The body installs the
 * schedule, `advanceMs` releases it, and the test observes the outcome without
 * ever sleeping. `await Bun.sleep(0)` between steps yields to the event loop
 * so a resolved promise chain can settle before the next assertion.
 */
export async function withFakeTimers<T>(
  body: (clock: FakeClock) => Promise<T> | T,
  options: { nowMs?: number } = {},
): Promise<T> {
  const realNow = Date.now;
  let fakeNow = options.nowMs ?? realNow.call(Date);
  const scheduled: { at: number; run: () => void; cancelled: boolean }[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  Date.now = () => fakeNow;
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    const entry = {
      at: fakeNow + (delay ?? 0),
      run: handler,
      cancelled: false,
    };
    scheduled.push(entry);
    // A real handle is returned so code that clears the timeout still works;
    // the entry's `cancelled` flag is what stops it from running.
    const handle = realSetTimeout(() => undefined, 2 ** 30);
    (handle as unknown as { __entry: typeof entry }).__entry = entry;
    return handle;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const entry = (handle as { __entry?: { cancelled: boolean } } | undefined)?.__entry;
    if (entry) entry.cancelled = true;
    realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
  }) as typeof globalThis.clearTimeout;

  const clock: FakeClock = {
    now: () => fakeNow,
    advance: async (ms: number) => {
      fakeNow += ms;
      // Run everything due in chronological order, letting each callback's
      // microtasks settle before the next one fires.
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = scheduled
          .filter((entry) => !entry.cancelled && entry.at <= fakeNow)
          .sort((a, b) => a.at - b.at);
        for (const entry of due) {
          entry.cancelled = true;
          entry.run();
          await Bun.sleep(0);
          progressed = true;
        }
      }
    },
  };

  try {
    const result = await body(clock);
    return result;
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

export interface FakeClock {
  /** Current fake epoch milliseconds. */
  now(): number;
  /** Advances the clock, running every timer that comes due in order. */
  advance(ms: number): Promise<void>;
}

/**
 * Scheduler for periodic maintenance tasks. Each task owns
 * only its domain work; this registry owns timer, re-entrancy, and logging
 * behavior.
 */
import { log } from "../observability/logger";

export interface ScheduledTask {
  readonly name: string;
  readonly intervalMs: number;
  /** Delay before the first run after the registry starts. */
  readonly initialDelayMs?: number;
  run(): Promise<unknown> | void;
}

/**
 * Runs `items` in completed waves that grow from 2 up to `maxConcurrency`.
 *
 * Growing the wave instead of starting at full width keeps a cold sweep from
 * stampeding every provider at once, while still finishing in a few waves
 * rather than one round trip per account. Each wave is awaited to completion
 * before the next starts, so at most `maxConcurrency` items are in flight.
 *
 * `shouldStop` is consulted between waves, never mid-wave, so a caller's
 * deadline cannot leave a half-finished wave behind.
 */
export async function runGrowingWaves<T>(
  items: readonly T[],
  options: {
    readonly maxConcurrency: number;
    readonly onItem: (item: T) => Promise<void> | void;
    readonly shouldStop?: () => boolean;
  },
): Promise<void> {
  const limit = Math.max(1, options.maxConcurrency);
  let offset = 0;
  let waveSize = Math.min(DEFAULT_INITIAL_BATCH_SIZE, limit);
  while (offset < items.length) {
    if (options.shouldStop?.() === true) return;
    const wave = items.slice(offset, offset + waveSize);
    offset += wave.length;
    await Promise.all(wave.map((item) => options.onItem(item)));
    waveSize = Math.min(waveSize + 1, limit);
  }
}

export const DEFAULT_INITIAL_BATCH_SIZE = 2;

/**
 * Tasks may be registered at any time: before `start()`, they are scheduled
 * when `start()` runs; after `start()`, each `register()` immediately schedules
 * that task. Registration order never decides whether a task runs.
 */
export class ScheduledTaskRegistry {
  private readonly tasks: ScheduledTask[] = [];
  private readonly timers: Timer[] = [];
  /**
   * Latched by `start()` and cleared by `stop()`. This is the idempotency and
   * late-registration flag: unlike `timers.length`, it stays true when `start()`
   * ran with no tasks yet, so a task registered afterwards is scheduled exactly
   * once (immediately) and a later `start()` call does not stack a second timer.
   */
  private started = false;
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  register(task: ScheduledTask): void {
    this.tasks.push(task);
    if (this.started) this.schedule(task);
  }

  /**
   * Schedules every registered task, respecting any initial delay. Idempotent: a
   * second call while started schedules nothing new, so `--hot` reloads cannot
   * stack duplicate sweeps — including for tasks registered after the first
   * `start()`, which already run on their own timers. `stop()` clears the
   * timers, after which `start()` schedules again.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks) this.schedule(task);
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Runs one named task immediately, bypassing its interval — for tests and manual triggers. */
  async runNow(name: string): Promise<void> {
    const task = this.tasks.find((t) => t.name === name);
    if (task) await this.runOnce(task);
  }

  /** Starts one task's interval timer: unref'd, so it never holds the process open. */
  private schedule(task: ScheduledTask): void {
    if (task.initialDelayMs !== undefined) {
      const timer = setTimeout(() => {
        if (!this.started) return;
        void this.runOnce(task);
        this.scheduleInterval(task);
      }, task.initialDelayMs);
      if (typeof timer.unref === "function") timer.unref();
      this.timers.push(timer);
      return;
    }
    this.scheduleInterval(task);
  }

  private scheduleInterval(task: ScheduledTask): void {
    const timer = setInterval(() => void this.runOnce(task), task.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.push(timer);
  }

  private async runOnce(task: ScheduledTask): Promise<void> {
    if (this.running.has(task.name)) return;
    this.running.add(task.name);
    const done = (async () => {
      try {
        await task.run();
      } catch (error) {
        log.error(`[scheduled-task:${task.name}] failed`, error as Error);
      }
    })();
    this.inFlight.add(done);
    try {
      await done;
    } finally {
      this.inFlight.delete(done);
      this.running.delete(task.name);
    }
  }
}
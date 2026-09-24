/**
 * Shared scheduler for bounded periodic maintenance tasks. Each task owns
 * only its domain work; this registry owns timer, re-entrancy, and logging
 * behavior.
 */
import { log } from "../observability/logger";

export interface ScheduledTask {
  readonly name: string;
  readonly intervalMs: number;
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

export class ScheduledTaskRegistry {
  private readonly tasks: ScheduledTask[] = [];
  private readonly timers: Timer[] = [];
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  register(task: ScheduledTask): void {
    this.tasks.push(task);
  }

  /**
   * Starts every registered task on its own interval timer. Idempotent: a
   * second call while timers are running schedules nothing new, so `--hot`
   * reloads cannot stack duplicate sweeps. `stop()` clears the timers, after
   * which `start()` schedules again.
   */
  start(): void {
    if (this.timers.length > 0) return;
    for (const task of this.tasks) {
      const timer = setInterval(() => void this.runOnce(task), task.intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      this.timers.push(timer);
    }
  }

  async stop(): Promise<void> {
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
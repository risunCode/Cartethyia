/**
 * Shared sweep skeleton for the bounded periodic maintenance workers.
 *
 * Every sweep is the same four steps — list targets, drop the ineligible ones,
 * run the due batch in growing waves, report counts — and each step has one
 * rule that must hold no matter which sweep runs it:
 *
 * - **Listing never rejects.** The timer path treats a rejection as a backstop,
 *   not a channel: a sweep that throws out of `list` is logged by the task
 *   registry with no domain context. A failed list is a logged skip.
 * - **One item's failure never cancels the wave.** Per-item errors are isolated
 *   and counted, so one dead account cannot strand the rest of the pass.
 * - **The budget is consulted between waves, never mid-wave.** A deadline that
 *   could cut a wave in half would leave work half-done with no record.
 *
 * The scheduler itself (`tasks.ts`) owns timers, re-entrancy, and the run
 * wrapper; this module owns only the domain lifecycle above.
 */
import { log } from "../observability/logger";
import { runGrowingWaves } from "./tasks";

export const DEFAULT_SWEEP_CONCURRENCY = 5;

/** Outcome counts for one sweep pass. */
export interface SweepResult {
  /** Targets the lister returned. */
  readonly listed: number;
  /** Targets dropped before the run: no refresher, not due, or over the cap. */
  readonly skipped: number;
  /** Targets the sweep actually attempted. */
  readonly attempted: number;
  /** Attempts whose work threw. */
  readonly failed: number;
  /**
   * True when the pass never ran because listing failed. Distinct from a
   * legitimately empty pass: a sweep reports nothing about a pass it could not
   * even start, so its caller skips the summary rather than reporting a
   * misleading all-zero tick.
   */
  readonly aborted: boolean;
}

/** What `select` returns: the batch to run, plus any extra drops it made. */
export interface SweepSelection<T> {
  readonly batch: readonly T[];
  /**
   * Targets dropped by selection itself (stale cache, over the per-pass cap).
   * Added on top of the drops `eligible` already reported.
   */
  readonly skipped?: number;
}

/** One sweep's domain hooks. */
export interface SweepPlan<T> {
  /** Log prefix, e.g. `quota-refresh`. */
  readonly name: string;
  /** Lists candidate targets. A rejection is logged and yields an empty pass. */
  readonly list: () => Promise<readonly T[]>;
  /**
   * Drops a target that cannot be worked at all (no registered refresher).
   * A rejection here counts as a skip, so a failing provider never strands
   * the accounts that follow it.
   */
  readonly eligible?: ((item: T) => Promise<boolean> | boolean) | undefined;
  /**
   * Narrows the eligible set to the batch this pass will run — ordering,
   * freshness filtering, and the per-pass cap. Absent means "run them all".
   */
  readonly select?:
    | ((items: readonly T[]) => Promise<SweepSelection<T>> | SweepSelection<T>)
    | undefined;
  /** The work for one target. Its throw is isolated and counted as a failure. */
  readonly run: (item: T) => Promise<void>;
  /** Per-item error channel. A sweep that handles its own errors may omit it. */
  readonly onItemError?: ((item: T, error: unknown) => void) | undefined;
  /** Maximum accounts in one completed wave. Defaults to 5. */
  readonly maxConcurrency?: number | undefined;
  /**
   * Run the batch one item at a time with a pause between items, instead of
   * in growing waves.
   *
   * Some upstreams (Google-backed OAuth token endpoints, notably) rate-limit a
   * burst of refreshes even at a low concurrency, so a wave is still too much
   * at once. Sequential + a delay spreads the pass out. The delay is skipped
   * after the last item. Absent means the default wave behavior.
   */
  readonly pace?:
    | {
        readonly interItemDelayMs: number;
        readonly sleep?: (ms: number) => Promise<void>;
      }
    | undefined;
  /** Wall-clock cap for the whole pass; the next wave does not start past it. */
  readonly budgetMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** The counts a pass that never got off the ground reports. */
export const EMPTY_SWEEP_RESULT: SweepResult = {
  listed: 0,
  skipped: 0,
  attempted: 0,
  failed: 0,
  aborted: true,
};

/**
 * Runs one non-overlapping sweep pass.
 *
 * Never rejects: every failure is isolated and surfaced through the returned
 * counts or `onItemError`, so the task registry's rejection path stays a
 * backstop rather than becoming the error channel.
 */
export async function runSweep<T>(plan: SweepPlan<T>): Promise<SweepResult> {
  const now = plan.now ?? Date.now;

  let targets: readonly T[];
  try {
    targets = await plan.list();
  } catch (error) {
    log.error(`[${plan.name}] sweep failed to list targets`, error as Error);
    return EMPTY_SWEEP_RESULT;
  }

  let skipped = 0;
  const eligible: T[] = [];
  for (const item of targets) {
    if (plan.eligible === undefined) {
      eligible.push(item);
      continue;
    }
    try {
      if (await plan.eligible(item)) eligible.push(item);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  let batch: readonly T[] = eligible;
  if (plan.select !== undefined) {
    const selection = await plan.select(eligible);
    batch = selection.batch;
    skipped += selection.skipped ?? 0;
  }

  const deadline = plan.budgetMs === undefined ? null : now() + plan.budgetMs;
  let attempted = 0;
  let failed = 0;

  const runOne = async (item: T): Promise<void> => {
    attempted += 1;
    try {
      await plan.run(item);
    } catch (error) {
      failed += 1;
      plan.onItemError?.(item, error);
    }
  };

  if (plan.pace !== undefined) {
    const sleep = plan.pace.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (const [index, item] of batch.entries()) {
      if (deadline !== null && now() >= deadline) break;
      await runOne(item);
      // Pause between items, never after the last: the delay exists to spread
      // load on the upstream, and trailing it only delays the pass's end.
      if (index < batch.length - 1 && plan.pace.interItemDelayMs > 0) {
        await sleep(plan.pace.interItemDelayMs);
      }
    }
  } else {
    await runGrowingWaves(batch, {
      maxConcurrency: Math.max(1, plan.maxConcurrency ?? DEFAULT_SWEEP_CONCURRENCY),
      ...(deadline === null ? {} : { shouldStop: () => now() >= (deadline as number) }),
      onItem: runOne,
    });
  }

  return { listed: targets.length, skipped, attempted, failed, aborted: false };
}

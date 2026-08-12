import { getInFlightCount } from "./in-flight";

const GC_RETRY_DELAY_MS = 1_000;

let gcPending = false;
let gcRetryTimer: ReturnType<typeof setTimeout> | null = null;

export interface GcScheduleResult {
  status: "scheduled" | "deferred" | "already_pending";
  inFlight: number;
}

/**
 * Requests process-wide asynchronous GC without synchronously pausing a live
 * proxy request. If proxy traffic is active, the request waits for an idle
 * point and retries; the Bun GC itself remains asynchronous.
 *
 * Started periodically by the runtime to reclaim idle process memory.
 * `Bun.gc(false)` is a non-blocking hint — unlike `Bun.gc(true)` it does not
 * stop the world, so calling it at an idle point keeps live streams moving
 * while still reclaiming the process heap between traffic spikes.
 */
export function scheduleGlobalGc(): GcScheduleResult {
  const inFlight = getInFlightCount();
  if (gcPending) return { status: "already_pending", inFlight };

  gcPending = true;
  scheduleAttempt();
  return { status: inFlight > 0 ? "deferred" : "scheduled", inFlight };
}

function scheduleAttempt(): void {
  if (getInFlightCount() > 0) {
    gcRetryTimer = setTimeout(scheduleAttempt, GC_RETRY_DELAY_MS);
    gcRetryTimer.unref?.();
    return;
  }

  gcPending = false;
  gcRetryTimer = null;
  Bun.gc(false);
}

/** Cancels a pending idle-GC retry during graceful shutdown or test teardown. */
export function cancelScheduledGc(): void {
  if (gcRetryTimer !== null) clearTimeout(gcRetryTimer);
  gcRetryTimer = null;
  gcPending = false;
}

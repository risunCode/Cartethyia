import type { ReactNode } from "react";
import { formatResetDistance } from "../lib/quota-formatters";

/**
 * Cooldown presentation shared by the two health dialogs.
 *
 * The Accounts tab and the Quota page both show one account's health, and both
 * need the same answer: *when* can this be retried? A model-scoped throttle (a
 * 429 for a single model) writes `modelCooldowns` and deliberately leaves
 * `cooldownUntil` untouched, because the account stays routable for every other
 * model — so a view that reads only `cooldownUntil` shows a 429 reason and no
 * time at all. The logic lives here rather than in either route so the two
 * cannot drift.
 */

/** Per-model backoffs still in force: how many, which ends soonest, and when. */
export function activeModelCooldowns(account: {
  readonly modelCooldowns?: Readonly<Record<string, string>> | undefined;
}): { count: number; modelId: string; until: string } | undefined {
  const entries = Object.entries(account.modelCooldowns ?? {}).filter(
    ([, at]) => Number.isFinite(new Date(at).getTime()) && new Date(at).getTime() > Date.now(),
  );
  let soonest: [string, string] | undefined;
  for (const entry of entries) {
    if (soonest === undefined || new Date(entry[1]).getTime() < new Date(soonest[1]).getTime()) {
      soonest = entry;
    }
  }
  return soonest === undefined
    ? undefined
    : { count: entries.length, modelId: soonest[0], until: soonest[1] };
}

/**
 * The instant the last per-model backoff expires, or null when none is in force.
 *
 * This is the countdown target: the timer must run until the *longest* backoff
 * expires, since stopping at the soonest would freeze the remaining badges
 * mid-count.
 */
export function lastModelCooldownAt(account: {
  readonly modelCooldowns?: Readonly<Record<string, string>> | undefined;
}): number | null {
  const times = Object.values(account.modelCooldowns ?? {})
    .map((at) => new Date(at).getTime())
    .filter((time) => Number.isFinite(time));
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * Status-line detail for a health dialog: the account-wide deadline and the
 * soonest per-model one, shown side by side rather than picking one.
 */
export function AccountStatusDetail({
  cooldownUntil,
  modelCooldowns,
}: {
  readonly cooldownUntil?: string | null | undefined;
  readonly modelCooldowns?: Readonly<Record<string, string>> | undefined;
}): ReactNode {
  const soonest = activeModelCooldowns({ modelCooldowns });
  if (!cooldownUntil && !soonest) return null;
  return (
    <>
      {cooldownUntil ? (
        <span style={{ fontSize: "11px", color: "var(--orange)" }}>
          Account: {formatResetDistance(cooldownUntil)}
        </span>
      ) : null}
      {soonest ? (
        <span style={{ fontSize: "11px", color: "var(--orange)" }} title={soonest.modelId}>
          {soonest.count} model{soonest.count === 1 ? "" : "s"} cooling · {soonest.modelId}{" "}
          {formatResetDistance(soonest.until)}
        </span>
      ) : null}
    </>
  );
}

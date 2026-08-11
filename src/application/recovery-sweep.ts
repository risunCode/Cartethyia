/**
 *
 * Without this sweep, a `cooling_down` account only becomes usable again
 * lazily: the routing layer's `isRecordUsable` check passes once
 * `nowMs >= disabledUntilMs`, but the stored record stays `cooling_down`
 * until a request happens to select it and `recordSuccess` fires. This
 * sweep transitions expired cooldowns to `healthy` in storage so:
 *   - the dashboard reflects the recovered state immediately,
 *   - the routing layer sees a healthy record (not a cooling one that
 *     happens to be past its retryAt),
 *   - expired per-model locks are cleared (the `ModelLockStore.listExpired`
 *     capability that was previously never invoked by any sweep).
 *
 * Memory safety (mirrors OAuthKeepalive):
 * - The interval timer is `unref()`ed so it never keeps the process alive.
 * - Failures are swallowed — the next interval retries.
 * - No upstream calls are issued here; this is a storage-state cleanup,
 *   not a half-open probe. The graduated backoff (cooldownDelayMs) already
 *   keeps cooldowns short, so a network probe is unnecessary overhead.
 */

import type { AccountHealthManager, AccountHealthRecord, ModelLockStore } from "./auth/credentials";
import { sanitizeMessage, type ModelLockRecord } from "./contracts";

const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

export interface AccountRecoverySweepOptions {
  readonly intervalMs?: number;
  readonly nowMs?: () => number;
}

export class AccountRecoverySweep {
  private readonly intervalMs: number;
  private readonly nowMs: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly accountHealth: AccountHealthManager,
    private readonly modelLockStore: ModelLockStore | null,
    options: AccountRecoverySweepOptions = {},
  ) {
    this.intervalMs = Math.max(15_000, options.intervalMs ?? SWEEP_INTERVAL_MS);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        console.warn(`[RecoverySweep] sweep failed: ${sanitizeMessage(error)}`);
      });
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    const now = this.nowMs();

    // 1. Transition expired account cooldowns → healthy.
    let records: readonly AccountHealthRecord[];
    try {
      records = await this.accountHealth.list();
    } catch {
      return;
    }
    const expired = records.filter(
      (r) => r.status === "cooling_down" && r.disabledUntilMs !== null && now >= r.disabledUntilMs,
    );
    await Promise.allSettled(
      expired.map((r) => this.accountHealth.recordSuccess(r.accountId, r.providerId)),
    );

    // 2. Clear expired per-model locks (listExpired was previously dead).
    if (this.modelLockStore !== null) {
      let locks: readonly ModelLockRecord[];
      try {
        locks = await this.modelLockStore.listExpired(now);
      } catch {
        return;
      }
      await Promise.allSettled(
        locks.map((l) => this.accountHealth.clearModelLock(l.accountId, l.modelId)),
      );
    }
  }
}

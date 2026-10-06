// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  consoleLockouts,
} from "../../persistence/schema";

import type { CartethyiaDatabase } from "../../persistence/db-handle";

export class ConsoleLockoutStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async getLockedUntil(ip: string): Promise<Date | null | undefined> {
    const rows = await this.db
      .select({ lockedUntil: consoleLockouts.lockedUntil })
      .from(consoleLockouts)
      .where(eq(consoleLockouts.ip, ip))
      .limit(1);
    return rows[0]?.lockedUntil;
  }

  async upsertFailure(
    ip: string,
    reason: string,
    now: Date,
    windowUntil: Date,
  ): Promise<number> {
    const rows = await this.db
      .insert(consoleLockouts)
      .values({ ip, failureCount: 1, windowUntil, reason, updatedAt: now })
      .onConflictDoUpdate({
        target: consoleLockouts.ip,
        set: {
          // Within the sliding failure window: increment. Window expired: reset to 1.
          failureCount: sql`CASE WHEN ${consoleLockouts.windowUntil} > ${now} THEN ${consoleLockouts.failureCount} + 1 ELSE 1 END`,
          windowUntil: sql`CASE WHEN ${consoleLockouts.windowUntil} > ${now} THEN ${consoleLockouts.windowUntil} ELSE ${windowUntil} END`,
          reason,
          updatedAt: now,
        },
      })
      .returning({ failureCount: consoleLockouts.failureCount });
    return rows[0]?.failureCount ?? 1;
  }

  async lock(ip: string, lockedUntil: Date, now: Date): Promise<void> {
    await this.db
      .update(consoleLockouts)
      .set({ lockedUntil, updatedAt: now })
      .where(eq(consoleLockouts.ip, ip));
  }

  async clearFailures(ip: string): Promise<void> {
    await this.db.delete(consoleLockouts).where(eq(consoleLockouts.ip, ip));
  }
}

export class ConsoleLockoutService {
  private readonly maxFailures: number;
  private readonly lockoutDurationMs: number;
  private readonly failureWindowMs = 15 * 60 * 1000;
  private readonly store: ConsoleLockoutStore;

  constructor(
    private readonly db: CartethyiaDatabase,
    maxFailures = 5,
    lockoutDurationMs = 60 * 60 * 1000,
  ) {
    this.store = new ConsoleLockoutStore(db);
    this.maxFailures = maxFailures;
    this.lockoutDurationMs = lockoutDurationMs;
  }

  /**
   * Whole seconds remaining on `ip`'s lock, or `0` when it is not locked.
   *
   * The login route reports this as `retry-after`. The lock is a fixed window
   * from the last failure, so the real wait shrinks toward zero while a
   * hardcoded value never does — every client that retried partway through a
   * lock was told to wait the full duration again. A locked row always reports
   * at least one second, because a 429 must not carry `retry-after: 0`.
   */
  async remainingLockSeconds(ip: string, now = Date.now()): Promise<number> {
    const lockedUntil = await this.store.getLockedUntil(ip);
    if (lockedUntil === null || lockedUntil === undefined) return 0;
    const remainingMs = lockedUntil.getTime() - now;
    return remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0;
  }

  async isLocked(ip: string): Promise<boolean> {
    return (await this.remainingLockSeconds(ip)) > 0;
  }

  async recordFailure(ip: string, reason: string): Promise<boolean> {
    if (await this.isLocked(ip)) return true;

    const now = new Date();
    const windowUntil = new Date(now.getTime() + this.failureWindowMs);
    const count = await this.store.upsertFailure(ip, reason, now, windowUntil);
    if (count < this.maxFailures) return false;

    const lockedUntil = new Date(now.getTime() + this.lockoutDurationMs);
    await this.store.lock(ip, lockedUntil, now);
    await this.logBanAudit(ip, reason, count, this.lockoutDurationMs);
    return true;
  }

  private async logBanAudit(
    ip: string,
    reason: string,
    attempts: number,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.db.insert(adminAuditLog).values({
        id: randomUUID(),
        actor: "system:ip_guard",
        action: "security.ip_banned",
        target: `ip:${ip}`,
        detail: {
          ip,
          reason,
          failed_attempts: attempts,
          ttl_seconds: Math.floor(durationMs / 1000),
          banned_until: new Date(Date.now() + durationMs).toISOString(),
          enforcement: "full_network_lockout",
        },
      });
    } catch {
      // Best-effort audit logging; the ban itself remains enforced via the DB row.
    }
  }

  async clearFailures(ip: string): Promise<void> {
    await this.store.clearFailures(ip);
  }
}

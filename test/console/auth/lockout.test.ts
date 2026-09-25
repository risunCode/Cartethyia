import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/persistence/postgres";
import { adminAuditLog, consoleLockouts } from "../../../src/persistence/schema";
import { ConsoleLockoutService } from "../../../src/console/auth/service";
import { dbDescribe } from "../../helpers/db-gate";

describe("lockout.test.ts", () => {
function testIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 255)}`;
}

dbDescribe("ConsoleLockoutService — real DB persistence", () => {
  const usedIps: string[] = [];

  afterEach(async () => {
    const db = getDb();
    for (const ip of usedIps.splice(0)) {
      await db.delete(consoleLockouts).where(eq(consoleLockouts.ip, ip));
      await db.delete(adminAuditLog).where(eq(adminAuditLog.target, `ip:${ip}`));
    }
  });

  test("does not lock before reaching the failure threshold", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 5, 60_000);

    for (let i = 0; i < 4; i++) {
      const banned = await service.recordFailure(ip, "invalid_password");
      expect(banned).toBe(false);
    }
    expect(await service.isLocked(ip)).toBe(false);
  });

  test("locks after the failure threshold and persists a lockedUntil row", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 3, 60_000);

    expect(await service.recordFailure(ip, "invalid_password")).toBe(false);
    expect(await service.recordFailure(ip, "invalid_password")).toBe(false);
    expect(await service.recordFailure(ip, "invalid_password")).toBe(true);

    expect(await service.isLocked(ip)).toBe(true);

    const rows = await db.select().from(consoleLockouts).where(eq(consoleLockouts.ip, ip));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lockedUntil).not.toBeNull();
    expect(rows[0]!.failureCount).toBeGreaterThanOrEqual(3);
  });

  test("a ban recorded by one service instance is visible to a brand new instance", async () => {
    // Proves the fix: state now lives in Postgres, not a static in-process
    // map — a second process (or this instance, after restart) sees it.
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const writer = new ConsoleLockoutService(db, 2, 60_000);
    expect(await writer.recordFailure(ip, "invalid_password")).toBe(false);
    expect(await writer.recordFailure(ip, "invalid_password")).toBe(true);

    const reader = new ConsoleLockoutService(db, 2, 60_000);
    expect(await reader.isLocked(ip)).toBe(true);
  });

  test("recordFailure once already locked returns true without re-incrementing", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 2, 60_000);
    expect(await service.recordFailure(ip, "invalid_password")).toBe(false);
    expect(await service.recordFailure(ip, "invalid_password")).toBe(true);

    const before = await db.select().from(consoleLockouts).where(eq(consoleLockouts.ip, ip));
    expect(await service.recordFailure(ip, "invalid_password")).toBe(true);
    const after = await db.select().from(consoleLockouts).where(eq(consoleLockouts.ip, ip));
    expect(after[0]!.failureCount).toBe(before[0]!.failureCount);
  });

  test("remainingLockSeconds reports the real shrinking remainder, not the full duration", async () => {
    // The login route publishes this as `retry-after`. A hardcoded 3600 told a
    // client whose lock had 5 seconds left to wait a full hour again.
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 2, 3_600_000);

    expect(await service.remainingLockSeconds(ip)).toBe(0);
    await service.recordFailure(ip, "invalid_password");
    await service.recordFailure(ip, "invalid_password");

    const lockedFor = await service.remainingLockSeconds(ip);
    expect(lockedFor).toBeGreaterThan(3_500);
    expect(lockedFor).toBeLessThanOrEqual(3_600);

    // A later read sees the remainder shrink rather than repeating the window.
    const later = await service.remainingLockSeconds(ip, Date.now() + 3_000_000);
    expect(later).toBeGreaterThan(500);
    expect(later).toBeLessThanOrEqual(600);
  });

  test("remainingLockSeconds returns 0 once the lock has elapsed", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 2, 60_000);
    await service.recordFailure(ip, "invalid_password");
    await service.recordFailure(ip, "invalid_password");

    expect(await service.remainingLockSeconds(ip, Date.now() + 120_000)).toBe(0);
    expect(await service.isLocked(ip)).toBe(true);
  });

  test("clearFailures removes the row so a fresh window starts clean", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 5, 60_000);
    await service.recordFailure(ip, "invalid_password");
    await service.recordFailure(ip, "invalid_password");

    await service.clearFailures(ip);

    const rows = await db.select().from(consoleLockouts).where(eq(consoleLockouts.ip, ip));
    expect(rows).toHaveLength(0);
    expect(await service.isLocked(ip)).toBe(false);
  });

  test("records an admin_audit_log entry when a ban is applied", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    const service = new ConsoleLockoutService(db, 1, 60_000);
    await service.recordFailure(ip, "unknown_user");

    const audit = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.target, `ip:${ip}`));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("security.ip_banned");
  });

  test("failures outside the sliding window reset the count instead of accumulating forever", async () => {
    const db = getDb();
    const ip = testIp();
    usedIps.push(ip);
    // windowMs is fixed at 15 minutes internally; simulate an expired window
    // by writing an already-expired windowUntil directly, then recording one
    // more failure — it must reset to 1, not keep accumulating.
    await db.insert(consoleLockouts).values({
      ip,
      failureCount: 4,
      windowUntil: new Date(Date.now() - 1000),
    });
    const service = new ConsoleLockoutService(db, 5, 60_000);
    expect(await service.recordFailure(ip, "invalid_password")).toBe(false);

    const rows = await db.select().from(consoleLockouts).where(eq(consoleLockouts.ip, ip));
    expect(rows[0]!.failureCount).toBe(1);
  });
});
});

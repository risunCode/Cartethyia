/**
 * A wrong password must say how many attempts remain, and the last one must
 * lock instead of claiming attempts are left. The count is read back from the
 * row the failure just wrote, so a message that counted locally would drift
 * from the lock the route actually takes.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { consoleUsers, tenants } from "../../src/persistence/schema";
import { ConsoleCredentialService } from "../../src/console/auth/credentials";
import { ConsoleLockoutService } from "../../src/console/auth/lockout";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

/** The same sentence the login route builds after a rejected password. */
async function failureMessage(lockout: ConsoleLockoutService, key: string): Promise<string> {
  const remaining = lockout.maxFailures - (await lockout.failureCount(key));
  const left = remaining === 1 ? "1 attempt left" : `${remaining} attempts left`;
  return `Wrong username or password. ${left} before this login is locked for 1 hour.`;
}

test("a wrong password counts down, then locks instead of offering another try", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-lockout-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Default", status: "active" });
    await db.insert(consoleUsers).values({
      id: randomUUID(),
      tenantId,
      username: "admin",
      passwordHash: await new ConsoleCredentialService().hashPassword("correct"),
      isActive: true,
      isFirstBoot: false,
      isPlatformAdmin: true,
    });

    const lockout = new ConsoleLockoutService(db);
    const key = "admin:203.0.113.7";

    const seen: string[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await lockout.recordFailure(key, "invalid_password")).toBe(false);
      seen.push(await failureMessage(lockout, key));
    }
    expect(seen).toEqual([
      "Wrong username or password. 4 attempts left before this login is locked for 1 hour.",
      "Wrong username or password. 3 attempts left before this login is locked for 1 hour.",
      "Wrong username or password. 2 attempts left before this login is locked for 1 hour.",
      "Wrong username or password. 1 attempt left before this login is locked for 1 hour.",
    ]);

    // The fifth failure is the lock. A message built after it would promise
    // attempts that no longer exist, so the route must take the lock branch.
    expect(await lockout.recordFailure(key, "invalid_password")).toBe(true);
    expect(await lockout.remainingLockSeconds(key)).toBeGreaterThan(0);
    // A different address for the same username is a different key.
    expect(await lockout.failureCount("admin:203.0.113.8")).toBe(0);
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});

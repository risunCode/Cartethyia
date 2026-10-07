/**
 * Login reads the user row back through `userRecord`, which demands the
 * booleans Drizzle's schema declares. SQLite stores booleans as integers, so
 * a row written by setup and read back on SQLite must still pass that check —
 * otherwise a correct password is reported as "Invalid credentials".
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
import { readUsers } from "../../src/console/auth/user-store";
import { userRecord } from "../../src/console/auth/row-coercion";

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

test("a user written by setup reads back as a login-able record on SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-login-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  try {
    await applySqliteMigrations(sqlite);
    const handle = buildSqliteHandle(sqlite);
    const db = handle.db;

    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Default", status: "active" });

    const password = "correct horse battery";
    const passwordHash = await new ConsoleCredentialService().hashPassword(password);
    await db.insert(consoleUsers).values({
      id: randomUUID(),
      tenantId,
      username: "admin",
      email: "admin@localhost",
      passwordHash,
      displayName: "Administrator",
      isFirstBoot: false,
      isActive: true,
      isPlatformAdmin: true,
    });

    const rows = await readUsers(db, "admin");
    const user = userRecord(rows[0]);
    expect(user).toBeDefined();
    expect(user?.isActive).toBe(true);
    expect(user?.isPlatformAdmin).toBe(true);
    expect(user?.isFirstBoot).toBe(false);
    expect(user?.passwordHash.startsWith("$argon2id$")).toBe(true);
    // Timestamps come back as text from bun:sqlite. Login's session path
    // rejects a row whose dates are not `Date`, so the read must convert them.
    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(user?.updatedAt).toBeInstanceOf(Date);
  } finally {
    sqlite.close();
    removeDir(dir);
  }
});

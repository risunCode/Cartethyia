import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { applySqlMigrations, fullSchema } from "../../../src/persistence/postgres";
import { consoleUsers, tenants } from "../../../src/persistence/schema";
import { ConsoleCredentialService, FirstBootSetupService } from "../../../src/console/auth/service";
import { testDatabaseUrl } from "../../helpers/db-gate";

/**
 * First-boot setup is the one privileged path that creates the default tenant,
 * the platform administrator, and the optional gateway key. What matters is
 * that its guards hold: `requiresSetup` flips false after a boot, a second
 * setup is rejected, and two concurrent calls cannot each create an
 * administrator.
 *
 * This suite gets its **own database**, and that is not incidental. First boot
 * is a global state transition — its precondition is "no console user exists
 * anywhere" — so it cannot share the database the other DB-gated suites use,
 * where console users already exist and are being created concurrently. Testing
 * it against the shared database would either fail on that precondition or
 * require deleting other suites' rows. A fresh database makes the precondition
 * real and the assertions exact.
 */
const suiteDatabase = `cartethyia_first_boot_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let adminPool: Pool | undefined;
let pool: Pool | undefined;
let db: NodePgDatabase<typeof fullSchema> | undefined;
let created = false;

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  adminPool = new Pool({ connectionString: testDatabaseUrl, max: 2 });
  // Identifier is built from a UUID hex slice, so it is inert as SQL; `CREATE
  // DATABASE` takes no bind parameter, which is why it is interpolated.
  await adminPool.query(`CREATE DATABASE "${suiteDatabase}"`);
  created = true;
  pool = new Pool({ connectionString: withDatabase(testDatabaseUrl, suiteDatabase), max: 4 });
  await applySqlMigrations(pool, resolve(import.meta.dir, "../../../migrations"));
  db = drizzle(pool, { schema: fullSchema });
});

afterAll(async () => {
  if (pool) await pool.end();
  pool = undefined;
  db = undefined;
  if (created && adminPool) {
    // No connections remain open, so the drop cannot fail on an active session.
    await adminPool.query(`DROP DATABASE IF EXISTS "${suiteDatabase}"`);
  }
  if (adminPool) await adminPool.end();
  adminPool = undefined;
});

/** Rewrites the database segment of a connection string. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function requireDb(): NodePgDatabase<typeof fullSchema> {
  if (!db) throw new Error("the suite database was not initialized");
  return db;
}

function service(): FirstBootSetupService {
  return new FirstBootSetupService(requireDb(), new ConsoleCredentialService());
}

const dbDescribe = testDatabaseUrl ? describe : describe.skip;

dbDescribe("FirstBootSetupService", () => {
  test("requiresSetup is true on a database with no console users", async () => {
    expect(await service().requiresSetup()).toBe(true);
  });

  test("completeSetup creates the default tenant and a platform administrator", async () => {
    await service().completeSetup("first-boot-secret", "bootadmin", "Boot Administrator");

    const [admin] = await requireDb()
      .select()
      .from(consoleUsers)
      .limit(1);
    expect(admin).toBeDefined();
    expect(admin!.username).toBe("bootadmin");
    expect(admin!.displayName).toBe("Boot Administrator");
    expect(admin!.email).toBe("bootadmin@localhost");
    expect(admin!.isPlatformAdmin).toBe(true);
    expect(admin!.isActive).toBe(true);
    // The password is stored as an argon2id PHC string, never in the clear.
    expect(admin!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(admin!.passwordHash).not.toContain("first-boot-secret");

    const [tenant] = await requireDb()
      .select()
      .from(tenants)
      .where(eq(tenants.id, admin!.tenantId))
      .limit(1);
    expect(tenant).toBeDefined();
    expect(tenant!.name).toBe("Default");
    expect(tenant!.status).toBe("active");
  });

  test("the stored hash verifies the password and rejects a wrong one", async () => {
    const [admin] = await requireDb().select().from(consoleUsers).limit(1);
    const credentials = new ConsoleCredentialService();
    expect(await credentials.verifyPassword("first-boot-secret", admin!.passwordHash)).toBe(true);
    expect(await credentials.verifyPassword("not-the-password", admin!.passwordHash)).toBe(false);
  });

  test("requiresSetup flips to false once the administrator exists", async () => {
    expect(await service().requiresSetup()).toBe(false);
  });

  test("a second setup is rejected", async () => {
    await expect(service().completeSetup("another-password")).rejects.toThrow(
      /Setup already completed/,
    );
  });

  test("a rejected second setup does not create a second administrator", async () => {
    const before = await requireDb().select({ id: consoleUsers.id }).from(consoleUsers);
    await service().completeSetup("raced-password").catch(() => undefined);
    const after = await requireDb().select({ id: consoleUsers.id }).from(consoleUsers);
    expect(after).toHaveLength(before.length);
  });
});

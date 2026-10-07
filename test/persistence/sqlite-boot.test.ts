/**
 * The SQLite backend boots the same way production does.
 *
 * These open a real file, run `applySqliteMigrations` — the function
 * `bootDatabase` calls — and read back through the handle the stores receive.
 * An in-memory database would not prove the file path, the directory
 * creation, or that a second boot records nothing new.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySqliteMigrations,
  buildSqliteHandle,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import { eq, sql } from "drizzle-orm";
import { DrizzleApiKeyStore } from "../../src/persistence/stores/api-key-store";
import { apiKeys, consoleLockouts, tenants } from "../../src/persistence/schema";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cartethyia-sqlite-"));
}

/**
 * Windows keeps a WAL database's files locked for a moment after `close()`,
 * so an immediate remove fails with EBUSY even though the handle is gone.
 * The assertions have already run by the time this is called; a leftover
 * temp dir is not a failed boot.
 */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

test("a fresh file migrates, serves a query, and a second boot applies nothing", async () => {
  const dir = freshDir();
  try {
    const file = join(dir, "nested", "cartethyia.sqlite");
    const sqlite = createSqliteDatabase(file);
    await applySqliteMigrations(sqlite);

    // The pragmas are set for their effect, so the test reads them back rather
    // than trusting that `exec` succeeded. A pragma SQLite rejected silently
    // would leave the default here.
    const pragma = (name: string): unknown =>
      Object.values(sqlite.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(1);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("temp_store")).toBe(2);

    const handle = buildSqliteHandle(sqlite);
    const tenants = await handle.query("SELECT count(*) AS c FROM tenants");
    expect(tenants.rows).toEqual([{ c: 0 }]);

    const ledger = await handle.query(
      "SELECT count(*) AS c FROM cartethyia_schema_migrations",
    );
    const recorded = (ledger.rows[0] as { c: number }).c;
    expect(recorded).toBeGreaterThan(0);

    // Re-applying must not insert a second ledger row per file, and must not
    // attempt to recreate a table.
    await applySqliteMigrations(sqlite);
    const again = await handle.query(
      "SELECT count(*) AS c FROM cartethyia_schema_migrations",
    );
    expect(again.rows).toEqual([{ c: recorded }]);

    await handle.close();
  } finally {
    removeDir(dir);
  }
});

test("a database that already has its tables records the baseline instead of replaying it", async () => {
  const dir = freshDir();
  try {
    const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
    await applySqliteMigrations(sqlite);
    // Forget the ledger, keep the tables: the state of a database built by a
    // baseline this release no longer ships.
    sqlite.exec("DELETE FROM cartethyia_schema_migrations");

    await applySqliteMigrations(sqlite);
    const recorded = sqlite
      .prepare("SELECT migration_id FROM cartethyia_schema_migrations")
      .all() as { migration_id: string }[];
    expect(recorded.map((row) => row.migration_id)).toContain("0000_baseline.sql");
    sqlite.close();
  } finally {
    removeDir(dir);
  }
});

test("a migration that fails names the file and records nothing for it", async () => {
  const dir = freshDir();
  try {
    const folder = join(dir, "migrations");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(folder);
    writeFileSync(join(folder, "0000_baseline.sql"), "CREATE TABLE t (id text);\n--> statement-breakpoint\n");
    writeFileSync(join(folder, "0001_broken.sql"), "CREATE TABLE nope this is not sql;\n");

    const sqlite = new Database(":memory:");
    await expect(applySqliteMigrations(sqlite, folder)).rejects.toThrow(/Migration 0001_broken\.sql failed/);
    const recorded = sqlite
      .prepare("SELECT migration_id FROM cartethyia_schema_migrations")
      .all() as { migration_id: string }[];
    expect(recorded.map((row) => row.migration_id)).toEqual(["0000_baseline.sql"]);
    sqlite.close();
  } finally {
    removeDir(dir);
  }
});

test("the prepared auth lookup returns the camelCase fields auth reads", async () => {
  const dir = freshDir();
  try {
    const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
    await applySqliteMigrations(sqlite);
    const handle = buildSqliteHandle(sqlite);
    // The store reads the prepared statements off the process handle, which
    // boot registers. This test builds the handle itself, so it registers it
    // the same way and puts the previous one back afterwards.
    const globals = globalThis as { __cartethyiaHandle?: typeof handle };
    const previous = globals.__cartethyiaHandle;
    globals.__cartethyiaHandle = handle;

    const [tenant] = await handle.db
      .insert(tenants)
      .values({ name: "auth", status: "active" })
      .returning({ id: tenants.id });
    if (!tenant) throw new Error("tenant insert returned no row");
    // A share template carries no hash; a personal key carries one and no
    // parent. The mode check rejects any other shape, so the row under test
    // is a personal key and the parent lookup is exercised through it.
    const [parent] = await handle.db
      .insert(apiKeys)
      .values({
        tenantId: tenant.id,
        keyMode: "share",
        label: "template",
        scopes: ["routing:invoke"],
      })
      .returning({ id: apiKeys.id });
    if (!parent) throw new Error("parent insert returned no row");
    await handle.db.insert(apiKeys).values({
      tenantId: tenant.id,
      keyMode: "personal",
      keyHash: "personal-hash",
      label: "personal",
      scopes: ["routing:invoke"],
      isDefault: true,
      lifetimeTokensConsumed: 7,
      requestsPerMinute: 30,
      modelList: ["gpt-4"],
      clientRouterDenylist: ["router-a"],
    });
    await handle.db.insert(apiKeys).values({
      tenantId: tenant.id,
      keyMode: "share",
      parentKeyId: parent.id,
      keyHash: "child-hash",
      issuedClientIp: "203.0.113.7",
      issuedClientIpKey: "ip-key",
      label: "child",
      scopes: ["routing:invoke"],
      lifetimeTokensConsumed: 4,
    });

    const store = new DrizzleApiKeyStore(handle.db);
    const row = await store.findActiveByHash("personal-hash");
    // These are the fields `resolveApiKeyAuthorization` reads. A mapping that
    // keeps SQLite's snake_case keys typechecks and then hands auth undefined.
    expect(row?.tenantId).toBe(tenant.id);
    expect(row?.parentKeyId).toBeNull();
    expect(row?.keyMode).toBe("personal");
    expect(row?.isDefault).toBe(true);
    expect(row?.enabled).toBe(true);
    expect(row?.scopes).toEqual(["routing:invoke"]);
    expect(row?.modelList).toEqual(["gpt-4"]);
    expect(row?.clientRouterDenylist).toEqual(["router-a"]);
    expect(row?.requestsPerMinute).toBe(30);
    expect(row?.lifetimeTokensConsumed).toBe(7);

    const child = await store.findActiveByHash("child-hash");
    expect(child?.parentKeyId).toBe(parent.id);
    const parentById = await store.findActiveById(parent.id);
    expect(parentById?.id).toBe(parent.id);
    expect(await store.sumChildrenConsumed(parent.id)).toBe(4);
    expect(await store.findActiveByHash("missing")).toBeUndefined();

    if (previous === undefined) delete globals.__cartethyiaHandle;
    else globals.__cartethyiaHandle = previous;
    await handle.close();
  } finally {
    removeDir(dir);
  }
});

test("execute returns rows, and a transaction can call it", async () => {
  const dir = freshDir();
  try {
    const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
    await applySqliteMigrations(sqlite);
    const handle = buildSqliteHandle(sqlite);

    // Readiness reads the migration ledger through `execute` and treats an
    // empty `rows` as "not applied", so a select that returns nothing here
    // would leave a migrated database permanently not ready.
    const ledger = await handle.db.execute(
      sql`SELECT count(*) AS c FROM cartethyia_schema_migrations`,
    );
    expect((ledger as unknown as { rows: { c: number }[] }).rows[0]?.c).toBeGreaterThan(0);

    // First-boot setup takes its lock through `transaction.execute`. The
    // transaction builder is a fresh object, so the handle's alias does not
    // reach it unless the wrapper adds it.
    await handle.db.transaction(async (tx) => {
      const inside = await tx.execute(sql`SELECT 1 AS n`);
      expect((inside as unknown as { rows: { n: number }[] }).rows).toEqual([{ n: 1 }]);
    });

    await handle.close();
  } finally {
    removeDir(dir);
  }
});

test("a Date bound by Drizzle is stored, not rejected", async () => {
  // bun:sqlite refuses a Date binding, and the shared pg-core schema binds
  // timestamps as Date. A failed login writes one; without the conversion the
  // whole login answered 500 instead of "invalid credentials".
  const dir = freshDir();
  try {
    const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
    await applySqliteMigrations(sqlite);
    const handle = buildSqliteHandle(sqlite);
    const until = new Date("2026-10-07T06:00:00.000Z");
    await handle.db.insert(consoleLockouts).values({ ip: "203.0.113.7", failureCount: 1 });
    // The lockout upsert compares the window against `now` inside the SQL
    // (`CASE WHEN window_until > ${now}`), which is where bun:sqlite rejected
    // the Date and turned a wrong password into a 500.
    await handle.db
      .update(consoleLockouts)
      .set({ windowUntil: sql`CASE WHEN ${consoleLockouts.windowUntil} > ${until} THEN ${until} ELSE ${until} END` })
      .where(eq(consoleLockouts.ip, "203.0.113.7"));
    const rows = await handle.db.select().from(consoleLockouts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.windowUntil).toEqual(until);
    await handle.close();
  } finally {
    removeDir(dir);
  }
});

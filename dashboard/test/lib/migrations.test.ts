import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ChecksumMismatchError,
  checksum,
  discoverMigrations,
  MissingRollbackError,
  parseMigrationName,
  rollbackMigrations,
  runMigrations,
  status,
  type AppliedMigration,
} from "../../src/lib/migrations";
import type { PgPoolHandle } from "../../src/lib/postgres";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cartethyia-migrations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseMigrationName", () => {
  test("splits on the first underscore", () => {
    expect(parseMigrationName("0001_initial.sql")).toEqual({ version: "0001", name: "initial" });
    expect(parseMigrationName("0002_add_user_settings.sql")).toEqual({
      version: "0002",
      name: "add_user_settings",
    });
  });

  test("handles a filename with no underscore", () => {
    expect(parseMigrationName("0001.sql")).toEqual({ version: "0001", name: "" });
  });
});

describe("checksum", () => {
  test("is deterministic and content-sensitive", () => {
    expect(checksum("CREATE TABLE x;")).toBe(checksum("CREATE TABLE x;"));
    expect(checksum("CREATE TABLE x;")).not.toBe(checksum("CREATE TABLE y;"));
  });
});

describe("discoverMigrations", () => {
  test("returns an empty array for a nonexistent directory", async () => {
    const files = await discoverMigrations(path.join(dir, "does-not-exist"));
    expect(files).toEqual([]);
  });

  test("discovers a forward-only migration with no rollback", async () => {
    await writeFile(path.join(dir, "0001_initial.sql"), "CREATE TABLE t (id int);");

    const files = await discoverMigrations(dir);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ version: "0001", name: "initial", rollbackSql: null, rollbackPath: null });
  });

  test("pairs a forward file with its .down.sql rollback", async () => {
    await writeFile(path.join(dir, "0001_initial.sql"), "CREATE TABLE t (id int);");
    await writeFile(path.join(dir, "0001_initial.down.sql"), "DROP TABLE t;");

    const files = await discoverMigrations(dir);

    expect(files).toHaveLength(1);
    expect(files[0].rollbackSql).toBe("DROP TABLE t;");
  });

  test("sorts files lexicographically by filename", async () => {
    await writeFile(path.join(dir, "0002_second.sql"), "-- second");
    await writeFile(path.join(dir, "0001_first.sql"), "-- first");

    const files = await discoverMigrations(dir);

    expect(files.map((f) => f.version)).toEqual(["0001", "0002"]);
  });
});

describe("dashboard migrations tree", () => {
  // Vitest runs with the dashboard package as cwd; the real tree is a sibling of src/lib.
  const realDir = path.join(process.cwd(), "migrations");

  test("pairs every forward migration with its .down.sql rollback", async () => {
    const files = await discoverMigrations(realDir);

    expect(files.map((file) => file.version)).toEqual(["0001", "0002"]);
    const unpaired = files.filter((file) => file.rollbackSql === null).map((file) => file.forwardPath);
    expect(unpaired).toEqual([]);
  });

  test("the final migration drops the orphaned 0001 tables", async () => {
    const files = await discoverMigrations(realDir);
    const drop = files.at(-1)!;

    expect(drop.version).toBe("0002");
    for (const table of ["share_links", "quota_accounts", "api_keys", "user_settings", "users"]) {
      expect(drop.forwardSql).toMatch(new RegExp(`DROP TABLE IF EXISTS\\s+${table}\\s+CASCADE`, "i"));
    }
    // Rolling 0002 back must restore the schema it dropped.
    expect(drop.rollbackSql).toMatch(/CREATE TABLE IF NOT EXISTS users/i);
  });

  test("applies 0002 cleanly on top of an already-applied 0001", async () => {
    const files = await discoverMigrations(realDir);
    const initial = files.find((file) => file.version === "0001")!;
    // The applied 0001 row carries the checksum of the file as it ships, so
    // adding 0002 must not disturb it (checksum stability of 0001).
    const pool = fakePool([
      { version: "0001", name: initial.name, checksum: checksum(initial.forwardSql), applied_at: new Date().toISOString(), duration_ms: 1 },
    ]);

    const result = await runMigrations(pool, { directory: realDir });

    const drop = files.find((file) => file.version === "0002")!;
    expect(result.applied.map((row) => row.version)).toEqual(["0002"]);
    expect(result.applied[0]!.checksum).toBe(checksum(drop.forwardSql));
    expect(result.pending.map((row) => row.version)).toEqual(["0001"]);
  });
});

/** In-memory fake of `PgPoolHandle` backed by a `schema_migrations` array. */
function fakePool(initialApplied: AppliedMigration[] = []): PgPoolHandle {
  const appliedRows = [...initialApplied];
  return {
    query: (async (text: string, values?: ReadonlyArray<unknown>) => {
      if (text.startsWith("CREATE TABLE")) return { rows: [], rowCount: 0 };
      if (text.startsWith("SELECT version")) {
        return { rows: appliedRows.slice().sort((a, b) => a.version.localeCompare(b.version)), rowCount: appliedRows.length };
      }
      if (text.startsWith("INSERT INTO schema_migrations")) {
        const [version, name, sum, durationMs] = values as [string, string, string, number];
        appliedRows.push({ version, name, checksum: sum, applied_at: new Date().toISOString(), duration_ms: durationMs });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("DELETE FROM schema_migrations")) {
        const [version] = values as [string];
        const idx = appliedRows.findIndex((row) => row.version === version);
        if (idx !== -1) appliedRows.splice(idx, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as PgPoolHandle["query"],
    withTransaction: (async (handler) => {
      const client = {
        query: async (text: string, values?: ReadonlyArray<unknown>) => {
          if (text.startsWith("CREATE TABLE") || text.startsWith("DROP TABLE")) return { rows: [], rowCount: 0 };
          if (text.startsWith("INSERT INTO schema_migrations")) {
            const [version, name, sum, durationMs] = values as [string, string, string, number];
            appliedRows.push({ version, name, checksum: sum, applied_at: new Date().toISOString(), duration_ms: durationMs });
          }
          if (text.startsWith("DELETE FROM schema_migrations")) {
            const [version] = values as [string];
            const idx = appliedRows.findIndex((row) => row.version === version);
            if (idx !== -1) appliedRows.splice(idx, 1);
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return handler(client as never);
    }) as PgPoolHandle["withTransaction"],
  } as unknown as PgPoolHandle;
}

describe("status", () => {
  test("reports pending migrations not yet applied", async () => {
    await writeFile(path.join(dir, "0001_initial.sql"), "CREATE TABLE t (id int);");
    const pool = fakePool();

    const result = await status(pool, { directory: dir });

    expect(result.total).toBe(1);
    expect(result.applied).toEqual([]);
    expect(result.pending).toHaveLength(1);
  });
});

describe("runMigrations", () => {
  test("applies pending migrations in order and records them", async () => {
    await writeFile(path.join(dir, "0001_initial.sql"), "CREATE TABLE t (id int);");
    await writeFile(path.join(dir, "0002_second.sql"), "ALTER TABLE t ADD COLUMN name text;");
    const pool = fakePool();

    const result = await runMigrations(pool, { directory: dir });

    expect(result.applied.map((m) => m.version)).toEqual(["0001", "0002"]);
    expect(result.pending).toEqual([]);
  });

  test("skips already-applied migrations with a matching checksum", async () => {
    const sql = "CREATE TABLE t (id int);";
    await writeFile(path.join(dir, "0001_initial.sql"), sql);
    const pool = fakePool([
      { version: "0001", name: "initial", checksum: checksum(sql), applied_at: new Date().toISOString(), duration_ms: 1 },
    ]);

    const result = await runMigrations(pool, { directory: dir });

    expect(result.applied).toEqual([]);
    expect(result.pending).toHaveLength(1);
  });

  test("throws ChecksumMismatchError when an applied migration's file changed", async () => {
    await writeFile(path.join(dir, "0001_initial.sql"), "CREATE TABLE t (id int);");
    const pool = fakePool([
      { version: "0001", name: "initial", checksum: "stale-checksum", applied_at: new Date().toISOString(), duration_ms: 1 },
    ]);

    await expect(runMigrations(pool, { directory: dir })).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  test("respects the upTo option, stopping before later versions", async () => {
    await writeFile(path.join(dir, "0001_initial.sql"), "CREATE TABLE t (id int);");
    await writeFile(path.join(dir, "0002_second.sql"), "ALTER TABLE t ADD COLUMN name text;");
    const pool = fakePool();

    const result = await runMigrations(pool, { directory: dir, upTo: "0001" });

    expect(result.applied.map((m) => m.version)).toEqual(["0001"]);
  });
});

describe("rollbackMigrations", () => {
  test("throws when neither target nor steps is provided", async () => {
    const pool = fakePool();

    await expect(rollbackMigrations(pool, { directory: dir })).rejects.toThrow(
      "rollbackMigrations requires either `target` or `steps`",
    );
  });

  test("rolls back the most recent `steps` migrations", async () => {
    const sql1 = "CREATE TABLE t (id int);";
    const sql2 = "ALTER TABLE t ADD COLUMN name text;";
    await writeFile(path.join(dir, "0001_initial.sql"), sql1);
    await writeFile(path.join(dir, "0001_initial.down.sql"), "DROP TABLE t;");
    await writeFile(path.join(dir, "0002_second.sql"), sql2);
    await writeFile(path.join(dir, "0002_second.down.sql"), "ALTER TABLE t DROP COLUMN name;");
    const pool = fakePool([
      { version: "0001", name: "initial", checksum: checksum(sql1), applied_at: new Date().toISOString(), duration_ms: 1 },
      { version: "0002", name: "second", checksum: checksum(sql2), applied_at: new Date().toISOString(), duration_ms: 1 },
    ]);

    const result = await rollbackMigrations(pool, { directory: dir, steps: 1 });

    expect(result.rolledBack.map((m) => m.version)).toEqual(["0002"]);
  });

  test("throws MissingRollbackError when the targeted migration has no .down.sql", async () => {
    const sql1 = "CREATE TABLE t (id int);";
    await writeFile(path.join(dir, "0001_initial.sql"), sql1);
    const pool = fakePool([
      { version: "0001", name: "initial", checksum: checksum(sql1), applied_at: new Date().toISOString(), duration_ms: 1 },
    ]);

    await expect(rollbackMigrations(pool, { directory: dir, steps: 1 })).rejects.toBeInstanceOf(MissingRollbackError);
  });
});

/** Versioned SQLite migrations preserve current schemas and back up destructive upgrades. */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_MIGRATION_VERSION, runMigrations } from "../../../src/console/db/migrations";
import { INIT_SQL } from "../../../src/console/db/schema";

const tempDirs: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function createDatabase(): { database: Database; directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "cartethyia-migrate-"));
  tempDirs.push(directory);
  const path = join(directory, "console.db");
  const database = new Database(path, { create: true });
  databases.push(database);
  return { database, directory, path };
}

describe("runMigrations", () => {
  test("brings a fresh database to the latest schema version", () => {
    const { database, path } = createDatabase();

    runMigrations(database, path);

    expect((database.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST_MIGRATION_VERSION);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_accounts'").get()).toBeDefined();
  });

  test("stamps a pre-migration current schema without replaying destructive steps", () => {
    const { database, directory, path } = createDatabase();
    database.exec(INIT_SQL);

    runMigrations(database, path);

    expect((database.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST_MIGRATION_VERSION);
    expect(readdirSync(directory).some((name) => name.includes(".bak-v3-"))).toBeFalse();
  });

  test("backs up a database before replacing a legacy credential schema", () => {
    const { database, directory, path } = createDatabase();
    database.exec("CREATE TABLE api_keys (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL)");

    runMigrations(database, path);

    expect(readdirSync(directory).some((name) => name.includes(".bak-v3-"))).toBeTrue();
    const columns = database.query("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "key")).toBeTrue();
  });
});

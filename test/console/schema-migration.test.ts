/**
 * Column-level schema migration (REQ-8 follow-up) — `INIT_SQL`'s
 * `CREATE TABLE IF NOT EXISTS` only creates a table on a brand-new DB file;
 * a column added to an existing table's DDL never reaches a DB file that
 * predates the change. Regression for the resulting crash: creating a
 * custom provider against a pre-existing DB that has `custom_providers`
 * but not yet `headers_json` used to throw `SQLiteError: table
 * custom_providers has no column named headers_json`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getDb } from "../../src/console/db/client";
import { createCustomProvider } from "../../src/console/db/repos/custom-providers";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cth-schema-migration-"));
  Bun.env.DATA_DIR = dir;
  closeDbForTests();
});

afterEach(() => {
  closeDbForTests();
});

test("adding headers_json to an already-existing custom_providers table doesn't crash on the next getDb()", async () => {
  // Simulate a DB file created before headers_json existed: the pre-migration
  // schema, with the table already present but missing the new column.
  const dbPath = join(dir, "cartethyia.sqlite");
  const preMigration = new Database(dbPath, { create: true });
  preMigration.exec(`
    CREATE TABLE custom_providers (
      id              TEXT PRIMARY KEY,
      slug            TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      type            TEXT NOT NULL CHECK (type IN ('openai-compatible','anthropic-compatible')),
      base_url        TEXT NOT NULL,
      credential      TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL DEFAULT 30,
      models_json     TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
  preMigration.close();

  // getDb() runs the migration path on first open of this DATA_DIR.
  getDb();

  const created = createCustomProvider({
    name: "Post-Migration",
    type: "openai-compatible",
    baseUrl: "https://post-migration.example.com/v1",
    credential: "sk-test",
    customHeaders: { "X-Org-Id": "org-1" },
  });
  expect(created.customHeaders).toEqual({ "X-Org-Id": "org-1" });
});

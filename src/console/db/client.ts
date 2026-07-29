/**
 * DB client — lazy bun:sqlite singleton. Nothing touches the filesystem until
 * the first console/tracking call, keeping proxy-only tests hermetic.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConsoleEnv } from "../env";
import { INIT_SQL } from "./schema";

let db: Database | null = null;

/**
 * `CREATE TABLE IF NOT EXISTS` in `INIT_SQL` only runs on a brand-new DB —
 * a column added to an existing table's schema never lands on a DB file
 * that predates the change. Add any such post-launch column additions here;
 * each call is a no-op once the column exists.
 */
function ensureColumn(database: Database, table: string, column: string, ddl: string): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table doesn't exist yet — INIT_SQL will create it with the column already present
  if (!columns.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function initialize(database: Database): void {
  database.exec(INIT_SQL);
  ensureColumn(database, "custom_providers", "headers_json", "headers_json TEXT NOT NULL DEFAULT '{}'");
}

export function getDb(): Database {
  if (!db) {
    const env = getConsoleEnv();
    mkdirSync(dirname(env.dbPath), { recursive: true });
    db = new Database(env.dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
    initialize(db);
  }
  return db;
}

/** Test-only: close the current handle so the next getDb() re-opens at the (possibly re-pointed) env path. */
export function closeDbForTests(): void {
  try {
    db?.close();
  } catch {
    // already closed — fine
  }
  db = null;
}

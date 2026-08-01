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

export function getDb(): Database {
  if (!db) {
    const env = getConsoleEnv();
    mkdirSync(dirname(env.dbPath), { recursive: true });
    db = new Database(env.dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    // NORMAL skips an fsync on every commit (WAL still fsyncs at checkpoints),
    // trading a narrow OS-crash-only loss window for write throughput. Every
    // proxied request writes here at least once (touchApiKey), so the FULL
    // default (fsync per commit) was a hard ceiling well under 5k req/sec.
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(INIT_SQL);
  }
  return db;
}

/** Test-only: close the current handle so the next getDb() re-opens at the (possibly re-pointed) env path. */
/** Flushes the current SQLite write-ahead log without blocking readers. */
export function checkpointDb(): void {
  db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

/** Flushes and closes the database handle during graceful process shutdown. */
export function closeDb(): void {
  if (!db) return;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  db = null;
}

export function closeDbForTests(): void {
  try {
    db?.close();
  } catch {
    // already closed — fine
  }
  db = null;
}

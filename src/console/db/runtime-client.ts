/**
 * Runtime DB client - lazy bun:sqlite singleton for `runtime.sqlite`, a file
 * separate from the config db (`client.ts`). Nothing touches the filesystem
 * until the first tracking/console-log call, keeping proxy-only tests
 * hermetic and matching the config db's lazy-open convention.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConsoleEnv } from "../env";
import { RUNTIME_INIT_SQL } from "./runtime-schema";

let db: Database | null = null;

export function getRuntimeDb(): Database {
  if (!db) {
    const env = getConsoleEnv();
    mkdirSync(dirname(env.runtimeDbPath), { recursive: true });
    db = new Database(env.runtimeDbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    // NORMAL (not FULL) skips an fsync on every commit - WAL still fsyncs at
    // checkpoints, so a fresh page can only be lost to an OS crash, not a
    // process crash. Trading that narrow window for the throughput headroom
    // high-frequency request logging needs (hundreds of writes/sec) is the
    // right tradeoff for traffic telemetry, unlike the config db above.
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(RUNTIME_INIT_SQL);
  }
  return db;
}

/** Flushes the current SQLite write-ahead log without blocking readers. */
export function checkpointRuntimeDb(): void {
  db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

/** Flushes and closes the database handle during graceful process shutdown. */
export function closeRuntimeDb(): void {
  if (!db) return;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  db = null;
}

/** Test-only: close the current handle so the next getRuntimeDb() re-opens at the (possibly re-pointed) env path. */
export function closeRuntimeDbForTests(): void {
  try {
    db?.close();
  } catch {
    // already closed - fine
  }
  db = null;
}

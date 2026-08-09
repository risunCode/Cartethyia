import { statSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { RetentionResult } from "./runtime";

const DAY_MS = 86_400_000;

function cutoffDate(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}
const RETENTION_BATCH_SIZE = 500;
const MAX_CONSOLE_LOG_ROWS = 10_000;

/** Allowlist of tables and columns valid for batched retention deletes. */
const RETENTION_TABLES = new Set(["request_history", "request_payloads", "console_logs", "model_probes", "request_details", "request_tool_calls", "request_assets"]);
const RETENTION_COLUMNS = new Set(["started_at", "updated_at", "created_at", "ts"]);

function deleteBatched(db: Database, table: string, column: string, cutoff: string): number {
  if (!RETENTION_TABLES.has(table) || !RETENTION_COLUMNS.has(column)) {
    throw new Error(`Refusing to delete from unknown table: ${table}.${column}`);
  }
  let removed = 0;
  for (;;) {
    const result = db.query(`DELETE FROM ${table} WHERE ${column} < ? LIMIT ${RETENTION_BATCH_SIZE}`).run(cutoff);
    removed += result.changes;
    if (result.changes < RETENTION_BATCH_SIZE) break;
  }
  return removed;
}

function deleteConsoleLogsBeyondLimit(db: Database): number {
  const boundary = db.query("SELECT id FROM console_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(MAX_CONSOLE_LOG_ROWS) as { id: number } | null;
  if (boundary === null) return 0;
  let removed = 0;
  for (;;) {
    const result = db.query(`DELETE FROM console_logs WHERE id <= ? LIMIT ${RETENTION_BATCH_SIZE}`).run(boundary.id);
    removed += result.changes;
    if (result.changes < RETENTION_BATCH_SIZE) return removed;
  }
}

/**
 * Retention applies the configured date cutoffs to runtime telemetry only:
 * request history and console logs use `logRetentionDays`; legacy detail,
 * tool-call, and asset rows/files use `assetRetentionDays`. Configuration
 * state is never touched. Safe to run repeatedly (idempotent). Console logs
 * are also capped to MAX_CONSOLE_LOG_ROWS so frequent runtime events cannot
 * grow the database indefinitely. All deletes and asset-file unlinks run in
 * bounded batches (RETENTION_BATCH_SIZE rows at
 * a time) so cleanup memory stays constant regardless of history size.
 */
export function retainRuntimeData(
  getDb: () => Database,
  options: { logRetentionDays: number; assetRetentionDays: number; assetDir: string },
): RetentionResult {
  const db = getDb();
  const logCutoff = cutoffDate(Math.min(Math.max(Math.floor(options.logRetentionDays), 1), 365));
  const assetCutoff = cutoffDate(Math.min(Math.max(Math.floor(options.assetRetentionDays), 1), 365));
  const counts = { historyRemoved: 0, consoleLogsRemoved: 0, detailsRemoved: 0, toolCallsRemoved: 0, assetFilesRemoved: 0, payloadsRemoved: 0 };
  const apply = db.transaction((): void => {
    counts.historyRemoved += deleteBatched(db, "request_history", "started_at", logCutoff);
    if (tableExists(db, "console_logs")) {
      counts.consoleLogsRemoved += deleteBatched(db, "console_logs", "ts", logCutoff);
      counts.consoleLogsRemoved += deleteConsoleLogsBeyondLimit(db);
    }
    if (tableExists(db, "request_payloads")) counts.payloadsRemoved += deleteBatched(db, "request_payloads", "updated_at", assetCutoff);

    // Legacy tables: cleaned when they already exist, never written.
    if (tableExists(db, "request_details")) counts.detailsRemoved += deleteBatched(db, "request_details", "created_at", assetCutoff);
    if (tableExists(db, "request_tool_calls")) counts.toolCallsRemoved += deleteBatched(db, "request_tool_calls", "created_at", assetCutoff);
    if (tableExists(db, "request_assets")) {
      // Iterate stale asset rows in bounded id batches so cleanup never
      // materializes the full path list or row set at once; each batch's
      // backing files are unlinked before its rows are deleted.
      const root = resolve(options.assetDir);
      let lastId = 0;
      for (;;) {
        const rows = db
          .query(`SELECT id, storage_path FROM request_assets WHERE created_at < ? AND id > ? ORDER BY id ASC LIMIT ${RETENTION_BATCH_SIZE}`)
          .all(assetCutoff, lastId) as Array<{ id: number; storage_path: string | null }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          if (row.storage_path === null || row.storage_path.length === 0) continue;
          try {
            const absolute = resolve(row.storage_path);
            // Only ever delete files inside the asset directory on every OS.
            const relativePath = relative(root, absolute);
            if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
            if (statSync(absolute).isFile()) {
              unlinkSync(absolute);
              counts.assetFilesRemoved += 1;
            }
          } catch {
            // already gone or unreadable — best effort
          }
        }
        db.query(`DELETE FROM request_assets WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((row) => row.id));
        const lastRow = rows.at(-1);
        if (lastRow === undefined) break;
        lastId = lastRow.id;
      }
    }
  });
  apply();
  return counts;
}

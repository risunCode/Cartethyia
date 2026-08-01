/**
 * Console log ring buffer + pub/sub. The live tail (`lines`, capacity 500)
 * stays in memory for O(1) reads/SSE `init` events; persistence for restart
 * survival is the `console_logs` table in `runtime.sqlite` (see
 * `../db/runtime-client.ts`) rather than a JSONL file - one indexed table
 * instead of an unbounded, never-rotated `console-*.jsonl` file per day.
 */

import { enqueueRuntimeWrite, readRuntimeDb } from "../db/runtime-write-buffer";
import { getConsoleEnv } from "../env";

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";

export interface ConsoleLogLine {
  ts: string;
  level: ConsoleLogLevel;
  scope: string;
  msg: string;
}

export type ConsoleLogEvent = { type: "init"; lines: ConsoleLogLine[] } | { type: "line"; line: ConsoleLogLine } | { type: "clear" };

const CAPACITY = 500;
const MAX_MSG = 2_000;

const lines: ConsoleLogLine[] = [];
const listeners = new Set<(event: ConsoleLogEvent) => void>();
let hydratedDataDir: string | null = null;

interface ConsoleLogRow {
  ts: string;
  level: ConsoleLogLevel;
  scope: string;
  msg: string;
}

/** Hydrate the bounded console ring from `console_logs` (the most recent CAPACITY rows). */
export function hydrateConsoleLogs(): void {
  const env = getConsoleEnv();
  if (hydratedDataDir === env.dataDir) return;
  hydratedDataDir = env.dataDir;
  lines.length = 0;

  try {
    const rows = readRuntimeDb()
      .query("SELECT ts, level, scope, msg FROM console_logs ORDER BY id DESC LIMIT ?")
      .all(CAPACITY) as ConsoleLogRow[];
    lines.push(...rows.reverse());
  } catch {
    // Inaccessible runtime db is non-fatal - the live tail still works.
  }
}

function persistConsoleLine(line: ConsoleLogLine): void {
  try {
    enqueueRuntimeWrite("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, ?, ?, ?)", [line.ts, line.level, line.scope, line.msg]);
  } catch {
    // Logging must never break proxy traffic.
  }
}

export function pushConsoleLog(level: ConsoleLogLevel, scope: string, msg: string): void {
  const line: ConsoleLogLine = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: msg.length > MAX_MSG ? `${msg.slice(0, MAX_MSG)}…` : msg,
  };
  lines.push(line);
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
  persistConsoleLine(line);
  for (const listener of listeners) {
    try {
      listener({ type: "line", line });
    } catch {
      // Listener failures must not break logging.
    }
  }
}

export function getConsoleLogSnapshot(): ConsoleLogLine[] {
  return [...lines];
}

export function clearConsoleLogs(): void {
  lines.length = 0;
  try {
    // Flush first so a write queued moments earlier can't land after this
    // DELETE and resurrect a line the caller just asked to clear.
    readRuntimeDb().exec("DELETE FROM console_logs");
  } catch {
    // Logging must never break proxy traffic.
  }
  for (const listener of listeners) {
    try {
      listener({ type: "clear" });
    } catch {
      // Listener failures must not break logging.
    }
  }
}

/** Deletes console_logs rows older than a "YYYY-MM-DD" cutoff (retention). Returns the row count removed. */
export function deleteConsoleLogsOlderThan(cutoffDate: string): number {
  return readRuntimeDb().query("DELETE FROM console_logs WHERE substr(ts, 1, 10) < ?").run(cutoffDate).changes;
}

export function subscribeConsoleLogs(listener: (event: ConsoleLogEvent) => void): () => void {
  listeners.add(listener);
  listener({ type: "init", lines: getConsoleLogSnapshot() });
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function resetConsoleLogsForTests(): void {
  lines.length = 0;
  hydratedDataDir = null;
  listeners.clear();
}

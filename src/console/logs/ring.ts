/**
 * Console log ring buffer + pub/sub. Console history is append-only JSONL so
 * it survives process restarts without storing runtime data in SQLite.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getConsoleEnv } from "../env";

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";

export interface ConsoleLogLine {
  ts: string;
  level: ConsoleLogLevel;
  scope: string;
  msg: string;
}

export type ConsoleLogEvent = { type: "init"; lines: ConsoleLogLine[] } | { type: "line"; line: ConsoleLogLine } | { type: "clear" };

type PersistedConsoleEvent = { type: "line"; line: ConsoleLogLine } | { type: "clear" };

const CAPACITY = 500;
const MAX_MSG = 2_000;

const lines: ConsoleLogLine[] = [];
const listeners = new Set<(event: ConsoleLogEvent) => void>();
let hydratedDataDir: string | null = null;

function isConsoleLogLine(value: unknown): value is ConsoleLogLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  return typeof line.ts === "string" && typeof line.level === "string" && typeof line.scope === "string" && typeof line.msg === "string";
}

function appendConsoleEvent(event: PersistedConsoleEvent): void {
  try {
    const env = getConsoleEnv();
    mkdirSync(env.logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    appendFileSync(join(env.logDir, `console-${date}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Logging must never break proxy traffic.
  }
}

/** Hydrate the bounded console ring from append-only JSONL files. */
export function hydrateConsoleLogs(): void {
  const env = getConsoleEnv();
  if (hydratedDataDir === env.dataDir) return;
  hydratedDataDir = env.dataDir;
  lines.length = 0;

  try {
    if (!existsSync(env.logDir)) return;
    const files = readdirSync(env.logDir).filter((file) => /^console-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort();
    for (const file of files) {
      for (const raw of readFileSync(join(env.logDir, file), "utf8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          const event: unknown = JSON.parse(raw);
          if (!event || typeof event !== "object" || Array.isArray(event)) continue;
          const item = event as Record<string, unknown>;
          if (item.type === "clear") {
            lines.length = 0;
          } else if (item.type === "line" && isConsoleLogLine(item.line)) {
            lines.push(item.line);
          }
        } catch {
          // A corrupt event does not invalidate the rest of the log.
        }
      }
    }
  } catch {
    // Inaccessible runtime log storage is non-fatal.
  }

  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
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
  appendConsoleEvent({ type: "line", line });
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
  appendConsoleEvent({ type: "clear" });
  for (const listener of listeners) {
    try {
      listener({ type: "clear" });
    } catch {
      // Listener failures must not break logging.
    }
  }
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
  listeners.clear();
  hydratedDataDir = null;
}

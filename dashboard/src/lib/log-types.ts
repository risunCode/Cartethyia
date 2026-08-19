/**
 * Shared types for the Console Log widgets.
 *
 * The live log tail and the historical log reader share the same wire shape,
 * so the normalization helpers live in the transport/library layer rather
 * than beside one specific component.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
}

export interface LogEntryInit {
  readonly timestamp?: string;
  readonly level?: unknown;
  readonly source?: unknown;
  readonly message?: unknown;
  readonly id?: unknown;
}

const ALLOWED_LEVELS: Record<LogLevel, true> = {
  debug: true,
  info: true,
  warn: true,
  error: true,
};
const MAX_LOG_MESSAGE_LENGTH = 4096;
const MAX_LOG_SOURCE_LENGTH = 128;

/**
 * Coerces an arbitrary SSE/history payload into a bounded LogEntry. Returns
 * null when the payload cannot be safely normalized — the caller should drop
 * the record rather than show a corrupt row.
 */
export function normalizeLogEntry(value: unknown, fallbackId: string): LogEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as LogEntryInit;
  const levelRaw = typeof record.level === "string" ? record.level.toLowerCase() : "info";
  const levelCandidate = levelRaw as LogLevel;
  const level: LogLevel = ALLOWED_LEVELS[levelCandidate] === true ? levelCandidate : "info";
  const messageRaw = typeof record.message === "string" ? record.message : String(record.message ?? "");
  const message = messageRaw.slice(0, MAX_LOG_MESSAGE_LENGTH);
  const sourceRaw = typeof record.source === "string" ? record.source : "";
  const source = sourceRaw.slice(0, MAX_LOG_SOURCE_LENGTH) || "system";
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
  const idRaw = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : null;
  return {
    id: idRaw ?? fallbackId,
    timestamp,
    level,
    source,
    message,
  };
}

export function levelMatches(minimum: LogLevel, candidate: LogLevel): boolean {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  return order[candidate] >= order[minimum];
}

/**
 * Server-style log envelope: the wire shape returned by the API's
 * console-log endpoints. Bounded so a malformed payload can't allocate
 * unbounded UI state.
 */
export interface LogEnvelope {
  readonly entries: readonly LogEntry[];
}

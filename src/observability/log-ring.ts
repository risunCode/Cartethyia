/**
 * Console log ring buffer + pub/sub: a bounded in-memory tail of structured
 * server log lines for the live Console Log page. The dashboard reads a
 * snapshot and then subscribes over SSE (`console/domains/logs.ts`); nothing
 * here touches the database — restarts clear the tail by design.
 */

export const CONSOLE_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** One console log level; derived from `CONSOLE_LOG_LEVELS`. */
export type ConsoleLogLevel = (typeof CONSOLE_LOG_LEVELS)[number];

export interface ConsoleLogLine {
  readonly ts: string;
  readonly level: ConsoleLogLevel;
  readonly msg: string;
  readonly event?: "request_start" | "request_complete" | "request_error" | "token_refresh";
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly method?: string;
  /** The model name sent by the client. */
  readonly model?: string;
  /** The model selected after CLI/tenant alias routing. */
  readonly routedModel?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;
}

export interface ConsoleLogMetadata {
  readonly event: NonNullable<ConsoleLogLine["event"]>;
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly method?: string;
  readonly model?: string;
  readonly routedModel?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;
}

export function pushStructuredConsoleLog(
  level: ConsoleLogLevel,
  msg: string,
  metadata: ConsoleLogMetadata,
): void {
  const { event, ...lineMetadata } = metadata;
  appendLine({ level, msg, event, ...lineMetadata });
}

export type ConsoleLogEvent =
  | { readonly type: "init"; readonly lines: readonly ConsoleLogLine[] }
  | { readonly type: "line"; readonly line: ConsoleLogLine }
  | { readonly type: "clear" };

const CAPACITY = 500;
const MAX_MSG = 2_000;

const lines: ConsoleLogLine[] = [];
const listeners = new Set<(event: ConsoleLogEvent) => void>();

/** Single append path: truncate, bound the ring, then fan out to subscribers. */
function appendLine(line: Omit<ConsoleLogLine, "ts" | "msg"> & { readonly msg: string }): void {
  const stored: ConsoleLogLine = {
    ts: new Date().toISOString(),
    ...line,
    msg: line.msg.length > MAX_MSG ? `${line.msg.slice(0, MAX_MSG)}…` : line.msg,
  };
  lines.push(stored);
  if (lines.length > CAPACITY) lines.splice(0, lines.length - CAPACITY);
  for (const listener of listeners) {
    try {
      listener({ type: "line", line: stored });
    } catch {
      // Listener failures must not break logging.
    }
  }
}

export function pushConsoleLog(level: ConsoleLogLevel, msg: string): void {
  appendLine({ level, msg });
}

export function getConsoleLogSnapshot(): ConsoleLogLine[] {
  return [...lines];
}

export function clearConsoleLogs(): void {
  lines.length = 0;
  for (const listener of listeners) {
    try {
      listener({ type: "clear" });
    } catch {
      // Listener failures must not break logging.
    }
  }
}

export function subscribeConsoleLogs(
  listener: (event: ConsoleLogEvent) => void,
): () => void {
  listeners.add(listener);
  listener({ type: "init", lines: getConsoleLogSnapshot() });
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the shared ring and drop all subscribers between tests. */
export function resetConsoleLogsForTests(): void {
  lines.length = 0;
  listeners.clear();
}

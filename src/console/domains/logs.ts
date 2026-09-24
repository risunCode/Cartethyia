// Console logs domain: live server-log tail for the Console Log page.
// Serves the in-memory ring (`observability/log-ring`, fed by every `log.*`
// call) as a snapshot plus an SSE stream (snapshot + live lines + clear).
// This is process stdout surfaced to the dashboard — NOT request telemetry,
// which already lives on the Usage page.
//
// Guard: `dashboard:read` scope, no tenant. Log lines are instance-level
// metadata and their args are redacted at the source, the same audience
// that already reads request/response bodies on Usage.

import { Elysia, t } from "elysia";
import { ConsoleDomainError, errorResponse, requireScope } from "../shared/errors";
import { parseQueryLimit } from "../shared/query";
import type { ConsoleAccessResolver } from "../auth/access";
import type { AccessDecision } from "../../security/access-control";
import type { AuditSink } from "./audit/contracts";
import {
  CONSOLE_LOG_LEVELS,
  clearConsoleLogs,
  getConsoleLogSnapshot,
  subscribeConsoleLogs,
  type ConsoleLogLevel,
} from "../../observability/log-ring";
import { consoleSseResponse, createConsoleSseStream } from "./sse/routes";

export interface LogsConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

function isLogLevel(value: string): value is ConsoleLogLevel {
  return (CONSOLE_LOG_LEVELS as readonly string[]).includes(value);
}

const logsQuery = t.Object({
  level: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

export function createLogRoutes(config: LogsConfig): Elysia {
  const readLogs = (access: AccessDecision | undefined, level?: string, limitRaw?: string) => {
    requireScope(access, "dashboard:read");
    if (level !== undefined && !isLogLevel(level)) {
      throw new ConsoleDomainError("invalid_level", 400, `Unsupported log level: ${level}. Use debug, info, warn, or error.`);
    }
    const limit = parseQueryLimit(limitRaw, 200, 500);
    const lines = getConsoleLogSnapshot();
    const filtered = level === undefined ? lines : lines.filter((line) => line.level === level);
    return { lines: filtered.slice(-limit) };
  };

  return new Elysia()
    .get("/logs", { query: logsQuery }, async ({ request, query, set }) => {
      try {
        return readLogs(config.accessResolver(request), query.level, query.limit);
      } catch (e) {
        return errorResponse(e, set, "Logs operation failed");
      }
    })
    .delete("/logs", async ({ request, set }) => {
      try {
        const access = requireScope(config.accessResolver(request), "dashboard:read");
        clearConsoleLogs();
        await config.auditSink?.record({ access, action: "console_logs.cleared", target: "console-logs" });
        return { success: true };
      } catch (e) {
        return errorResponse(e, set, "Logs operation failed");
      }
    })
    .get("/logs/stream", ({ request, set }) => {
      try {
        requireScope(config.accessResolver(request), "dashboard:read");
      } catch (e) {
        return errorResponse(e, set, "Logs operation failed");
      }
      return consoleSseResponse(
        createConsoleSseStream(request.signal, ({ send }) => {
          send("init", { lines: getConsoleLogSnapshot() });
          return subscribeConsoleLogs((event) => {
            if (event.type === "init") send("init", { lines: event.lines });
            else if (event.type === "line") send("line", event.line);
            else send("clear", {});
          });
        }),
      );
    }) as unknown as Elysia;
}

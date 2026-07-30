/**
 * Console logs API — ring buffer snapshot/clear + SSE live stream (REQ-6).
 *
 * SSE events: `init` (full snapshot), `line` (single entry), `clear`.
 * A 25s `ping` comment keeps proxies from closing the idle connection.
 */

import { Elysia } from "elysia";
import {
  getConsoleLogSnapshot,
  clearConsoleLogs,
  subscribeConsoleLogs,
  type ConsoleLogEvent,
} from "../logs/ring";
import { addAuditEvent } from "../db/repos/audit";
import { consoleSseResponse, createConsoleSseStream } from "../sse";


export const logsRoutes = new Elysia({ prefix: "/console/api" })
  .get("/console-logs", () => ({ lines: getConsoleLogSnapshot() }))
  .delete("/console-logs", () => {
    clearConsoleLogs();
    addAuditEvent("console_logs.cleared", {});
    return { ok: true };
  })
  .get("/console-logs/stream", ({ request }) => consoleSseResponse(
    createConsoleSseStream(request.signal, ({ send }) => subscribeConsoleLogs((event: ConsoleLogEvent) => {
      if (event.type === "init") send("init", { lines: event.lines });
      else if (event.type === "line") send("line", event.line);
      else send("clear", {});
    })),
  ));

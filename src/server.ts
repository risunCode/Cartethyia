/**
 * Entry point — native `Bun.serve` around the Elysia app's `fetch` handler
 * rather than Elysia's own `.listen()`, keeping the option open to drop in
 * raw Bun-level concerns later (e.g. custom TLS) without restructuring the
 * app.
 */

import { app } from "./app";
import { config } from "./config";
import { ensureConsoleBootstrap } from "./console/bootstrap";
import { checkpointDb, closeDb } from "./console/db/client";
import { checkpointRuntimeDb, closeRuntimeDb } from "./console/db/runtime-client";
import { flushRuntimeWriteBuffer } from "./console/db/runtime-write-buffer";
import { flushApiKeyTouches } from "./console/db/repos/api-keys";
import { flushRequestLogBuffer } from "./http/request-log-buffer";
import { hydrateConsoleLogs } from "./console/logs/ring";
import { startLogMaintenance } from "./console/tracking/rotate";
import { cancelScheduledGc, scheduleGlobalGc } from "./console/memory";

await ensureConsoleBootstrap();
hydrateConsoleLogs();
startLogMaintenance();

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 0, // long-lived SSE streams must not be idle-killed
});

const checkpointInterval = setInterval(() => {
  checkpointDb();
  checkpointRuntimeDb();
}, 5 * 60_000);
const gcInterval = setInterval(scheduleGlobalGc, 10 * 60_000);

function shutdown(): void {
  clearInterval(checkpointInterval);
  clearInterval(gcInterval);
  cancelScheduledGc();
  server.stop();
  flushRuntimeWriteBuffer();
  flushApiKeyTouches();
  flushRequestLogBuffer();
  closeDb();
  closeRuntimeDb();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Cartethyia listening on :${server.port}`);

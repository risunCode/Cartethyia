/**
 * Entry point — native `Bun.serve` around the Elysia app's `fetch` handler
 * rather than Elysia's own `.listen()`, keeping the option open to drop in
 * raw Bun-level concerns later (e.g. custom TLS) without restructuring the
 * app.
 */

import { app } from "./app";
import { config } from "./config";
import { ensureConsoleBootstrap } from "./console/bootstrap";
import { hydrateConsoleLogs } from "./console/logs/ring";

await ensureConsoleBootstrap();
hydrateConsoleLogs();

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 0, // long-lived SSE streams must not be idle-killed
});

console.log(`Cartethyia listening on :${server.port}`);

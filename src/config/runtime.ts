/**
 * HTTP listener, dashboard runtime, and graceful-shutdown drain resolvers.
 */

import { CONFIG_SPEC, readInt, readOptionalText, readText } from "./spec";

/** Resolves the HTTP listener port from the process environment. */
export function resolvePort(): number {
  return readInt("PORT", CONFIG_SPEC.PORT);
}

/** Resolves the dashboard static asset directory. */
export function resolveDashboardDist(): string {
  return readText("DASHBOARD_DIST", CONFIG_SPEC.DASHBOARD_DIST);
}

/**
 * Resolves the configured default gateway API key (`CARTETHYIA_API_KEY`), if
 * one is set. Consumers that need the raw secret — first-boot seeding and the
 * console's legacy-key recovery — read it here instead of probing
 * `process.env` directly.
 */
export function resolveDefaultGatewayApiKey(): string | undefined {
  return readOptionalText("CARTETHYIA_API_KEY", CONFIG_SPEC.CARTETHYIA_API_KEY);
}

/** Resolves the request-body ceiling shared by the Bun listener and ingress middleware. */
export function resolveMaxBodyBytes(): number {
  return readInt("CARTETHYIA_SERVER_MAX_BODY_BYTES", CONFIG_SPEC.CARTETHYIA_SERVER_MAX_BODY_BYTES);
}

/** Resolves the listener idle-socket timeout (seconds). */
export function resolveIdleTimeout(): number {
  return readInt("CARTETHYIA_SERVER_IDLE_TIMEOUT", CONFIG_SPEC.CARTETHYIA_SERVER_IDLE_TIMEOUT);
}

/** Resolves the graceful-shutdown drain window: time for in-flight requests to finish before abort. */
export function resolveShutdownDrainWindowMs(): number {
  return readInt(
    "CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS",
    CONFIG_SPEC.CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS,
  );
}

/** Resolves the operator drain token, or `undefined` when the drain route is disabled. */
export function resolveDrainToken(): string | undefined {
  const raw = process.env.CARTETHYIA_DRAIN_TOKEN?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

/**
 * Whether Elysia precompiles route handlers at startup (AOT). On in production,
 * off in development, where just-in-time compilation keeps `--hot` reloads
 * fast. The standalone `bun run build:aot` artifact is unaffected.
 */
export function resolveElysiaPrecompile(): boolean {
  return process.env.NODE_ENV === "production";
}

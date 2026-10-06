// Console-specific ingress guards: stateless double-submit CSRF for unsafe
// `/console/api/*` mutations, and the per-session mutation throttle that
// bounds the blast radius of a stolen session cookie. Both are **console**
// concerns — they are hard-coded against `/console/api/`, use the console
// session cookie, and refuse at console's `GatewayError` boundary — so they
// live beside the console router instead of under `transport/guards/`, which
// is the ingress stage shared across every surface.
import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { GatewayError } from "../protocol/gateway-error";
import { fastPathname } from "../lib/pathname";
import { parseCookieValue, SESSION_COOKIE_NAME, isCsrfValid } from "../security/csrf";

/**
 * Stateless double-submit CSRF guard for unsafe `/console/api/*` mutations.
 * Compares the `x-csrf-token` header against the readable `csrf_token`
 * cookie — zero database I/O, so dashboard writes no longer pay a token
 * SELECT + UPDATE on top of the session lookup, and there is no token
 * store whose outage could masquerade as an auth failure.
 */
export function createConsoleCsrfMiddleware(): Elysia {
  const excluded = ["/auth/login", "/auth/setup", "/auth/setup/restore", "/auth/session"];
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const path = fastPathname(request.url);
      if (
        !path.startsWith("/console/api/") ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
        excluded.some((suffix) => path.endsWith(suffix))
      )
        return;
      const token = parseCookieValue(request, SESSION_COOKIE_NAME);
      // No session cookie means no ambient authority to forge: logout and
      // other mutations without a session fail authentication downstream.
      // CSRF enforcement applies exactly when a session cookie is present.
      if (!token) return;
      if (!isCsrfValid(request))
        throw new GatewayError("invalid_request", 403, "CSRF validation failed");
    })
    .as("plugin");
}

/**
 * Per-session console mutation throttle: at most 240 unsafe requests per
 * 10-second sliding window per session. A stolen session cookie can
 * otherwise rewrite settings, rotate keys, or trigger restores at full
 * request rate; this bounds the blast radius while staying far above
 * legitimate bulk operations (bulk-deleting 40+ fetched models fires one
 * DELETE per model as fast as the loop runs, plus interleaved probes).
 * Keyed by session-cookie hash (never the raw secret); mutations without a
 * session fail authentication downstream and are not tracked. Exceeding
 * requests get 429 with `retry-after` instead of executing.
 */
const CONSOLE_MUTATION_LIMIT = 240;
const CONSOLE_MUTATION_WINDOW_MS = 10_000;
const CONSOLE_MUTATION_MAX_KEYS = 1024;
const consoleMutationHits = new Map<string, number[]>();

function consoleMutationKey(request: Request): string | undefined {
  const token = parseCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex");
}

function pruneConsoleMutationHits(now: number): void {
  for (const [key, hits] of consoleMutationHits) {
    while (hits.length > 0 && (hits[0] as number) <= now - CONSOLE_MUTATION_WINDOW_MS) hits.shift();
    if (hits.length === 0) consoleMutationHits.delete(key);
  }
  while (consoleMutationHits.size > CONSOLE_MUTATION_MAX_KEYS) {
    const oldest = consoleMutationHits.keys().next().value;
    if (oldest === undefined) return;
    consoleMutationHits.delete(oldest);
  }
}

export function createConsoleMutationLimiterMiddleware(): Elysia {
  const excluded = ["/auth/login", "/auth/setup", "/auth/setup/restore", "/auth/session"];
  return new Elysia()
    .beforeHandle(async ({ request, set }) => {
      const path = fastPathname(request.url);
      if (
        !path.startsWith("/console/api/") ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
        excluded.some((suffix) => path.endsWith(suffix))
      )
        return;
      const key = consoleMutationKey(request);
      // No session cookie means no ambient authority to abuse: the request
      // fails authentication downstream. Only tracked sessions are throttled.
      if (key === undefined) return;
      const now = Date.now();
      pruneConsoleMutationHits(now);
      const hits = consoleMutationHits.get(key) ?? [];
      if (hits.length >= CONSOLE_MUTATION_LIMIT) {
        // Measured, not a literal: the wait is however long the oldest tracked
        // mutation still needs to age out of the window. A hardcoded value had
        // to be kept in step with `CONSOLE_MUTATION_WINDOW_MS` by hand.
        const oldest = hits[0];
        const retryAfterSeconds =
          oldest === undefined
            ? Math.ceil(CONSOLE_MUTATION_WINDOW_MS / 1000)
            : Math.max(1, Math.ceil((oldest + CONSOLE_MUTATION_WINDOW_MS - now) / 1000));
        set.headers["retry-after"] = String(retryAfterSeconds);
        throw new GatewayError("quota_exceeded", 429, "Console mutation rate limit exceeded");
      }
      hits.push(now);
      consoleMutationHits.set(key, hits);
    })
    .as("plugin");
}

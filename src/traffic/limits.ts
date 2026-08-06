/** Process-wide memory and framing limits. Values are environment-tunable but always clamped. */

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(Bun.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

/** Clamped process limits shared by request, stream, and in-memory state boundaries. */
export const runtimeMemoryLimits = Object.freeze({
  requestBodyBytes: boundedInteger("CARTETHYIA_MAX_REQUEST_BODY_BYTES", 10 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  streamLineBytes: boundedInteger("CARTETHYIA_MAX_STREAM_LINE_BYTES", 1 * 1024 * 1024, 4 * 1024, 8 * 1024 * 1024),
  streamEventBytes: boundedInteger("CARTETHYIA_MAX_STREAM_EVENT_BYTES", 4 * 1024 * 1024, 16 * 1024, 16 * 1024 * 1024),
  studioMaxSessions: boundedInteger("CARTETHYIA_STUDIO_MAX_SESSIONS", 128, 1, 2_048),
  studioMaxSessionBytes: boundedInteger("CARTETHYIA_STUDIO_MAX_SESSION_BYTES", 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
  studioMaxTotalBytes: boundedInteger("CARTETHYIA_STUDIO_MAX_TOTAL_BYTES", 8 * 1024 * 1024, 1 * 1024 * 1024, 512 * 1024 * 1024),
  studioTtlMs: boundedInteger("CARTETHYIA_STUDIO_TTL_SECONDS", 24 * 60 * 60, 60, 30 * 24 * 60 * 60) * 1_000,
  maxRouteTransitionRoutes: boundedInteger("CARTETHYIA_MAX_ROUTE_TRANSITION_ROUTES", 4_096, 16, 100_000),
  maxRouteTransitionsPerRoute: boundedInteger("CARTETHYIA_MAX_ROUTE_TRANSITIONS_PER_ROUTE", 512, 8, 4_096),
  /** Max unique IPs tracked for per-IP flight limiting. 0 = adaptive based on available memory. */
  maxTrackedIps: boundedInteger("CARTETHYIA_MAX_TRACKED_IPS", 10_000, 0, 1_000_000),
  /** Max unique API keys tracked for admission control. 0 = adaptive. */
  maxTrackedKeys: boundedInteger("CARTETHYIA_MAX_TRACKED_KEYS", 10_000, 0, 1_000_000),
  /** Max unique IPs tracked for login rate limiting. 0 = adaptive. */
  loginMaxTrackedIps: boundedInteger("CARTETHYIA_LOGIN_MAX_TRACKED_IPS", 10_000, 0, 1_000_000),
  /** GC interval in milliseconds (0 = adaptive based on traffic). */
  gcIntervalMs: boundedInteger("CARTETHYIA_GC_INTERVAL_MS", 10 * 60_000, 0, 24 * 60 * 60_000),
  /** Max requests per IP per rate-limit window on the external API surface. */
  rateLimitMaxRequests: boundedInteger("CARTETHYIA_RATE_LIMIT_MAX_REQUESTS", 100, 1, 1_000_000),
  /** Rate-limit window length in milliseconds for the external API surface. */
  rateLimitWindowMs: boundedInteger("CARTETHYIA_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 24 * 60 * 60_000),
});

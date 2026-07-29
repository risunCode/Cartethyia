/**
 * Config — env loader, no framework magic.
 *
 * Every field is resolved once at boot and frozen. Route handlers read this
 * object; nothing re-reads `process.env` on the hot path.
 */

export interface CartethyiaConfig {
  port: number;
  /** Per-IP in-flight request control and reverse-proxy trust settings. */
  traffic: {
    /** Per-IP active request ceiling for /v1/* routes. */
    maxFlightsPerIp: number;
    /** Trust reverse-proxy IP headers only when the proxy is controlled by this deployment. */
    trustProxy: boolean;
  };
  cache: {
    markersEnabled: boolean;
  };
}


function parseBoundedNumber(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function loadConfig(env: Record<string, string | undefined>): CartethyiaConfig {
  return {
    port: Number(env.PORT) || 12800,
    traffic: {
      maxFlightsPerIp: parseBoundedNumber(env.MAX_FLIGHTS_PER_IP, 20, 0, 10_000),
      trustProxy: env.TRUST_PROXY === "true",
    },
    cache: {
      markersEnabled: env.CACHE_MARKERS_ENABLED !== "false",
    },
  };
}

export const config: CartethyiaConfig = loadConfig(Bun.env);

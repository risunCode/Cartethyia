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
  transforms: {
    rtk: {
      /** Lossy tool-result compression; explicitly disabled unless RTK_ENABLED=true. */
      enabled: boolean;
      /** Ignore small results where compression provides little token benefit. */
      minChars: number;
      /** Reject candidates that would remove more than this share of original text. */
      maxReductionPercent: number;
    };
    /** Server-owned instruction appended to every upstream request when non-empty. */
    systemPrompt: string | undefined;
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
    transforms: {
      rtk: {
        enabled: env.RTK_ENABLED === "true",
        minChars: parseBoundedNumber(env.RTK_MIN_CHARS, 1_500, 500, 1_000_000),
        maxReductionPercent: parseBoundedNumber(env.RTK_MAX_REDUCTION_PERCENT, 35, 1, 90),
      },
      systemPrompt: env.CARTETHYIA_SYSTEM_PROMPT?.trim() || undefined,
    },
  };
}

export const config: CartethyiaConfig = loadConfig(Bun.env);

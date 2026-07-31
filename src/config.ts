/**
 * Config — env loader, no framework magic.
 *
 * Every field is resolved once at boot and frozen. Route handlers read this
 * object; nothing re-reads `process.env` on the hot path.
 */

import { validateNumeric } from "./utils/config-helpers";

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
  corsAllowedOrigins: string[];
}


/**
 * Warns at boot about CORS_ALLOWED_ORIGINS values that weaken the /v1/*
 * allow-list: a wildcard defeats the allow-list entirely, and a non-HTTPS,
 * non-loopback origin can be spoofed over an untrusted network. This is a
 * warning, not a hard failure \u2014 operators legitimately need it, e.g. plain-HTTP
 * self-hosting on a LAN.
 */
function warnAboutWeakCorsOrigins(origins: readonly string[]): void {
  if (origins.length === 0) return;
  if (origins.includes("*")) {
    console.warn("[cartethyia] CORS_ALLOWED_ORIGINS includes '*'. Restrict it to known origins in production.");
    return;
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const weak = origins.filter((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol !== "https:" && !loopbackHosts.has(url.hostname);
    } catch {
      return true; // malformed origin
    }
  });
  if (weak.length > 0) {
    console.warn(
      `[cartethyia] CORS_ALLOWED_ORIGINS contains non-HTTPS, non-loopback origin(s): ${weak.join(", ")}. ` +
      "Browsers over HTTPS pages will still block requests to these as mixed content; confirm this is intentional.",
    );
  }
}

function loadConfig(env: Record<string, string | undefined>): CartethyiaConfig {
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  warnAboutWeakCorsOrigins(corsAllowedOrigins);
  return {
    port: Number(env.PORT) || 12800,
    traffic: {
      maxFlightsPerIp: validateNumeric(env.MAX_FLIGHTS_PER_IP, { fallback: 20, min: 0, max: 10_000 }),
      trustProxy: env.TRUST_PROXY === "true",
    },
    cache: {
      markersEnabled: env.CACHE_MARKERS_ENABLED !== "false",
    },
    corsAllowedOrigins,
  };
}

export const config: CartethyiaConfig = loadConfig(Bun.env);

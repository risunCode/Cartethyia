/**
 * Runtime settings snapshot — console settings_json overrides env config
 * without restart. Cached briefly to keep the request hot path DB-free.
 */

import { getSettings, type RuntimeSettings } from "./db/repos/settings";
import { getConsoleEnv } from "./env";

const TTL_MS = 5_000;

let cache: { at: number; value: RuntimeSettings } | null = null;

function defaultRuntimeSettings(): RuntimeSettings {
  const env = getConsoleEnv();
  return {
    proxyAuthMode: env.proxyAuthMode,
    trackPayloads: env.trackPayloads,
    trackAssets: env.trackAssets,
    logRetentionDays: env.logRetentionDays,
    assetRetentionDays: env.assetRetentionDays,
    maxFlightsPerIp: 20,
    trustProxy: false,
    cacheMarkersEnabled: true,
    sessionTtlHours: env.sessionTtlHours,
  };
}

export function getRuntimeSettings(): RuntimeSettings {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const settings = getSettings();
  const value = settings?.runtime ?? defaultRuntimeSettings();
  cache = { at: Date.now(), value };
  return value;
}

/** Clears the runtime-settings cache (REQ-3) so the next read hits the DB. */
export function invalidateRuntimeSettings(): void {
  cache = null;
}

/** Test-only. */
export function resetRuntimeSettingsForTests(): void {
  cache = null;
}

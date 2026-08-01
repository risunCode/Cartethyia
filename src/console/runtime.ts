/**
 * Runtime settings snapshot — console settings_json overrides env config
 * without restart. Cached briefly to keep the request hot path DB-free.
 */

import { getSettings, type RuntimeSettings } from "./db/repos/settings";
import { getConsoleEnv } from "./env";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt";
import type { RequestTransformSettings } from "../upstream/outbound";

const TTL_MS = 5_000;

let cache: { at: number; value: RuntimeSettings } | null = null;

export function defaultRuntimeSettings(): RuntimeSettings {
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
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
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

/**
 * Projects the live runtime settings into the shape `prepareOutboundRequest`
 * expects. This is the ONLY source `dispatchQualifiedRoute`/`runEmulatedCompact`/
 * the legacy pass-through providers should read for the system prompt —
 * `config.transforms` no longer exists (REQ-3.4).
 */
export function getRequestTransformSettings(): RequestTransformSettings {
  const settings = getRuntimeSettings();
  return { systemPrompt: settings.systemPrompt.trim() || undefined };
}

/** Clears the runtime-settings cache (REQ-3) so the next read hits the DB. */
export function invalidateRuntimeSettings(): void {
  cache = null;
}

/** Test-only. */
export function resetRuntimeSettingsForTests(): void {
  cache = null;
}

/**
 * Runtime settings snapshot — console settings_json overrides env config
 * without restart. Cached briefly to keep the request hot path DB-free.
 */

import { getSettings, type RuntimeSettings } from "./db/repos/settings";
import { listActiveSanitizerRules } from "./db/repos/sanitizer-rules";
import { getConsoleEnv } from "./env";
import type { RequestTransformSettings, SanitizerFilterRule } from "../upstream/outbound";

const TTL_MS = 5_000;

let cache: { at: number; value: RuntimeSettings } | null = null;
let filterRulesCache: { at: number; value: SanitizerFilterRule[] } | null = null;

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
    systemPrompt: "",
    sessionTtlHours: env.sessionTtlHours,
    costPerMillionInputTokens: 0,
    costPerMillionOutputTokens: 0,
    rtk: { enabled: false, minChars: 1500, maxReductionPercent: 35 },
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
 * the legacy pass-through providers should read for RTK/system-prompt —
 * `config.transforms` no longer exists (REQ-3.4).
 */
function getFilterRules(): SanitizerFilterRule[] {
  if (filterRulesCache && Date.now() - filterRulesCache.at < TTL_MS) return filterRulesCache.value;
  const value = listActiveSanitizerRules().map((r) => ({ pattern: r.pattern, replacement: r.replacement, isRegex: r.isRegex }));
  filterRulesCache = { at: Date.now(), value };
  return value;
}

export function getRequestTransformSettings(): RequestTransformSettings {
  const settings = getRuntimeSettings();
  return { rtk: settings.rtk, systemPrompt: settings.systemPrompt.trim() || undefined, filterRules: getFilterRules() };
}

/** Clears both the runtime-settings and filter-rules caches (REQ-3, REQ-9) so the next read hits the DB. */
export function invalidateRuntimeSettings(): void {
  cache = null;
  filterRulesCache = null;
}

/** Test-only. */
export function resetRuntimeSettingsForTests(): void {
  cache = null;
  filterRulesCache = null;
}

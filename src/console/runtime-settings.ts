import type { ConfigPersistence } from "../storage";
import type { PersistenceEnv } from "../storage/main/env";
import { headroomConfig } from "../open-sse/rtk";
import type { ConsoleRuntimeSettings } from "./views";

const MAX_SIDEBAR_ICON_DATA_URL_CHARS = 36_000_000;
const SIDEBAR_ICON_DATA_URL_PATTERN = /^data:image\/(?:png|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const HEADROOM_URL_PATTERN = /^https?:\/\/[^\s]+$/i;

export function normalizeSidebarIconDataUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > MAX_SIDEBAR_ICON_DATA_URL_CHARS || !SIDEBAR_ICON_DATA_URL_PATTERN.test(value)) return null;
  return value;
}
function normalizeHeadroomUrl(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return headroomConfig.url;
  const url = value.trim();
  return HEADROOM_URL_PATTERN.test(url) ? url : headroomConfig.url;
}

/**
 * Extracts the `settings_json.runtime` object as a plain record, or returns
 * an empty record when it is absent / malformed. The single narrowing point
 * for the opaque runtime blob; callers consume the typed projection below
 * instead of re-deriving this.
 */
export function runtimeRecord(config: ConfigPersistence): Record<string, unknown> {
  return runtimeRecordFromJson(config.settings.getSettingsJson());
}

/**
 * Extracts the `runtime` object from a raw settings-JSON record, or returns
 * an empty record when absent / malformed. Use when you hold a snapshot row
 * (`config.settings.get()`) rather than the live {@link ConfigPersistence}.
 */
export function runtimeRecordFromJson(json: Record<string, unknown>): Record<string, unknown> {
  const runtime = json.runtime;
  return typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)
    ? (runtime as Record<string, unknown>)
    : {};
}

/**
 * Canonical projection from persisted settings + env defaults to the typed
 * {@link ConsoleRuntimeSettings} consumed by the console, the data plane,
 * and the composition root. Every runtime field is narrowed here once;
 * no other module should re-parse `settings_json.runtime`.
 */
export function runtimeSettings(config: ConfigPersistence, env: PersistenceEnv = config.env): ConsoleRuntimeSettings {
  const value = runtimeRecord(config);
  const persisted = config.settings.getRuntimeSettings(env);
  return {
    proxyAuthMode: value.proxyAuthMode === "open" ? "open" : "api_key",
    privacyMode: value.privacyMode === "full" ? "full" : "masked",
    trackPayloads: value.trackPayloads === "none" ? "none" : "bounded",
    trackAssets: value.trackAssets === "none" ? "none" : "meta",
    logRetentionDays: persisted.logRetentionDays,
    assetRetentionDays: persisted.assetRetentionDays,
    maxFlightsPerIp: typeof value.maxFlightsPerIp === "number" ? Math.max(1, Math.floor(value.maxFlightsPerIp)) : env.maxFlightsPerIp,
    trustProxy: value.trustProxy === true,
    cacheMarkersEnabled: true,
    sessionTtlHours: typeof value.sessionTtlHours === "number" ? Math.max(1, Math.floor(value.sessionTtlHours)) : 12,
    sidebarIconDataUrl: normalizeSidebarIconDataUrl(value.sidebarIconDataUrl),
    tokenSaverEnabled: value.tokenSaverEnabled === true,
    tokenSaverQuality: value.tokenSaverQuality === "lite" || value.tokenSaverQuality === "extreme" ? value.tokenSaverQuality : "balanced",
    headroomEnabled: value.headroomEnabled === undefined ? headroomConfig.enabled : value.headroomEnabled === true,
    headroomUrl: normalizeHeadroomUrl(value.headroomUrl === undefined ? headroomConfig.url : value.headroomUrl),
    headroomTimeoutMs: typeof value.headroomTimeoutMs === "number" ? Math.min(10_000, Math.max(250, Math.floor(value.headroomTimeoutMs))) : headroomConfig.timeoutMs,
    ponytailEnabled: value.ponytailEnabled === true,
    filterRulesEnabled: value.filterRulesEnabled === true,
  };
}

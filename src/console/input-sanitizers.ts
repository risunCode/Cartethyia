/**
 * Narrow input parsing helpers for external boundary narrowing (no `any`).
 *
 * Extracted from `services.ts` so input validation owns its own file.
 * These are used by the console application services to safely narrow
 * untrusted request bodies into typed patches before persistence.
 */

import type { CredentialKind } from "../application/contracts";
import type { ConsoleRuntimeSettings, ProxyProtocol } from "./views";
import type { ApiKeyUpdateInput, CustomProviderKind, ProviderRoutingSettings } from "./views";

// ---------------------------------------------------------------------------
// Narrow input parsing helpers (external boundary narrowing, no `any`)
// ---------------------------------------------------------------------------

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isValidCustomApiKey(value: string): boolean {
  return value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed === undefined ? undefined : Math.max(min, Math.min(max, Math.round(parsed)));
}

export function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function recordOrUndefined(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export function stringListOrUndefined(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

export function credentialKind(value: unknown): CredentialKind {
  return value === "oauth" || value === "manual" || value === "api_key" ? value : "api_key";
}

export function customProviderKind(value: unknown): CustomProviderKind {
  return value === "anthropic" || value === "openai-compatible" ? value : "openai";
}

export function proxyProtocol(value: unknown): ProxyProtocol | null {
  return value === "http" || value === "https" || value === "socks5" ? value : null;
}

export function defaultProxyPort(protocol: ProxyProtocol): number {
  return protocol === "https" ? 443 : protocol === "http" ? 80 : 1080;
}

export function isProxyRelayHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(".vercel.app") || normalized.endsWith(".workers.dev") || normalized.endsWith(".netlify.app");
}

/** Mutable write-only variant of a readonly interface, for request-body narrowing. */
type WriteablePartial<T> = { -readonly [K in keyof T]?: T[K] };

export function sanitizeRuntimePatch(value: Record<string, unknown>): WriteablePartial<ConsoleRuntimeSettings> {
  const patch: WriteablePartial<ConsoleRuntimeSettings> = {};
  if (value.proxyAuthMode === "open" || value.proxyAuthMode === "api_key") patch.proxyAuthMode = value.proxyAuthMode;
  if (value.privacyMode === "masked" || value.privacyMode === "full") patch.privacyMode = value.privacyMode;
  if (value.trackPayloads === "none" || value.trackPayloads === "bounded") patch.trackPayloads = value.trackPayloads;
  if (value.trackAssets === "none" || value.trackAssets === "meta" || value.trackAssets === "store") patch.trackAssets = value.trackAssets;
  if (typeof value.logRetentionDays === "number" && Number.isFinite(value.logRetentionDays)) patch.logRetentionDays = Math.max(0, Math.floor(value.logRetentionDays));
  if (typeof value.assetRetentionDays === "number" && Number.isFinite(value.assetRetentionDays)) patch.assetRetentionDays = Math.max(0, Math.floor(value.assetRetentionDays));
  if (typeof value.maxFlightsPerIp === "number" && Number.isFinite(value.maxFlightsPerIp)) patch.maxFlightsPerIp = Math.max(1, Math.floor(value.maxFlightsPerIp));
  if (typeof value.sessionTtlHours === "number" && Number.isFinite(value.sessionTtlHours)) patch.sessionTtlHours = Math.max(1, Math.floor(value.sessionTtlHours));
  if (typeof value.trustProxy === "boolean") patch.trustProxy = value.trustProxy;
  if (typeof value.cacheMarkersEnabled === "boolean") patch.cacheMarkersEnabled = value.cacheMarkersEnabled;
  if (value.sidebarIconDataUrl === null || typeof value.sidebarIconDataUrl === "string") patch.sidebarIconDataUrl = value.sidebarIconDataUrl;
  if (typeof value.tokenSaverEnabled === "boolean") patch.tokenSaverEnabled = value.tokenSaverEnabled;
  if (value.tokenSaverQuality === "lite" || value.tokenSaverQuality === "balanced" || value.tokenSaverQuality === "extreme") patch.tokenSaverQuality = value.tokenSaverQuality;
  if (typeof value.headroomEnabled === "boolean") patch.headroomEnabled = value.headroomEnabled;
  if (value.headroomUrl === null || typeof value.headroomUrl === "string") patch.headroomUrl = value.headroomUrl;
  if (typeof value.headroomTimeoutMs === "number" && Number.isFinite(value.headroomTimeoutMs)) patch.headroomTimeoutMs = Math.min(10_000, Math.max(250, Math.floor(value.headroomTimeoutMs)));
  if (typeof value.ponytailEnabled === "boolean") patch.ponytailEnabled = value.ponytailEnabled;
  if (typeof value.filterRulesEnabled === "boolean") patch.filterRulesEnabled = value.filterRulesEnabled;
  return patch;
}

export function sanitizeProviderRoutingPatch(value: unknown): WriteablePartial<ProviderRoutingSettings> {
  const patch: WriteablePartial<ProviderRoutingSettings> = {};
  if (typeof value !== "object" || value === null) return patch;
  const item = value as Record<string, unknown>;
  if (item.strategy === "priority" || item.strategy === "round-robin") patch.strategy = item.strategy;
  if (typeof item.stickyLimit === "number" && Number.isFinite(item.stickyLimit)) patch.stickyLimit = Math.max(0, Math.floor(item.stickyLimit));
  if (typeof item.useStickyLimit === "boolean") patch.useStickyLimit = item.useStickyLimit;
  return patch;
}

export function nullableLimit(item: unknown): number | null | undefined {
  if (item === null) return null;
  return typeof item === "number" && Number.isFinite(item) && item > 0 ? Math.floor(item) : undefined;
}

/** Create-time variant: `null`/invalid are treated as absent (no limit). */
export function limitOrUndefined(item: unknown): number | undefined {
  return nullableLimit(item) ?? undefined;
}

export function nullableStringList(item: unknown): readonly string[] | null | undefined {
  if (item === null) return null;
  return Array.isArray(item) ? item.flatMap((entry) => (typeof entry === "string" ? [entry] : [])) : undefined;
}

export function nullableText(item: unknown): string | null | undefined {
  if (item === null) return null;
  return typeof item === "string" ? item : undefined;
}

export function sanitizeKeyUpdate(value: Record<string, unknown>): WriteablePartial<ApiKeyUpdateInput> {
  const patch: WriteablePartial<ApiKeyUpdateInput> = {};
  const customKey = stringOrUndefined(value.key);
  if (customKey !== undefined && isValidCustomApiKey(customKey)) patch.key = customKey;
  const rateLimitRpm = nullableLimit(value.rateLimitRpm);
  if (rateLimitRpm !== undefined) patch.rateLimitRpm = rateLimitRpm;
  const dailyTokenLimit = nullableLimit(value.dailyTokenLimit);
  if (dailyTokenLimit !== undefined) patch.dailyTokenLimit = dailyTokenLimit;
  const monthlyTokenLimit = nullableLimit(value.monthlyTokenLimit);
  if (monthlyTokenLimit !== undefined) patch.monthlyTokenLimit = monthlyTokenLimit;
  const oneTimeTokenLimit = nullableLimit(value.oneTimeTokenLimit);
  if (oneTimeTokenLimit !== undefined) patch.oneTimeTokenLimit = oneTimeTokenLimit;
  const maxConcurrentRequests = nullableLimit(value.maxConcurrentRequests);
  if (maxConcurrentRequests !== undefined) patch.maxConcurrentRequests = maxConcurrentRequests;
  const providerAllowlist = nullableStringList(value.providerAllowlist);
  if (providerAllowlist !== undefined) patch.providerAllowlist = providerAllowlist;
  const modelAllowlist = nullableStringList(value.modelAllowlist);
  if (modelAllowlist !== undefined) patch.modelAllowlist = modelAllowlist;
  const modelDenylist = nullableStringList(value.modelDenylist);
  if (modelDenylist !== undefined) patch.modelDenylist = modelDenylist;
  const quoteBigText = nullableText(value.quoteBigText);
  if (quoteBigText !== undefined) patch.quoteBigText = quoteBigText;
  const quoteSubText = nullableText(value.quoteSubText);
  if (quoteSubText !== undefined) patch.quoteSubText = quoteSubText;
  const quoteBody = nullableText(value.quoteBody);
  if (quoteBody !== undefined) patch.quoteBody = quoteBody;
  if (typeof value.active === "boolean") patch.active = value.active;
  return patch;
}

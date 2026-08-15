import { daemonDelete, daemonGet, daemonPatch, daemonPost } from "../../lib/daemon-api";
import { qk } from "../../lib/query-keys";
import {
  normalizeProxy,
  normalizeProxyBatchResult,
  normalizeProxyCountries,
  normalizeProxyList,
  normalizeProxyScrapeSources,
  normalizeProxySettings,
  normalizeProxyTestResult,
  toProxyInput,
  type ProxyBatchResult,
  type ProxyInput,
  type ProxyRecord,
  type ProxyScrapeSource,
  type ProxySettings,
  type ProxyTestResult,
} from "./contracts";

const MAX_LIMIT = 100;

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return MAX_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? MAX_LIMIT)));
}

function boundedText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function boundedId(value: string): string {
  const id = boundedText(value, 128);
  if (!id) throw new Error("proxy id is required");
  return encodeURIComponent(id);
}

/** Lists persisted proxy records from the daemon V2 admin resource. */
export async function listProxies(limit?: number): Promise<ProxyRecord[]> {
  const value = await daemonGet<unknown>(`/proxies?limit=${boundedLimit(limit)}`);
  return normalizeProxyList(value);
}

/** Creates a proxy using the daemon's write-only password input shape. */
export async function createProxy(input: ProxyInput): Promise<ProxyRecord> {
  const value = await daemonPost<unknown>("/proxies", toProxyInput(input));
  return normalizeProxy(value);
}

/** Updates a proxy; omitted password preserves the daemon-side credential. */
export async function updateProxy(id: string, input: ProxyInput): Promise<ProxyRecord> {
  const value = await daemonPatch<unknown>(`/proxies/${boundedId(id)}`, toProxyInput(input));
  return normalizeProxy(value);
}

/** Deletes a proxy only after an explicit operator confirmation. */
export async function deleteProxy(id: string, options: { confirmed: boolean }): Promise<void> {
  if (!options.confirmed) throw new Error("proxy deletion requires confirmation");
  await daemonDelete<unknown>(`/proxies/${boundedId(id)}`);
}

/** Runs a connectivity test and exposes only bounded, sanitized evidence. */
export async function testProxy(id: string): Promise<ProxyTestResult> {
  const value = await daemonPost<unknown>(`/proxies/${boundedId(id)}/test`);
  return normalizeProxyTestResult(value);
}

/** Searches daemon-supported proxy sources; no direct upstream request is made by the browser. */
export async function searchProxies(input: { query?: string; countries?: readonly string[]; limit?: number }): Promise<ProxyRecord[]> {
  const body = {
    query: boundedText(input.query ?? "", 200),
    country: (input.countries ?? []).map((country) => boundedText(country, 64)).filter(Boolean).slice(0, 20),
    limit: boundedLimit(input.limit),
  };
  const value = await daemonPost<unknown>("/proxies/search", body);
  return normalizeProxyList(value);
}

export async function importProxies(inputs: readonly ProxyInput[], options: { confirmed: boolean }): Promise<ProxyBatchResult> {
  if (!options.confirmed) throw new Error("proxy import requires confirmation");
  if (inputs.length === 0 || inputs.length > MAX_LIMIT) throw new Error("proxy import size is invalid");
  const value = await daemonPost<unknown>("/proxies/import", { proxies: inputs.map(toProxyInput) });
  return normalizeProxyBatchResult(value);
}

export async function scrapeProxies(input: { sources?: readonly string[]; countries?: readonly string[]; limit?: number }): Promise<ProxyBatchResult> {
  const value = await daemonPost<unknown>("/proxies/scrape", {
    sources: (input.sources ?? []).map((source) => boundedText(source, 128)).filter(Boolean).slice(0, 20),
    countries: (input.countries ?? []).map((country) => boundedText(country, 64)).filter(Boolean).slice(0, 20),
    limit: boundedLimit(input.limit),
  });
  return normalizeProxyBatchResult(value);
}

/** Reads daemon-advertised scrape source metadata. */
export async function listProxyScrapeSources(): Promise<ProxyScrapeSource[]> {
  const value = await daemonGet<unknown>("/proxies/scrape/catalog");
  return normalizeProxyScrapeSources(value);
}

/** Reads daemon-advertised country filters for scrape/search forms. */
export async function listProxyCountries(): Promise<string[]> {
  const value = await daemonGet<unknown>("/proxies/scrape/countries");
  return normalizeProxyCountries(value);
}

/** Reads the daemon outbound proxy policy. */
export async function getProxySettings(): Promise<ProxySettings> {
  const value = await daemonGet<unknown>("/proxy-settings");
  return normalizeProxySettings(value);
}

/** Patches outbound proxy policy through the daemon-owned settings resource. */
export async function patchProxySettings(input: Partial<ProxySettings>): Promise<ProxySettings> {
  const value = await daemonPost<unknown>("/proxy-settings", {
    ...(typeof input.mode === "string" ? { mode: boundedText(input.mode, 64) } : {}),
    ...(typeof input.defaultProxy === "string" ? { defaultProxy: boundedText(input.defaultProxy, 128) } : {}),
    ...(input.defaultProxy === null ? { defaultProxy: "" } : {}),
    ...(input.allowList ? { allowList: input.allowList.map((entry) => boundedText(entry, 512)).slice(0, 500) } : {}),
    ...(input.blockList ? { blockList: input.blockList.map((entry) => boundedText(entry, 512)).slice(0, 500) } : {}),
  });
  return normalizeProxySettings(value);
}

/** Query keys that callers should invalidate after proxy mutations. */
export const proxyQueryKeys = qk.proxies;

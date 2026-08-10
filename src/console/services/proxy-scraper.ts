import type { ProxyProtocol } from "../views";

export type ScrapeSource = "proxyscrape" | "geonode" | "proxifly" | "all";
export type ScrapeProtocol = "http" | "socks5" | "all";

export interface ScrapedProxy {
  readonly url: string;
  readonly protocol: Extract<ProxyProtocol, "http" | "socks5">;
  readonly host: string;
  readonly port: number;
  readonly country: string | null;
}

export interface ScrapeOptions {
  readonly source?: ScrapeSource;
  readonly country?: string;
  readonly protocol?: ScrapeProtocol;
  readonly limit?: number;
}

/** Fetch function seam used by source scrapers and deterministic tests. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const COUNTRIES: readonly { readonly code: string; readonly name: string }[] = [
  { code: "all", name: "Any region" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "RU", name: "Russia" },
  { code: "ID", name: "Indonesia" },
  { code: "SG", name: "Singapore" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "IN", name: "India" },
  { code: "CN", name: "China" },
  { code: "HK", name: "Hong Kong" },
  { code: "BR", name: "Brazil" },
  { code: "AU", name: "Australia" },
  { code: "TR", name: "Turkey" },
  { code: "VN", name: "Vietnam" },
  { code: "TH", name: "Thailand" },
  { code: "PL", name: "Poland" },
  { code: "UA", name: "Ukraine" },
  { code: "MX", name: "Mexico" },
];

const FETCH_TIMEOUT_MS = 20_000;

function normalizeProtocol(value: string): Extract<ProxyProtocol, "http" | "socks5"> | null {
  const normalized = value.toLowerCase();
  if (normalized === "http" || normalized === "https") return "http";
  if (normalized === "socks5" || normalized === "socks5h") return "socks5";
  return null;
}

/** Parses a source line into the normalized proxy shape used by the pool. */
export function parseProxyLine(line: string, country: string | null): ScrapedProxy | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    const authority = trimmed.match(/^[a-z0-9]+:\/\/(\[[^\]]+\]|[^/:\s]+):(\d+)$/i);
    if (authority === null) return null;
    const parsed = new URL(trimmed);
    const protocol = normalizeProtocol(parsed.protocol.slice(0, -1));
    const host = parsed.hostname;
    const port = Number(authority[2]);
    if (protocol === null || host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { url: `${protocol}://${host}:${port}`, protocol, host, port, country };
  } catch {
    return null;
  }
}

async function fetchText(url: string, fetchFn: FetchLike): Promise<string> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function scrapeProxyScrape(country: string, protocol: ScrapeProtocol, fetchFn: FetchLike): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({ request: "display_proxies", proxy_format: "protocolipport", format: "text" });
  if (country !== "all") params.set("country", country.toLowerCase());
  if (protocol !== "all") params.set("protocol", protocol);
  const text = await fetchText(`https://api.proxyscrape.com/v4/free-proxy-list/get?${params}`, fetchFn);
  const countryTag = country === "all" ? null : country;
  return text.split("\n").map((line) => parseProxyLine(line, countryTag)).filter((proxy): proxy is ScrapedProxy => proxy !== null);
}

async function scrapeGeonode(country: string, protocol: ScrapeProtocol, fetchFn: FetchLike): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({ limit: "500", page: "1", sort_by: "lastChecked", sort_type: "desc" });
  if (country !== "all") params.set("country", country);
  if (protocol !== "all") params.set("protocols", protocol);
  const response = await fetchText(`https://proxylist.geonode.com/api/proxy-list?${params}`, fetchFn);
  const payload = JSON.parse(response) as { data?: { ip: string; port: string; protocols?: string[]; country?: string }[] };
  const proxies: ScrapedProxy[] = [];
  for (const row of payload.data ?? []) {
    const sourceProtocol = (row.protocols ?? []).map(normalizeProtocol).find((value) => value !== null) ?? null;
    const port = Number(row.port);
    if (sourceProtocol === null || !row.ip || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (protocol !== "all" && sourceProtocol !== protocol) continue;
    proxies.push({ url: `${sourceProtocol}://${row.ip}:${port}`, protocol: sourceProtocol, host: row.ip, port, country: row.country ?? null });
  }
  return proxies;
}

async function scrapeProxifly(country: string, protocol: ScrapeProtocol, fetchFn: FetchLike): Promise<ScrapedProxy[]> {
  const path = country === "all" ? "proxies/all/data.txt" : `proxies/countries/${country}/data.txt`;
  const text = await fetchText(`https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/${path}`, fetchFn);
  const countryTag = country === "all" ? null : country;
  return text
    .split("\n")
    .map((line) => parseProxyLine(line, countryTag))
    .filter((proxy): proxy is ScrapedProxy => proxy !== null)
    .filter((proxy) => protocol === "all" || proxy.protocol === protocol);
}

/** Fetches selected free-proxy sources concurrently and de-duplicates URLs. */
export async function scrapeProxies(options: ScrapeOptions = {}, fetchFn: FetchLike = fetch): Promise<ScrapedProxy[]> {
  const source = options.source ?? "all";
  const country = (options.country ?? "all").toLowerCase() === "all" ? "all" : (options.country ?? "all").toUpperCase();
  const protocol = options.protocol ?? "all";
  const limit = options.limit ?? 100;
  const tasks: Promise<ScrapedProxy[]>[] = [];

  if (source === "proxyscrape" || source === "all") tasks.push(scrapeProxyScrape(country, protocol, fetchFn));
  if (source === "geonode" || source === "all") tasks.push(scrapeGeonode(country, protocol, fetchFn));
  if (source === "proxifly" || source === "all") tasks.push(scrapeProxifly(country, protocol, fetchFn));

  const settled = await Promise.allSettled(tasks);
  const seen = new Set<string>();
  const merged: ScrapedProxy[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const proxy of result.value) {
      if (seen.has(proxy.url)) continue;
      seen.add(proxy.url);
      merged.push(proxy);
    }
  }
  return limit > 0 ? merged.slice(0, limit) : merged;
}

/** Maps items with a bounded number of async workers while preserving order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(Math.max(normalizedConcurrency, 1), items.length);
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

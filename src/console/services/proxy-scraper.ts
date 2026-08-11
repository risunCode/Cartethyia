export { mapWithConcurrency } from "../../application/concurrency";
import type { ProxyProtocol } from "../views";

export type ScrapeSource = "proxyscrape" | "geonode" | "proxifly" | "thespeedx" | "jetkai" | "iplocate" | "vpslab" | "hproxy" | "all";
export type ScrapeSourceId = Exclude<ScrapeSource, "all">;
export type ScrapeProtocol = "http" | "socks5" | "all";

export interface ScrapeSourceDescriptor {
  readonly id: ScrapeSourceId;
  readonly label: string;
  readonly protocols: readonly Exclude<ScrapeProtocol, "all">[];
  readonly countryAware: boolean;
  readonly feeds?: Readonly<Record<Exclude<ScrapeProtocol, "all">, string>>;
}

export const SCRAPE_SOURCE_CATALOG: readonly ScrapeSourceDescriptor[] = [
  { id: "proxyscrape", label: "ProxyScrape", protocols: ["http", "socks5"], countryAware: true },
  { id: "geonode", label: "Geonode", protocols: ["http", "socks5"], countryAware: true },
  { id: "proxifly", label: "Proxifly", protocols: ["http", "socks5"], countryAware: true },
  {
    id: "thespeedx",
    label: "TheSpeedX",
    protocols: ["http", "socks5"],
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
      socks5: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    },
  },
  {
    id: "jetkai",
    label: "Jetkai",
    protocols: ["http", "socks5"],
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
      socks5: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt",
    },
  },
  {
    id: "iplocate",
    label: "IPLocate",
    protocols: ["http", "socks5"],
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
      socks5: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
    },
  },
  {
    id: "vpslab",
    label: "VPSLab",
    protocols: ["http", "socks5"],
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/http_all.txt",
      socks5: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/main/socks5_all.txt",
    },
  },
  {
    id: "hproxy",
    label: "HProxy",
    protocols: ["http", "socks5"],
    countryAware: false,
    feeds: {
      http: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt",
      socks5: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/socks5.txt",
    },
  },
];

const SCRAPE_SOURCE_BY_ID: ReadonlyMap<ScrapeSourceId, ScrapeSourceDescriptor> = new Map(
  SCRAPE_SOURCE_CATALOG.map((source) => [source.id, source] as const),
);

export function isScrapeSource(value: unknown): value is ScrapeSource {
  return value === "all" || (typeof value === "string" && SCRAPE_SOURCE_BY_ID.has(value as ScrapeSourceId));
}

export function normalizeScrapeSource(value: unknown): ScrapeSource {
  return isScrapeSource(value) ? value : "all";
}

export interface ScrapedProxy {
  readonly url: string;
  readonly protocol: Extract<ProxyProtocol, "http" | "socks5">;
  readonly host: string;
  readonly port: number;
  readonly country: string | null;
  readonly source: ScrapeSourceId;
}

export interface ScrapeOptions {
  readonly source?: ScrapeSource;
  readonly country?: string;
  readonly protocol?: ScrapeProtocol;
  readonly limit?: number;
}
export function canonicalProxyKey(proxy: { readonly protocol: string; readonly host: string; readonly port: number }): string {
  const protocol = proxy.protocol.trim().toLowerCase();
  const host = proxy.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return `${protocol}://${host}:${proxy.port}`;
}
export type ScrapeSourceStatus = "fulfilled" | "empty" | "failed";

export interface ScrapeProtocolResult {
  readonly status: ScrapeSourceStatus;
  readonly count: number;
  readonly error?: string;
}

export interface ScrapeSourceResult {
  readonly id: ScrapeSourceId;
  readonly label: string;
  readonly status: ScrapeSourceStatus;
  readonly count: number;
  readonly error?: string;
  readonly protocols?: Readonly<Partial<Record<Exclude<ScrapeProtocol, "all">, ScrapeProtocolResult>>>;
}

export interface ScrapeDetailedResult {
  readonly proxies: readonly ScrapedProxy[];
  readonly sources: readonly ScrapeSourceResult[];
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
type PublicTextSource = Exclude<ScrapeSource, "proxyscrape" | "geonode" | "proxifly" | "all">;
type PublicTextProtocol = Exclude<ScrapeProtocol, "all">;


function normalizeProtocol(value: string): Extract<ProxyProtocol, "http" | "socks5"> | null {
  const normalized = value.toLowerCase();
  if (normalized === "http" || normalized === "https") return "http";
  if (normalized === "socks5" || normalized === "socks5h") return "socks5";
  return null;
}

/** Parses a source line into the normalized proxy shape used by the pool. */
export function parseProxyLine(line: string, country: string | null, source: ScrapeSourceId = "proxyscrape"): ScrapedProxy | null {
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
    return { url: `${protocol}://${host}:${port}`, protocol, host, port, country, source };
  } catch {
    return null;
  }
}

/** Parses a raw `host:port` feed line using the feed's declared protocol. */
export function parseHostPortLine(line: string, protocol: PublicTextProtocol, country: string | null, source: ScrapeSourceId = "thespeedx"): ScrapedProxy | null {
  const match = line.trim().match(/^(\[[^\]]+\]|[^:\s]+):(\d+)$/);
  if (match === null) return null;
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return { url: `${protocol}://${urlHost}:${port}`, protocol, host, port, country, source };
}

async function fetchText(url: string, fetchFn: FetchLike, signal?: AbortSignal): Promise<string> {
  const response = await fetchFn(url, { signal: signal === undefined ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
function parseFeedLines<T>(text: string, parser: (line: string) => T | null, maxCandidates: number): T[] {
  const parsed: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = parser(line);
    if (value === null) continue;
    parsed.push(value);
    if (parsed.length >= maxCandidates) break;
  }
  return parsed;
}

interface ScrapeTaskOutput {
  readonly proxies: readonly ScrapedProxy[];
  readonly protocols?: Readonly<Partial<Record<PublicTextProtocol, ScrapeProtocolResult>>>;
}
async function scrapePublicTextSource(source: PublicTextSource, country: string, protocol: ScrapeProtocol, maxCandidates: number, fetchFn: FetchLike, signal?: AbortSignal): Promise<ScrapeTaskOutput> {
  // These global feeds do not carry trustworthy country metadata. Keep the
  // region filter strict rather than returning candidates from the wrong area.
  if (country !== "all") return { proxies: [] };
  const feeds = sourceDescriptor(source).feeds;
  if (feeds === undefined) throw new Error(`Source "${source}" has no text feeds`);
  const protocols: PublicTextProtocol[] = protocol === "all" ? ["http", "socks5"] : [protocol];
  const settled = await Promise.allSettled(protocols.map(async (feedProtocol) => {
    const text = await fetchText(feeds[feedProtocol], fetchFn, signal);
    return parseFeedLines(text, (line) => parseHostPortLine(line, feedProtocol, null, source), maxCandidates);
  }));
  const protocolResults: Partial<Record<PublicTextProtocol, ScrapeProtocolResult>> = {};
  settled.forEach((result, index) => {
    const feedProtocol = protocols[index]!;
    if (result.status === "fulfilled") {
      protocolResults[feedProtocol] = { status: result.value.length === 0 ? "empty" : "fulfilled", count: result.value.length };
      return;
    }
    protocolResults[feedProtocol] = {
      status: "failed",
      count: 0,
      error: (result.reason instanceof Error ? result.reason.message : "Feed request failed").slice(0, 200),
    };
  });
  const fulfilled = settled.filter((result): result is PromiseFulfilledResult<ScrapedProxy[]> => result.status === "fulfilled");
  return { proxies: fulfilled.flatMap((result) => result.value), protocols: protocolResults };
}

async function scrapeProxyScrape(country: string, protocol: ScrapeProtocol, maxCandidates: number, fetchFn: FetchLike, signal?: AbortSignal): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({ request: "display_proxies", proxy_format: "protocolipport", format: "text" });
  if (country !== "all") params.set("country", country.toLowerCase());
  if (protocol !== "all") params.set("protocol", protocol);
  const text = await fetchText(`https://api.proxyscrape.com/v4/free-proxy-list/get?${params}`, fetchFn, signal);
  const countryTag = country === "all" ? null : country;
  return parseFeedLines(text, (line) => parseProxyLine(line, countryTag, "proxyscrape"), maxCandidates);
}

async function scrapeGeonode(country: string, protocol: ScrapeProtocol, maxCandidates: number, fetchFn: FetchLike, signal?: AbortSignal): Promise<ScrapedProxy[]> {
  const params = new URLSearchParams({ limit: "500", page: "1", sort_by: "lastChecked", sort_type: "desc" });
  if (country !== "all") params.set("country", country);
  if (protocol !== "all") params.set("protocols", protocol);
  const response = await fetchText(`https://proxylist.geonode.com/api/proxy-list?${params}`, fetchFn, signal);
  const payload = JSON.parse(response) as { data?: { ip: string; port: string; protocols?: string[]; country?: string }[] };
  const proxies: ScrapedProxy[] = [];
  for (const row of payload.data ?? []) {
    const sourceProtocol = (row.protocols ?? []).map(normalizeProtocol).find((value) => value !== null) ?? null;
    const port = Number(row.port);
    if (sourceProtocol === null || !row.ip || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (protocol !== "all" && sourceProtocol !== protocol) continue;
    proxies.push({ url: `${sourceProtocol}://${row.ip}:${port}`, protocol: sourceProtocol, host: row.ip, port, country: row.country ?? null, source: "geonode" });
    if (proxies.length >= maxCandidates) break;
  }
  return proxies;
}

async function scrapeProxifly(country: string, protocol: ScrapeProtocol, maxCandidates: number, fetchFn: FetchLike, signal?: AbortSignal): Promise<ScrapedProxy[]> {
  const path = country === "all" ? "proxies/all/data.txt" : `proxies/countries/${country}/data.txt`;
  const text = await fetchText(`https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/${path}`, fetchFn, signal);
  const countryTag = country === "all" ? null : country;
  return parseFeedLines(text, (line) => {
    const proxy = parseProxyLine(line, countryTag, "proxifly");
    return proxy !== null && (protocol === "all" || proxy.protocol === protocol) ? proxy : null;
  }, maxCandidates);
}

/** Interleaves source batches so one large feed cannot starve the others. */
function interleaveBatches(batches: readonly (readonly ScrapedProxy[])[], limit: number): ScrapedProxy[] {
  const target = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const merged: ScrapedProxy[] = [];
  let offset = 0;
  while (merged.length < target) {
    let foundBatchItem = false;
    for (const batch of batches) {
      const proxy = batch[offset];
      if (proxy === undefined) continue;
      foundBatchItem = true;
      const key = canonicalProxyKey(proxy);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(proxy);
      if (merged.length >= target) break;
    }
    if (!foundBatchItem) break;
    offset += 1;
  }
  return merged;
}
function sourceDescriptor(id: ScrapeSourceId): ScrapeSourceDescriptor {
  const descriptor = SCRAPE_SOURCE_BY_ID.get(id);
  if (descriptor === undefined) throw new Error(`Unknown scrape source "${id}"`);
  return descriptor;
}

function isPublicTextSource(source: ScrapeSourceId): source is PublicTextSource {
  return sourceDescriptor(source).feeds !== undefined;
}

function asScrapeTask(promise: Promise<ScrapedProxy[]>): Promise<ScrapeTaskOutput> {
  return promise.then((proxies) => ({ proxies }));
}

interface ScrapeTask {
  readonly source: ScrapeSourceId;
  readonly run: Promise<ScrapeTaskOutput>;
}

/** Fetches selected sources concurrently and returns fair candidates plus source diagnostics. */
export async function scrapeProxiesDetailed(options: ScrapeOptions = {}, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<ScrapeDetailedResult> {
  const source = normalizeScrapeSource(options.source);
  const country = (options.country ?? "all").toLowerCase() === "all" ? "all" : (options.country ?? "all").toUpperCase();
  const protocol = options.protocol ?? "all";
  const limit = options.limit ?? 100;
  const maxCandidates = Math.max(10, Math.min(500, limit > 0 ? limit : 500));
  const tasks: ScrapeTask[] = [];
  if (source === "proxyscrape" || source === "all") tasks.push({ source: "proxyscrape", run: asScrapeTask(scrapeProxyScrape(country, protocol, maxCandidates, fetchFn, signal)) });
  if (source === "geonode" || source === "all") tasks.push({ source: "geonode", run: asScrapeTask(scrapeGeonode(country, protocol, maxCandidates, fetchFn, signal)) });
  if (source === "proxifly" || source === "all") tasks.push({ source: "proxifly", run: asScrapeTask(scrapeProxifly(country, protocol, maxCandidates, fetchFn, signal)) });
  for (const descriptor of SCRAPE_SOURCE_CATALOG) {
    if (!isPublicTextSource(descriptor.id) || (source !== "all" && source !== descriptor.id)) continue;
    tasks.push({ source: descriptor.id, run: scrapePublicTextSource(descriptor.id, country, protocol, maxCandidates, fetchFn, signal) });
  }
  const settled = await Promise.allSettled(tasks.map((task) => task.run));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Search cancelled", "AbortError");
  const sources = settled.map((result, index): ScrapeSourceResult => {
    const task = tasks[index]!;
    const descriptor = sourceDescriptor(task.source);
    if (result.status === "rejected") {
      return { id: task.source, label: descriptor.label, status: "failed", count: 0, error: result.reason instanceof Error ? result.reason.message.slice(0, 200) : "Source request failed" };
    }
    const output = result.value;
    const protocolEntries = Object.entries(output.protocols ?? {});
    const failedProtocols = protocolEntries.filter(([, value]) => value?.status === "failed");
    const status: ScrapeSourceStatus = output.proxies.length > 0 ? "fulfilled" : failedProtocols.length > 0 ? "failed" : "empty";
    const protocolError = failedProtocols.map(([name, value]) => `${name}: ${value?.error ?? "feed request failed"}`).join("; ");
    return {
      id: task.source,
      label: descriptor.label,
      status,
      count: output.proxies.length,
      ...(failedProtocols.length === 0 ? {} : { protocols: output.protocols }),
      ...(status === "failed" ? { error: protocolError.slice(0, 200) } : {}),
    };
  });
  const batches = settled.filter((result): result is PromiseFulfilledResult<ScrapeTaskOutput> => result.status === "fulfilled").map((result) => result.value.proxies);
  return { proxies: interleaveBatches(batches, limit), sources };
}
export async function scrapeProxies(options: ScrapeOptions = {}, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<ScrapedProxy[]> {
  return [...(await scrapeProxiesDetailed(options, fetchFn, signal)).proxies];
}

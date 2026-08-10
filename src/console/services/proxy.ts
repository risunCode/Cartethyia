import { sanitizeMessage } from "../../application/contracts";
import { buildProxyFetcher } from "../../traffic";
import type {
  ConsoleErrorCode,
  ProxyRepository,
  ProxyRowView,
  ProxySettingsRepository,
  ProxySettingsView,
  ProxyTestInput,
  ProxyTestResult,
  RouteTransitionStore,
  RouteTransitionView,
} from "../views";
import { loadRouteTransition } from "../views";
import { booleanOrUndefined, boundedNumber, defaultProxyPort, isProxyRelayHost, nullableString, numberOrUndefined, proxyProtocol, stringListOrUndefined, stringOrUndefined } from "../input-sanitizers";
import { mapWithConcurrency, scrapeProxies, type ScrapeOptions, type ScrapeProtocol, type ScrapeSource } from "./proxy-scraper";

const DEFAULT_PROXY_CANARY_URL = "https://www.google.com/generate_204";

const DEFAULT_SCRAPE_LIMIT = 50;
const MAX_SCRAPE_LIMIT = 500;
const DEFAULT_SCRAPE_VERIFY_CONCURRENCY = 20;
const MAX_SCRAPE_VERIFY_CONCURRENCY = 64;
const configuredScrapeConcurrency = Number(process.env.CARTETHYIA_PROXY_SCRAPE_CONCURRENCY);
const SCRAPE_VERIFY_CONCURRENCY = Math.min(
  MAX_SCRAPE_VERIFY_CONCURRENCY,
  Math.max(1, Number.isFinite(configuredScrapeConcurrency) ? Math.floor(configuredScrapeConcurrency) : DEFAULT_SCRAPE_VERIFY_CONCURRENCY),
);

export interface ProxyScrapeResult {
  readonly scraped: number;
  readonly verified: number;
  readonly added: number;
  readonly skipped: number;
}

function proxyKey(protocol: string, host: string, port: number): string {
  return `${protocol}://${host.toLowerCase()}:${port}`;
}

function normalizeScrapeInput(input: unknown): ScrapeOptions & { readonly verify: boolean } {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const source: ScrapeSource = value.source === "proxyscrape" || value.source === "geonode" || value.source === "proxifly" ? value.source : "all";
  const protocol: ScrapeProtocol = value.protocol === "http" || value.protocol === "socks5" ? value.protocol : "all";
  const rawCountry = typeof value.country === "string" ? value.country.trim() : "all";
  const country = rawCountry.toLowerCase() === "all" ? "all" : /^[a-z]{2}$/i.test(rawCountry) ? rawCountry.toUpperCase() : "all";
  const rawLimit = typeof value.limit === "number" && Number.isFinite(value.limit) ? Math.round(value.limit) : DEFAULT_SCRAPE_LIMIT;
  return {
    source,
    protocol,
    country,
    limit: Math.min(MAX_SCRAPE_LIMIT, Math.max(1, rawLimit)),
    verify: value.verify !== false,
  };
}

async function probeProxy(input: ProxyTestInput): Promise<ProxyTestResult> {
  const started = performance.now();
  const auth = input.username ? `${encodeURIComponent(input.username)}${input.password ? `:${encodeURIComponent(input.password)}` : ""}@` : "";
  try {
    const fetcher = buildProxyFetcher({ url: `${input.protocol}://${auth}${input.host}:${input.port}`, isRelay: input.isRelay });
    const response = await fetcher(DEFAULT_PROXY_CANARY_URL, { method: "GET", signal: AbortSignal.timeout(10_000) });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok && response.status !== 204) return { ok: false, latencyMs, statusCode: response.status, error: `Canary request returned HTTP ${response.status}` };
    return { ok: true, latencyMs, statusCode: response.status };
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? sanitizeMessage(error) : "Connection failed — network unreachable or DNS resolution failed" };
  }
}

export class ProxyService {
  constructor(
    private readonly repo: ProxyRepository,
    private readonly settings: ProxySettingsRepository,
    private readonly transitions: RouteTransitionStore,
  ) {}

  async list(): Promise<readonly ProxyView[]> {
    const rows = await this.repo.list();
    return Promise.all(rows.map(async (row) => ({ ...row, ...(await loadRouteTransition("proxy", row.id, row.health, this.transitions)) })));
  }

  async get(id: string): Promise<ProxyView | null> {
    const row = await this.repo.get(id);
    if (row === null) return null;
    return { ...row, ...(await loadRouteTransition("proxy", row.id, row.health, this.transitions)) };
  }

  async create(input: unknown): Promise<{ readonly id: string; readonly passwordHint: string | null } | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "proxy name is required" };
    }
    if (typeof value.host !== "string" || value.host.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "proxy host is required" };
    }
    const protocol = proxyProtocol(value.protocol);
    if (protocol === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "proxy protocol must be http, https or socks5" };
    }
    const port = value.port === undefined ? defaultProxyPort(protocol) : numberOrUndefined(value.port);
    if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return { ok: false, status: 400, code: "invalid_request", message: "proxy port must be an integer between 1 and 65535" };
    }
    return this.repo.create({
      name: value.name.trim(),
      protocol,
      isRelay: booleanOrUndefined(value.isRelay) ?? isProxyRelayHost(value.host.trim()),
      host: value.host.trim(),
      port,
      username: nullableString(value.username),
      password: nullableString(value.password),
      maxConcurrency: boundedNumber(value.maxConcurrency, 1, 10_000),
      weight: boundedNumber(value.weight, 1, 1_000),
      priority: numberOrUndefined(value.priority),
      active: booleanOrUndefined(value.active),
    });
  }

  async update(id: string, patch: unknown): Promise<ProxyRowView | null> {
    if (typeof patch !== "object" || patch === null) return null;
    const value = patch as Record<string, unknown>;
    const protocol = proxyProtocol(value.protocol);
    return this.repo.update(id, {
      name: stringOrUndefined(value.name),
      protocol: protocol ?? undefined,
      isRelay: value.host !== undefined ? (booleanOrUndefined(value.isRelay) ?? (typeof value.host === "string" ? isProxyRelayHost(value.host.trim()) : undefined)) : booleanOrUndefined(value.isRelay),
      host: stringOrUndefined(value.host),
      port: numberOrUndefined(value.port),
      username: nullableString(value.username),
      password: nullableString(value.password),
      maxConcurrency: boundedNumber(value.maxConcurrency, 1, 10_000),
      weight: boundedNumber(value.weight, 1, 1_000),
      priority: numberOrUndefined(value.priority),
      active: booleanOrUndefined(value.active),
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.repo.remove(id);
  }

  async credential(id: string): Promise<{ readonly password: string | null } | null> {
    return this.repo.credential(id);
  }

  async test(id: string): Promise<ProxyTestResult | null> {
    const proxy = await this.repo.get(id);
    if (proxy === null) return null;
    const credential = await this.repo.credential(id);
    const result = await probeProxy({ protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: credential?.password ?? null, isRelay: proxy.isRelay });
    const testedAt = new Date().toISOString();
    try {
      await this.repo.recordTest(id, {
        testedAt,
        ok: result.ok,
        latencyMs: result.ok ? result.latencyMs : null,
        statusCode: result.statusCode ?? null,
        error: result.ok ? null : result.error ?? "Connection failed",
      });
      await this.repo.setHealth(id, {
        scope: "proxy",
        status: result.ok ? "healthy" : "error",
        statusCode: result.statusCode ?? null,
        failureKind: result.ok ? null : "manual_test",
        sanitizedMessage: result.ok ? null : (result.error ?? "Connection failed").slice(0, 500),
        occurredAt: testedAt,
        retryAt: null,
      });
    } catch {
      // Health is observability; a persistence failure must not hide the probe result.
    }
    return result;
  }

  async testAdHoc(input: unknown): Promise<ProxyTestResult> {
    if (typeof input !== "object" || input === null) return { ok: false, latencyMs: 0, error: "invalid proxy test request" };
    const value = input as Record<string, unknown>;
    const protocol = proxyProtocol(value.protocol);
    const host = stringOrUndefined(value.host);
    const port = numberOrUndefined(value.port);
    if (protocol === null || host === undefined || host.length === 0 || port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, latencyMs: 0, error: "valid protocol, host, and port are required" };
    return probeProxy({ protocol, host, port, username: nullableString(value.username), password: nullableString(value.password), isRelay: isProxyRelayHost(host) });
  }

  async getSettings(): Promise<ProxySettingsView> {
    return this.settings.get();
  }

  async patchSettings(patch: unknown): Promise<ProxySettingsView> {
    if (typeof patch !== "object" || patch === null) return this.settings.get();
    const value = patch as Record<string, unknown>;
    return this.settings.patch({
      enabled: booleanOrUndefined(value.enabled),
      excludedProviders: stringListOrUndefined(value.excludedProviders),
      smartDynamicRouting: booleanOrUndefined(value.smartDynamicRouting),
      stickyProxyCount: numberOrUndefined(value.stickyProxyCount),
      routingPreset: value.routingPreset === "target-user" || value.routingPreset === "target-concurrent" || value.routingPreset === "auto" ? value.routingPreset : undefined,
      targetConcurrent: numberOrUndefined(value.targetConcurrent),
    });
  }
}

/** Proxy row plus failed/replacement route switch metadata. */
export interface ProxyView extends ProxyRowView, RouteTransitionView {}


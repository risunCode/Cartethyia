import type { ProxyConfig, ProxyPoolConfigStore } from "../../src/traffic/network";
import type { ProxyHealthRecord, ProxyHealthStore } from "../../src/traffic/network";
import { envBoolean, envNumber, proxyEnvSuffix, proxyIdFromSuffix } from "../../src/traffic/network";

const PROXY_PREFIX = "CARTETHYIA_PROXY_";
const URL_SUFFIX = "_URL";
const DEFAULT_MAX_CONCURRENCY = 8;

/**
 * Environment-backed `ProxyPoolConfigStore` for tests — reads proxy pool
 * configuration from a provided env record (defaults to `process.env`).
 */
export class EnvProxyPoolConfigStore implements ProxyPoolConfigStore {
  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  private poolEnabled(): boolean {
    return envBoolean(this.env.CARTETHYIA_PROXY_POOL_ENABLED, true);
  }

  private readProxy(id: string): ProxyConfig | undefined {
    const suffix = proxyEnvSuffix(id);
    const url = this.env[`${PROXY_PREFIX}${suffix}${URL_SUFFIX}`];
    if (url === undefined || url.length === 0) return undefined;
    const excludedProviderIds = (this.env[`${PROXY_PREFIX}${suffix}_EXCLUDED_PROVIDERS`] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const maxConcurrency = envNumber(this.env[`${PROXY_PREFIX}${suffix}_MAX_CONCURRENCY`], DEFAULT_MAX_CONCURRENCY);
    return {
      id,
      url,
      enabled: envBoolean(this.env[`${PROXY_PREFIX}${suffix}_ENABLED`], true),
      maxConcurrency: Number.isInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : DEFAULT_MAX_CONCURRENCY,
      priority: envNumber(this.env[`${PROXY_PREFIX}${suffix}_PRIORITY`], 0),
      weight: Math.max(1, Math.min(1_000, Math.round(envNumber(this.env[`${PROXY_PREFIX}${suffix}_WEIGHT`], 100)))),
      excludedProviderIds,
    };
  }

  async getProxy(id: string): Promise<ProxyConfig | undefined> {
    return this.poolEnabled() ? this.readProxy(id) : undefined;
  }

  async listProxies(): Promise<readonly ProxyConfig[]> {
    if (!this.poolEnabled()) return [];
    const proxies: ProxyConfig[] = [];
    for (const key of Object.keys(this.env)) {
      const match = /^CARTETHYIA_PROXY_(.+)_URL$/.exec(key);
      if (match === null) continue;
      const suffix = match[1];
      if (suffix === undefined) continue;
      const proxy = this.readProxy(proxyIdFromSuffix(suffix));
      if (proxy !== undefined) proxies.push(proxy);
    }
    return proxies.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }
}

/** In-memory `ProxyHealthStore` for tests — simple map-backed get/set/list. */
export class MemoryProxyHealthStore implements ProxyHealthStore {
  private readonly records = new Map<string, ProxyHealthRecord>();

  async get(proxyId: string): Promise<ProxyHealthRecord | undefined> {
    return this.records.get(proxyId);
  }

  async set(record: ProxyHealthRecord): Promise<void> {
    this.records.set(record.proxyId, record);
  }

  async list(): Promise<readonly ProxyHealthRecord[]> {
    return [...this.records.values()];
  }
}

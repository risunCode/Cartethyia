import { accountCredentialKindOf } from "../../../routing/providerMeta";
import type { AddedProviderId } from "../../../routing/types";
import type { BackupPayload } from "../export";

interface SourceRecord {
  [key: string]: unknown;
}

export interface CompatibilityReport {
  source: "9router";
  imported: {
    accounts: number;
    proxies: number;
    apiKeys: number;
    aliases: number;
    combos: number;
  };
  skipped: {
    unsupportedProviders: Array<{ provider: string; count: number; names: string[] }>;
    invalidConnections: Array<{ provider: string; name: string; reason: string }>;
    invalidProxies: Array<{ name: string; reason: string }>;
    unsupportedNodes: Array<{ id: string; name: string; reason: string }>;
    droppedFields: Array<{ field: string; count: number }>;
  };
  warnings: string[];
}

export interface CompatibilityConversion {
  backup: BackupPayload;
  report: CompatibilityReport;
}

const PROVIDER_MAP: Record<string, AddedProviderId> = {
  openai: "openai",
  anthropic: "anthropic",
  codex: "openai-codex",
  claude: "anthropic-oauth",
  grok: "grok-cli",
  xai: "grok-cli",
  "grok-build": "grok-cli",
  "grok-cli": "grok-cli",
  antigravity: "google-antigravity",
  "google-antigravity": "google-antigravity",
  cline: "cline",
  commandcode: "commandcode",
  blackbox: "blackbox",
  kimchi: "kimchi",
  qoder: "qoder",
  cursor: "cursor",
  deepseek: "deepseek",
  mistral: "mistral",
  cerebras: "cerebras",
  openrouter: "openrouter",
  ollama: "ollama",
  "ollama-local": "ollama",
  opencode: "opencode-free",
  "opencode-go": "opencode-go",
  "xiaomi-mimo": "pgxiaomi",
  "xiaomi-tokenplan": "tpxiaomi",
  siliconflow: "siliconflow",
};

const RELAY_TYPES = new Set(["vercel", "cloudflare", "deno"]);
const OAUTH_PROVIDERS = new Set<AddedProviderId>(["openai-codex", "anthropic-oauth", "cline", "grok-cli", "google-antigravity"]);

function record(value: unknown): SourceRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as SourceRecord : null;
}

function records(value: unknown): SourceRecord[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const item = record(entry);
    return item ? [item] : [];
  }) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tokenValue(value: unknown): string | null {
  const token = stringValue(value);
  if (!token || /^\s*<(?:!doctype\s+)?html\b/i.test(token)) return null;
  return token;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isoDate(value: unknown, fallback: string): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function epochMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function addCount(report: CompatibilityReport, field: string, count = 1): void {
  const entry = report.skipped.droppedFields.find((item) => item.field === field);
  if (entry) entry.count += count;
  else report.skipped.droppedFields.push({ field, count });
}

function noteUnsupportedProvider(report: CompatibilityReport, provider: string, name: string): void {
  const entry = report.skipped.unsupportedProviders.find((item) => item.provider === provider);
  if (entry) {
    entry.count += 1;
    if (entry.names.length < 10) entry.names.push(name);
    return;
  }
  report.skipped.unsupportedProviders.push({ provider, count: 1, names: [name] });
}

function modelReference(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 1) return trimmed;
  const provider = PROVIDER_MAP[trimmed.slice(0, slash)];
  return provider ? `${provider}/${trimmed.slice(slash + 1)}` : null;
}

function buildOAuthCredential(source: SourceRecord, provider: AddedProviderId, now: string): string | null {
  const accessToken = tokenValue(source.accessToken) ?? tokenValue(source.access);
  const refreshToken = tokenValue(source.refreshToken) ?? tokenValue(source.refresh);
  const accessExpiresAt = epochMilliseconds(source.expiresAt ?? source.expires);
  if (!accessToken || !refreshToken || accessExpiresAt === null) return null;

  const providerSpecificData = record(source.providerSpecificData);
  const accountId = stringValue(source.accountId) ?? stringValue(providerSpecificData?.chatgptAccountId);
  const planType = stringValue(source.planType) ?? stringValue(providerSpecificData?.chatgptPlanType);
  const email = stringValue(source.email);
  const bundle: Record<string, unknown> = {
    version: 1,
    provider,
    refreshToken,
    accessToken,
    accessExpiresAt,
    authorizedAt: epochMilliseconds(source.createdAt) ?? Date.parse(now),
    updatedAt: Date.parse(now),
  };
  if (accountId) bundle.accountId = accountId;
  if (planType) bundle.planType = planType;
  const projectId = stringValue(source.projectId) ?? stringValue(providerSpecificData?.projectId);
  const userId = stringValue(source.userId) ?? stringValue(providerSpecificData?.userId);
  if (projectId) bundle.projectId = projectId;
  if (userId) bundle.userId = userId;
  if (email) bundle.email = email;
  return JSON.stringify(bundle);
}

function accountRows(payload: SourceRecord, report: CompatibilityReport, now: string): SourceRecord[] {
  const rows: SourceRecord[] = [];
  const usedNames = new Set<string>();
  const connections = records(payload.providerConnections);
  for (const [index, source] of connections.entries()) {
    const sourceProvider = stringValue(source.provider) ?? "unknown";
    const provider = PROVIDER_MAP[sourceProvider];
    const sourceName = stringValue(source.name) ?? stringValue(source.email) ?? `${sourceProvider}-${index + 1}`;
    if (!provider) {
      noteUnsupportedProvider(report, sourceProvider, sourceName);
      continue;
    }

    let name = sourceName;
    let suffix = 2;
    while (usedNames.has(`${provider}:${name}`)) name = `${sourceName} (${suffix++})`;
    usedNames.add(`${provider}:${name}`);

    if (!OAUTH_PROVIDERS.has(provider) && record(source.providerSpecificData)) addCount(report, "providerConnections.providerSpecificData");
      const credential = OAUTH_PROVIDERS.has(provider)
      ? buildOAuthCredential(source, provider, now)
      : tokenValue(source.apiKey) ?? tokenValue(source.accessToken) ?? tokenValue(source.credential);
    if (!credential) {
      report.skipped.invalidConnections.push({ provider: sourceProvider, name, reason: OAUTH_PROVIDERS.has(provider) ? "missing or invalid access token, refresh token, or expiry" : "missing or invalid apiKey/accessToken credential" });
      continue;
    }

    const credentialKind = accountCredentialKindOf(provider);
    rows.push({
      id: crypto.randomUUID(),
      provider,
      name,
      credential_kind: credentialKind,
      credential,
      credential_hint: `…${credential.slice(-4)}`,
      priority: numberValue(source.priority) ?? (index + 1) * 10,
      active: booleanValue(source.isActive, true),
      cooldown_until: null,
      cooldown_level: 0,
      created_at: isoDate(source.createdAt, now),
      updated_at: isoDate(source.updatedAt, now),
    });
  }
  return rows;
}

function proxyRows(payload: SourceRecord, report: CompatibilityReport, now: string): SourceRecord[] {
  const rows: SourceRecord[] = [];
  for (const [index, source] of records(payload.proxyPools).entries()) {
    const name = stringValue(source.name) ?? `9router proxy ${index + 1}`;
    const rawUrl = stringValue(source.proxyUrl);
    if (!rawUrl) {
      report.skipped.invalidProxies.push({ name, reason: "missing proxyUrl" });
      continue;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      report.skipped.invalidProxies.push({ name, reason: "invalid proxy URL" });
      continue;
    }
    const protocol = url.protocol.slice(0, -1);
    if (protocol !== "http" && protocol !== "https" && protocol !== "socks5") {
      report.skipped.invalidProxies.push({ name, reason: "unsupported proxy protocol" });
      continue;
    }
    if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
      report.skipped.invalidProxies.push({ name, reason: "proxy URL path, query, or fragment is unsupported" });
      continue;
    }
    const sourceType = stringValue(source.type) ?? "http";
    let username: string | null = null;
    let password: string | null = null;
    try {
      username = url.username ? decodeURIComponent(url.username) : null;
      password = url.password ? decodeURIComponent(url.password) : null;
    } catch {
      report.skipped.invalidProxies.push({ name, reason: "invalid URL credentials" });
      continue;
    }
    if (source.noProxy) addCount(report, "proxyPools.noProxy");
    if (source.strictProxy === true) addCount(report, "proxyPools.strictProxy");
    rows.push({
      id: crypto.randomUUID(),
      name,
      protocol,
      is_relay: RELAY_TYPES.has(sourceType) ? 1 : 0,
      host: url.hostname,
      port: Number(url.port) || (protocol === "https" ? 443 : protocol === "socks5" ? 1080 : 80),
      username,
      password,
      priority: numberValue(source.priority) ?? (index + 1) * 10,
      active: booleanValue(source.isActive, true),
      cooldown_until: null,
      cooldown_level: 0,
      created_at: isoDate(source.createdAt, now),
      updated_at: isoDate(source.updatedAt, now),
    });
  }
  return rows;
}

function apiKeyRows(payload: SourceRecord, report: CompatibilityReport, now: string): SourceRecord[] {
  const usedNames = new Set<string>();
  return records(payload.apiKeys).flatMap((source, index) => {
    const key = stringValue(source.key) ?? stringValue(source.apiKey);
    const sourceName = stringValue(source.name) ?? `9router key ${index + 1}`;
    if (!key) {
      addCount(report, "apiKeys.missingKey");
      return [];
    }
    let name = sourceName;
    let suffix = 2;
    while (usedNames.has(name)) name = `${sourceName} (${suffix++})`;
    usedNames.add(name);
    return [{
      id: crypto.randomUUID(),
      name,
      key,
      key_prefix: key.slice(0, 8),
      active: booleanValue(source.isActive, true),
      rate_limit_rpm: null,
      daily_token_limit: null,
      monthly_token_limit: null,
      one_time_token_limit: null,
      one_time_tokens_used: 0,
      quote_big_text: null,
      quote_sub_text: null,
      quote_body: null,
      max_concurrent_requests: null,
      provider_allowlist: null,
      model_allowlist: null,
      model_denylist: null,
      last_used_at: null,
      created_at: isoDate(source.createdAt, now),
      revoked_at: null,
    }];
  });
}

function aliasRows(payload: SourceRecord, report: CompatibilityReport, now: string): SourceRecord[] {
  const aliases = record(payload.modelAliases);
  if (!aliases) return [];
  return Object.entries(aliases).flatMap(([alias, model]) => {
    const normalizedAlias = stringValue(alias);
    const mapped = modelReference(model);
    if (!normalizedAlias) {
      addCount(report, "modelAliases.invalidAlias");
      return [];
    }
    if (!mapped) {
      addCount(report, "modelAliases.unsupportedProvider");
      return [];
    }
    return [{ alias: normalizedAlias, model: mapped, created_at: now }];
  });
}

function comboRows(payload: SourceRecord, report: CompatibilityReport, now: string): SourceRecord[] {
  const usedNames = new Set<string>();
  return records(payload.combos).flatMap((source, index) => {
    const models = Array.isArray(source.models) ? source.models.flatMap((model) => {
      const mapped = modelReference(model);
      if (!mapped) {
        addCount(report, "combos.unsupportedModel");
        return [];
      }
      return [mapped];
    }) : [];
    const sourceName = stringValue(source.name) ?? `9router combo ${index + 1}`;
    let name = sourceName;
    let suffix = 2;
    while (usedNames.has(name)) name = `${sourceName} (${suffix++})`;
    usedNames.add(name);
    return [{
      id: crypto.randomUUID(),
      name,
      models_json: JSON.stringify(models),
      strategy: stringValue(source.kind) ?? "fallback",
      sticky_limit: numberValue(source.stickyLimit) ?? 0,
      created_at: isoDate(source.createdAt, now),
      updated_at: isoDate(source.updatedAt, now),
    }];
  });
}

function reportFor(): CompatibilityReport {
  return {
    source: "9router",
    imported: { accounts: 0, proxies: 0, apiKeys: 0, aliases: 0, combos: 0 },
    skipped: { unsupportedProviders: [], invalidConnections: [], invalidProxies: [], unsupportedNodes: [], droppedFields: [] },
    warnings: [],
  };
}

/** Converts a 9router database export into a native Cartethyia backup payload. */
export function convert9RouterBackup(payload: unknown): CompatibilityConversion {
  const source = record(payload);
  if (!source) throw new Error("9router backup must be a JSON object");
  if (!Array.isArray(source.providerConnections) || !Array.isArray(source.proxyPools)) {
    throw new Error("This file is not a 9router backup: providerConnections and proxyPools are required");
  }

  const report = reportFor();
  const now = new Date().toISOString();
  const accounts = accountRows(source, report, now);
  const proxies = proxyRows(source, report, now);
  const apiKeys = apiKeyRows(source, report, now);
  const aliases = aliasRows(source, report, now);
  const combos = comboRows(source, report, now);
  const nodes = records(source.providerNodes);
  for (const node of nodes) {
    report.skipped.unsupportedNodes.push({
      id: stringValue(node.id) ?? "unknown",
      name: stringValue(node.name) ?? "unnamed node",
      reason: "provider nodes require explicit custom-provider credential mapping",
    });
  }
  if (nodes.length > 0) report.warnings.push("Provider nodes were not imported; native provider accounts and proxy pools were imported.");

  report.imported.accounts = accounts.length;
  report.imported.proxies = proxies.length;
  report.imported.apiKeys = apiKeys.length;
  report.imported.aliases = aliases.length;
  report.imported.combos = combos.length;

  const sourceSettings = record(source.settings);
  const legacyProxyUrl = stringValue(sourceSettings?.outboundProxyUrl);
  if (legacyProxyUrl) report.warnings.push("9router outboundProxyUrl is not imported; proxyPools are imported instead.");

  return {
    report,
    backup: {
      app: "cartethyia",
      version: 1,
      exportedAt: now,
      tables: {
        provider_accounts: accounts,
        proxies,
        api_keys: apiKeys,
        model_aliases: aliases,
        combos,
        proxy_settings: {
          id: 1,
          enabled: proxies.some((proxy) => proxy.active === true || proxy.active === 1),
          excluded_providers_json: "[]",
          smart_dynamic_routing: false,
          smart_dynamic_proxy_count: 2,
          updated_at: now,
        },
      },
    },
  };
}

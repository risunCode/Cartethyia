import type { BackupPayload } from "../../storage/main/backup";

export interface NineRouterImportReport {
  imported: { accounts: number; proxies: number; apiKeys: number; aliases: number; combos: number };
  skipped: string[];
  warnings: string[];
}

export interface NineRouterConversion { backup: BackupPayload; report: NineRouterImportReport }

type Row = Record<string, unknown>;
const PROVIDER_MAP: Record<string, string> = {
  openai: "openai", anthropic: "anthropic", codex: "codex", claude: "claude", cline: "cline", clinepass: "clinepass", kimchi: "kimchi",
  antigravity: "google-antigravity", "google-antigravity": "google-antigravity", opencode: "opencodeft", "opencode-free": "opencodeft", "opencode-go": "opencodego",
};
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((entry): entry is Row => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : []; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function model(value: unknown): string | null {
  const source = text(value); if (!source) return null;
  const slash = source.indexOf("/"); if (slash < 1) return source;
  const provider = PROVIDER_MAP[source.slice(0, slash)]; return provider ? `${provider}/${source.slice(slash + 1)}` : null;
}
function nowDate(value: unknown, fallback: string): string { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback; }

export function convert9RouterBackup(input: unknown): NineRouterConversion {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("9router backup must be an object");
  const source = input as Row; const now = new Date().toISOString(); const skipped: string[] = []; const warnings: string[] = [];
  const accounts = rows(source.providerConnections).flatMap((entry, index) => {
    const provider = PROVIDER_MAP[text(entry.provider) ?? ""]; const credential = text(entry.apiKey) ?? text(entry.accessToken) ?? text(entry.credential);
    if (!provider || !credential) { skipped.push(`provider connection ${text(entry.name) ?? index + 1}`); return []; }
    return [{ id: crypto.randomUUID(), provider, name: text(entry.name) ?? `${provider}-${index + 1}`, credential_kind: provider === "claude" || provider === "codex" || provider === "cline" || provider === "clinepass" ? "oauth" : "api_key", credential, credential_hint: `…${credential.slice(-4)}`, priority: index * 10, active: entry.isActive !== false, cooldown_until: null, cooldown_level: 0, consecutive_use_count: 0, last_used_at: null, created_at: nowDate(entry.createdAt, now), updated_at: now }];
  });
  const proxies = rows(source.proxyPools).flatMap((entry, index) => {
    const raw = text(entry.proxyUrl); if (!raw) { skipped.push(`proxy ${text(entry.name) ?? index + 1}`); return []; }
    try { const url = new URL(raw); if (!["http:", "https:", "socks5:"].includes(url.protocol) || url.pathname !== "/" && url.pathname !== "") throw new Error(); return [{ id: crypto.randomUUID(), name: text(entry.name) ?? `9router proxy ${index + 1}`, protocol: url.protocol.slice(0, -1), is_relay: 0, host: url.hostname, port: Number(url.port) || 80, username: url.username || null, password: url.password || null, priority: index * 10, active: entry.isActive !== false, cooldown_until: null, cooldown_level: 0, max_concurrency: null, consecutive_use_count: 0, last_used_at: null, created_at: now, updated_at: now }]; } catch { skipped.push(`invalid proxy ${text(entry.name) ?? index + 1}`); return []; }
  });
  const apiKeys = rows(source.apiKeys).flatMap((entry, index) => { const key = text(entry.key) ?? text(entry.apiKey); if (!key) return []; return [{ id: crypto.randomUUID(), name: text(entry.name) ?? `9router key ${index + 1}`, key, key_prefix: key.slice(0, 8), active: entry.isActive !== false, rate_limit_rpm: null, daily_token_limit: null, monthly_token_limit: null, one_time_token_limit: null, one_time_tokens_used: 0, quote_big_text: null, quote_sub_text: null, quote_body: null, max_concurrent_requests: null, provider_allowlist: null, model_allowlist: null, model_denylist: null, last_used_at: null, created_at: now, revoked_at: null }]; });
  const aliases = Object.entries(typeof source.modelAliases === "object" && source.modelAliases !== null ? source.modelAliases as Row : {}).flatMap(([alias, target]) => { const mapped = model(target); return mapped ? [{ alias, model: mapped, created_at: now }] : []; });
  const combos = rows(source.combos).flatMap((entry, index) => { const models = Array.isArray(entry.models) ? entry.models.flatMap(model) : []; if (models.length < 2) return []; return [{ id: crypto.randomUUID(), name: text(entry.name) ?? `9router combo ${index + 1}`, models_json: JSON.stringify(models), strategy: text(entry.kind) === "round-robin" ? "round-robin" : "fallback", sticky_limit: 0, created_at: now, updated_at: now }]; });
  if (rows(source.providerNodes).length > 0) warnings.push("Provider nodes were skipped; import their credentials as native accounts.");
  return { report: { imported: { accounts: accounts.length, proxies: proxies.length, apiKeys: apiKeys.length, aliases: aliases.length, combos: combos.length }, skipped, warnings }, backup: { app: "cartethyia", version: 1, exportedAt: now, tables: { provider_accounts: accounts, proxies, api_keys: apiKeys, model_aliases: aliases, combos, proxy_settings: { id: 1, enabled: proxies.length > 0, excluded_providers_json: "[]", smart_dynamic_routing: false, smart_dynamic_proxy_count: 2, updated_at: now } } } };
}

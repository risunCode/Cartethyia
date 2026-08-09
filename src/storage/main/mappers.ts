import type { CredentialKind } from "../../application/contracts";
import type {
  AccessRuleRecord,
  AliasRecord,
  ApiKeyPublic,
  CliMappingSettingsRecord,
  CliModelMappingRecord,
  ComboRecord,
  CustomProviderRecord,
  ProviderAccountRecord,
  ProviderModelRecord,
  ProxyRecord,
  ProxySettingsRecord,
  SettingsRecord,
} from "./records";
export interface SettingsRow { password_hash: string | null;
password_version: number;
jwt_secret: string | null;
settings_json: string;
initialized_at: string;
updated_at: string; }

export interface ApiKeyRow { id: string;
name: string;
key: string;
key_prefix: string;
active: number;
rate_limit_rpm: number | null;
daily_token_limit: number | null;
monthly_token_limit: number | null;
one_time_token_limit: number | null;
one_time_tokens_used: number;
quote_big_text: string | null;
quote_sub_text: string | null;
quote_body: string | null;
max_concurrent_requests: number | null;
provider_allowlist: string | null;
model_allowlist: string | null;
model_denylist: string | null;
last_used_at: string | null;
created_at: string;
revoked_at: string | null; }

export interface ProviderAccountRow { id: string;
provider: string;
name: string;
credential_kind: string;
credential: string;
credential_hint: string;
priority: number;
active: number;
cooldown_until: string | null;
cooldown_level: number;
consecutive_use_count: number;
last_used_at: string | null;
created_at: string;
updated_at: string; }

export interface ProxyRow { id: string;
name: string;
protocol: string;
is_relay: number;
host: string;
port: number;
username: string | null;
password: string | null;
max_concurrency: number;
priority: number;
weight: number;
active: number;
cooldown_until: string | null;
cooldown_level: number;
consecutive_use_count: number;
last_used_at: string | null;
last_test_at: string | null;
last_test_success_at: string | null;
last_test_success_latency_ms: number | null;
last_test_error_at: string | null;
last_test_error: string | null;
last_test_status_code: number | null;
created_at: string;
updated_at: string; }

export interface ProxySettingsRow { enabled: number;
excluded_providers_json: string;
smart_dynamic_routing: number;
smart_dynamic_proxy_count: number;
routing_preset: string;
target_concurrent: number;
updated_at: string; }

export interface ProviderModelRow { provider: string;
model_id: string;
enabled: number;
source: string;
created_at: string;
updated_at: string; }

export interface AliasRow { alias: string;
model: string;
created_at: string; }

export interface CliModelMappingRow { tool_id: string;
slot_key: string;
source_model: string;
target_model: string;
enabled: number;
created_at: string;
updated_at: string; }

export interface CliMappingSettingsRow { tool_id: string;
enabled: number;
updated_at: string; }

export interface ComboRow { id: string;
name: string;
models_json: string;
strategy: string;
sticky_limit: number;
created_at: string;
updated_at: string; }

export interface CustomProviderRow { id: string;
slug: string;
name: string;
type: string;
base_url: string;
credential: string;
timeout_seconds: number;
models_json: string;
headers_json: string;
created_at: string;
updated_at: string; }

export interface AccessRuleRow { scope: string;
mode: string;
entries_json: string;
updated_at: string; }

export interface ShareLinkRow { id: string;
api_key_id: string;
token_hash: string;
kind: "monitor" | "setup";
active: number;
created_at: string;
expires_at: string | null;
used_at: string | null;
last_viewed_at: string | null; }

export interface AccountHealthRow { status: string | null;
error_kind: string | null;
status_code: number | null;
sanitized_message: string | null;
occurred_at: string | null;
retry_at: string | null;
updated_at: string | null; }

// ────────────────────────────── Mappers ─────────────────────────────────────

const LEGACY_CREDENTIAL_KINDS: Readonly<Record<string, CredentialKind>> = {
  bearer: "api_key",
  pat: "api_key",
  "session-token": "api_key",
  oauth: "oauth",
  api_key: "api_key",
  manual: "manual",
};

export function credentialKindOf(value: string | null | undefined): CredentialKind { const mapped = value === null || value === undefined ? undefined : LEGACY_CREDENTIAL_KINDS[value];
return mapped ?? "manual"; }

export function toApiKeyPublic(row: ApiKeyRow): ApiKeyPublic { return {
  id: row.id,
  name: row.name,
  keyPrefix: row.key_prefix,
  active: row.active === 1,
  rateLimitRpm: row.rate_limit_rpm,
  dailyTokenLimit: row.daily_token_limit,
  monthlyTokenLimit: row.monthly_token_limit,
  oneTimeTokenLimit: row.one_time_token_limit,
  oneTimeTokensUsed: row.one_time_tokens_used,
  quoteBigText: row.quote_big_text,
  quoteSubText: row.quote_sub_text,
  quoteBody: row.quote_body,
  maxConcurrentRequests: row.max_concurrent_requests,
  providerAllowlist: row.provider_allowlist,
  modelAllowlist: row.model_allowlist,
  modelDenylist: row.model_denylist,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
}; }

export function toProviderAccount(row: ProviderAccountRow): ProviderAccountRecord { return {
  id: row.id,
  provider: row.provider,
  name: row.name,
  credentialKind: credentialKindOf(row.credential_kind),
  credentialHint: row.credential_hint,
  priority: row.priority,
  active: row.active === 1,
  cooldownUntil: row.cooldown_until,
  cooldownLevel: row.cooldown_level,
  consecutiveUseCount: row.consecutive_use_count ?? 0,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}; }

export function toProxy(row: ProxyRow): ProxyRecord { return {
  id: row.id,
  name: row.name,
  protocol: row.protocol === "https" || row.protocol === "socks5" ? row.protocol : "http",
  isRelay: row.is_relay === 1,
  host: row.host,
  port: row.port,
  username: row.username,
  password: row.password,
  maxConcurrency: Math.max(1, Math.min(10_000, Math.round(row.max_concurrency || 8))),
  priority: row.priority,
  weight: Math.max(1, Math.min(1_000, Math.round(row.weight || 100))),
  active: row.active === 1,
  cooldownUntil: row.cooldown_until,
  cooldownLevel: row.cooldown_level,
  consecutiveUseCount: row.consecutive_use_count ?? 0,
  lastUsedAt: row.last_used_at,
  lastTestAt: row.last_test_at,
  lastTestSuccessAt: row.last_test_success_at,
  lastTestSuccessLatencyMs: row.last_test_success_latency_ms,
  lastTestErrorAt: row.last_test_error_at,
  lastTestError: row.last_test_error,
  lastTestStatusCode: row.last_test_status_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}; }

export function toSettings(row: SettingsRow): SettingsRecord { let settingsJson: Record<string, unknown> = {};
try {
  const parsed: unknown = JSON.parse(row.settings_json);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settingsJson = parsed as Record<string, unknown>;
} catch {
  // malformed legacy JSON — treat as empty, never crash
}
return {
  passwordHash: row.password_hash,
  passwordVersion: row.password_version,
  jwtSecret: row.jwt_secret,
  settingsJson,
  initializedAt: row.initialized_at,
  updatedAt: row.updated_at,
}; }


/**
 * Console application services — the authenticated control plane.
 *
 * Every operation that changes providers, accounts, proxies, keys, models,
 * quotas, or routing goes through an application service that talks to
 * injected repository ports — never to SQLite or provider internals
 * directly. The application contracts in `src/domain/contracts.ts` are the
 * only cross-layer shapes used here.
 *
 * Security invariants:
 * - Mutations require an authenticated session, a JSON content type, and a
 *   same-origin request; session cookies are HttpOnly + SameSite with a
 *   Secure attribute when served over HTTPS (see {@link guardConsoleRequest}
 *   and the cookie helpers in `./session.ts`).
 * - List/detail payloads never include secrets; only bounded credential
 *   hints and sanitized messages. Secrets are returned solely by the
 *   explicit credential endpoints.
 * - Route switch metadata always keeps the failed route and the replacement
 *   route as separate values.
 *
 * Re-exports view/repository contracts from `./views.ts`, session security
 * from `./session.ts`, route transition store from `./route-transitions.ts`,
 * and input sanitizers from `./input-sanitizers.ts` so existing consumers
 * importing from `"./services"` continue to work unchanged.
 */

// ---------------------------------------------------------------------------
// Re-exports for consumer compatibility (callers import from "./services")
// ---------------------------------------------------------------------------

export type { RoutingPreset, UsageDimension, UsagePeriod } from "../domain/contracts";
export * from "./views";
export * from "./session";
export { MemoryRouteTransitionStore } from "./route-transitions";
export * from "./input-sanitizers";

// ---------------------------------------------------------------------------
// Imports for the service classes below
// ---------------------------------------------------------------------------

import type { ApplicationErrorKind, CredentialKind, ModelMetadata } from "../domain/contracts";
import { sanitizeMessage } from "../domain/contracts";
import type { ModelMetadataResolver } from "../domain/model-metadata";
import type { ProviderRegistry } from "../providers/registry";
import { validateRestorePayload } from "../storage";
import type { BackupPayload } from "../storage";
import { buildProxyFetcher } from "../traffic";
import { OAUTH_SAFETY_SKEW_MS } from "../auth";
import type { OAuthRefresher, OAuthTokenRecord, OAuthTokenStore } from "../auth";
import type { TokenSet } from "../auth";
import type { QuotaSnapshotState, QuotaStateStore } from "../auth/credentials";
import { createAuthDriverRegistry, type AuthDriverRegistry } from "../auth";
import { fetchProviderQuota } from "./quota-fetcher";
import { createDriverAwareOAuthRefresher } from "../auth";
import { OAuthLoginSessionManager, OAuthSessionError, type OAuthLoginSessionView } from "../auth";
import { registerOAuthCallback, unregisterOAuthCallback } from "../auth/oauth-callback-server";
import { assertPublicUrlAtDispatch } from "../security/ssrf-guard";

// Re-import symbols used by service classes from the extracted modules.
import type {
  AccountListOptions,
  AccountListResult,
  AccountQuotaView,
  AccountRepository,
  AccountRowView,
  AliasView,
  ApiKeyRepository,
  ApiKeySecretResult,
  ApiKeyView,
  BackupRepository,
  BackupActionResult,
  ComboView,
  ConsoleErrorCode,
  ConsoleRepositories,
  ConsoleRuntimeSettings,
  CustomProviderRepository,
  CustomProviderView,
  FilterRuleInput,
  FilterRuleRepository,
  FilterRuleView,
  ModelProbeMetadata,
  ModelRepository,
  ModelView,
  ProviderConfigRepository,
  ProviderConfigView,
  ProviderRoutingSettings,
  ProviderSummaryView,
  ProxyRepository,
  ProxyRowView,
  ProxySettingsRepository,
  ProxySettingsView,
  ProxyTestInput,
  ProxyTestResult,
  RouteTransitionStore,
  RouteTransitionView,
  RoutingConfigRepository,
  RuntimeMetadataRepository,
  SettingsRepository,
  SettingsView,
} from "./views";
import { loadRouteTransition } from "./views";
import type { LoginLimiter } from "./session";
import {
  booleanOrUndefined,
  boundedNumber,
  credentialKind,
  customProviderKind,
  defaultProxyPort,
  isProxyRelayHost,
  limitOrUndefined,
  nullableString,
  numberOrUndefined,
  proxyProtocol,
  recordOrUndefined,
  sanitizeKeyUpdate,
  sanitizeProviderRoutingPatch,
  sanitizeRuntimePatch,
  stringListOrUndefined,
  stringOrUndefined,
} from "./input-sanitizers";
import {
  hashConsolePassword,
  MemoryLoginLimiter,
  signSessionToken,
  verifyConsolePassword,
} from "./session";

// ---------------------------------------------------------------------------
// Model discovery for built-in providers
// ---------------------------------------------------------------------------

const MODEL_ENDPOINTS: Record<string, string> = {
  blackboxai: "https://api.blackbox.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  cline: "https://api.cline.bot/api/v1/ai/cline",
  kimchi: "https://llm.kimchi.dev/openai/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "https://ollama.com/v1",
  cerebras: "https://api.cerebras.ai/v1",
  deepseek: "https://api.deepseek.com",
  siliconflow: "https://api.siliconflow.com/v1",
  mistral: "https://api.mistral.ai/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  "xiaomipg": "https://api.xiaomimimo.com/v1",
  "xiaomitp": "https://token-plan-sgp.xiaomimimo.com/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  "codex": "https://chatgpt.com/backend-api",
  "gemini": "https://generativelanguage.googleapis.com/v1beta",
  "agentrouter": "https://agentrouter.org/v1",
  "commandcode": "https://api.commandcode.ai",
  "qoder": "https://api2.qoder.sh",
  "kiro": "https://kiro.dev",
  "antigravity": "https://daily-cloudcode-pa.googleapis.com",
  "codebuddy": "https://www.codebuddy.ai/v2",
  "codebuddy-cn": "https://www.codebuddy.cn/v2",
  "exa": "https://api.exa.ai",
};

function extractModelIds(body: unknown, allowArray = true): string[] {
  if (body === null || typeof body !== "object") return [];
  if (Array.isArray(body)) {
    if (!allowArray) return [];
    return body.flatMap((item) => extractModelIds(item, false));
  }
  const obj = body as Record<string, unknown>;
  if ("data" in obj && Array.isArray(obj.data)) {
    return obj.data.flatMap((item) => extractModelIds(item, false));
  }
  if ("models" in obj && Array.isArray(obj.models)) {
    return obj.models.flatMap((item) => extractModelIds(item, false));
  }
  if ("id" in obj && typeof obj.id === "string") {
    return [obj.id];
  }
  if ("model" in obj && typeof obj.model === "string") {
    return [obj.model];
  }
  return Object.values(obj).flatMap((v) => extractModelIds(v, false));
}

/**
 * OAuth providers (Cline, Kimchi, Codex, Kiro, Google Antigravity, …) store their
 * credential as a JSON bundle (`{"accessToken": "…", "refreshToken": "…", …}`).
 * API-key/manual providers store a plain string. Extract the bearer token the
 * upstream `/models` endpoint expects, mirroring the per-adapter parsing each
 * provider already does at dispatch time (see e.g. kimchi.ts, antigravity.ts).
 */
function extractAccessToken(credential: string): string {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const access = (parsed as Record<string, unknown>).accessToken;
      if (typeof access === "string" && access.length > 0) return access;
    }
  } catch {
    // Treat malformed JSON as a raw credential so the upstream returns a typed auth error.
  }
  return trimmed;
}

async function discoverProviderModels(providerId: string, credential: string | null, kind: CredentialKind): Promise<string[]> {
  const endpoint = MODEL_ENDPOINTS[providerId];
  if (!endpoint) return [];
  if (!credential) return [];
  const token = extractAccessToken(credential);
  const headers: Record<string, string> = {
    "accept": "application/json",
  };
  if (providerId === "anthropic" || providerId === "agentrouter") {
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
  } else if (kind === "oauth") {
    // OAuth gateway providers (Cline, Kimchi, …) wrap the access token in a workos: prefix.
    const bearer = token.startsWith("workos:") ? token : `workos:${token}`;
    headers["authorization"] = `Bearer ${bearer}`;
  } else {
    headers["authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(`${endpoint}/models`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
  const body = await response.json();
  return extractModelIds(body).map((id) => stripProviderPrefix(id, providerId));
}

/**
 * Strips a leading provider prefix from a discovered model ID so the stored
 * catalog ID is the bare model name, not `providerId/modelId`. Some upstreams
 * (e.g. blackbox.ai) echo back fully-qualified IDs like
 * `blackboxai/x-ai/grok-4.3`; without stripping, the prefix is baked into
 * the catalog and routing's prefix resolver double-strips it, producing a
 * model ID (`x-ai/grok-4.3`) that no longer matches the stored entry.
 */
function stripProviderPrefix(modelId: string, providerId: string): string {
  if (!modelId.startsWith(`${providerId}/`)) return modelId;
  const stripped = modelId.slice(providerId.length + 1);
  return stripped.length > 0 ? stripped : modelId;
}

// ---------------------------------------------------------------------------
// Auth service result types
// ---------------------------------------------------------------------------

export interface LoginResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: ConsoleErrorCode | null;
  readonly message: string | null;
  readonly token: string | null;
  readonly expiresInSec: number | null;
  readonly retryAfterSec: number | null;
}

/** Typed result for password-change / logout-all mutations. */
export interface AuthActionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: ConsoleErrorCode | null;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Application services
// ---------------------------------------------------------------------------

export class AuthService {
  // Cache guard inputs keyed by (updatedAt, passwordVersion). Every settings
  // mutation writes a fresh `updated_at`; every password/JWT change bumps
  // `password_version`. Re-reading the full snapshot (SQLite row + JSON parse
  // + bootstrap password/JWT rotation checks) on every authenticated console
  // request is wasteful when nothing changed — the guard runs on every hit.
  private cachedGuard: { readonly key: string; readonly result: { readonly jwtSecret: string; readonly passwordVersion: number; readonly trustProxy: boolean } } | null = null;

  constructor(
    private readonly settings: SettingsRepository,
    private readonly limiter: LoginLimiter = new MemoryLoginLimiter(),
  ) {}

  async login(password: unknown, ip: string, request: Request): Promise<LoginResult> {
    const snapshot = await this.settings.get();
    const check = this.limiter.check(ip);
    if (!check.allowed) {
      return { ok: false, status: 429, code: "rate_limited", message: "too many failed attempts", token: null, expiresInSec: null, retryAfterSec: check.retryAfterSec };
    }
    const ok =
      typeof password === "string" &&
      snapshot.passwordHash !== null &&
      (await verifyConsolePassword(password, snapshot.passwordHash));
    if (!ok) {
      const after = this.limiter.recordFailure(ip);
      if (!after.allowed) {
        return { ok: false, status: 429, code: "rate_limited", message: "too many failed attempts", token: null, expiresInSec: null, retryAfterSec: after.retryAfterSec };
      }
      return { ok: false, status: 401, code: "unauthorized", message: "wrong password", token: null, expiresInSec: null, retryAfterSec: null };
    }
    this.limiter.recordSuccess(ip);
    const ttlSec = snapshot.runtime.sessionTtlHours * 3600;
    const token = await signSessionToken({ secret: snapshot.jwtSecret, pv: snapshot.passwordVersion, ttlSeconds: ttlSec });
    return { ok: true, status: 200, code: null, message: null, token, expiresInSec: ttlSec, retryAfterSec: null };
  }

  async session(): Promise<{ readonly role: "admin"; readonly passwordVersion: number; readonly hasPassword: boolean }> {
    const snapshot = await this.settings.get();
    return { role: "admin", passwordVersion: snapshot.passwordVersion, hasPassword: snapshot.passwordHash !== null };
  }

  /** Guard inputs: never returns the password hash, only what the guard needs. */
  async guardOptions(): Promise<{ readonly jwtSecret: string; readonly passwordVersion: number; readonly trustProxy: boolean }> {
    const snapshot = await this.settings.get();
    const key = `${snapshot.updatedAt}:${snapshot.passwordVersion}`;
    if (this.cachedGuard !== null && this.cachedGuard.key === key) return this.cachedGuard.result;
    const result = { jwtSecret: snapshot.jwtSecret, passwordVersion: snapshot.passwordVersion, trustProxy: snapshot.runtime.trustProxy };
    this.cachedGuard = { key, result };
    return result;
  }

  async changePassword(currentPassword: unknown, newPassword: unknown, confirm: unknown): Promise<AuthActionResult> {
    if (typeof newPassword !== "string" || newPassword.length < 5) {
      return { ok: false, status: 400, code: "invalid_request", message: "new password must be at least 5 characters" };
    }
    if (newPassword !== confirm) {
      return { ok: false, status: 400, code: "invalid_request", message: "password confirmation does not match" };
    }
    const snapshot = await this.settings.get();
    const verified =
      snapshot.passwordHash !== null &&
      typeof currentPassword === "string" &&
      (await verifyConsolePassword(currentPassword, snapshot.passwordHash));
    if (!verified) {
      return { ok: false, status: 401, code: "unauthorized", message: "current password is wrong" };
    }
    await this.settings.setPasswordHash(await hashConsolePassword(newPassword));
    return { ok: true, status: 200, code: null, message: "all sessions invalidated; sign in again" };
  }

  async logoutAll(password: unknown): Promise<AuthActionResult> {
    const snapshot = await this.settings.get();
    const verified =
      snapshot.passwordHash !== null &&
      typeof password === "string" &&
      (await verifyConsolePassword(password, snapshot.passwordHash));
    if (!verified) {
      return { ok: false, status: 401, code: "unauthorized", message: "password is wrong" };
    }
    await this.settings.bumpPasswordVersion();
    return { ok: true, status: 200, code: null, message: "" };
  }
}

export class ApiKeyService {
  constructor(private readonly repo: ApiKeyRepository) {}

  async list(): Promise<readonly ApiKeyView[]> {
    return this.repo.list();
  }

  async create(input: unknown): Promise<ApiKeySecretResult | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "key name is required" };
    }
    const customKey = stringOrUndefined(value.key);
    if (customKey !== undefined && !/^[A-Za-z0-9_-]+$/.test(customKey) && !(customKey.length >= 8 && customKey.length <= 256)) {
      return { ok: false, status: 400, code: "invalid_request", message: "custom API key must be 8-256 letters, digits, underscores, or hyphens" };
    }
    const result = await this.repo.create({
      name: value.name.trim(),
      key: customKey,
      prefix: stringOrUndefined(value.prefix),
      rateLimitRpm: limitOrUndefined(value.rateLimitRpm),
      dailyTokenLimit: limitOrUndefined(value.dailyTokenLimit),
      monthlyTokenLimit: limitOrUndefined(value.monthlyTokenLimit),
      oneTimeTokenLimit: limitOrUndefined(value.oneTimeTokenLimit),
      maxConcurrentRequests: limitOrUndefined(value.maxConcurrentRequests),
      providerAllowlist: stringListOrUndefined(value.providerAllowlist),
      modelAllowlist: stringListOrUndefined(value.modelAllowlist),
      modelDenylist: stringListOrUndefined(value.modelDenylist),
    });
    if ("error" in result) {
      return { ok: false, status: 409, code: "conflict", message: "a key with this name already exists" };
    }
    return result;
  }

  async update(id: string, patch: unknown): Promise<ApiKeyView | null> {
    if (typeof patch !== "object" || patch === null) return null;
    return this.repo.update(id, sanitizeKeyUpdate(patch as Record<string, unknown>));
  }

  async regenerate(id: string): Promise<ApiKeySecretResult | null> {
    return this.repo.regenerate(id);
  }

  async revoke(id: string): Promise<boolean> {
    return this.repo.revoke(id);
  }

  async remove(id: string): Promise<boolean> {
    return this.repo.remove(id);
  }

  async credential(id: string): Promise<{ readonly key: string } | null> {
    return this.repo.credential(id);
  }
}

type CustomProviderMutationError = { readonly ok: false; readonly status: 400 | 409; readonly code: ConsoleErrorCode; readonly message: string };

export class ProviderService {
  private static readonly CUSTOM_PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly providerConfig: ProviderConfigRepository,
    private readonly customProviders: CustomProviderRepository,
    private readonly accounts: AccountRepository,
  ) {}

  /** Legacy slug rules: pattern, built-in/reserved rejection, custom collisions (400/409). */
  private async customSlugError(slug: string, excludeId: string | null): Promise<{ readonly status: 400 | 409; readonly code: ConsoleErrorCode; readonly message: string } | null> {
    if (!ProviderService.CUSTOM_PROVIDER_SLUG_PATTERN.test(slug)) {
      return { status: 400, code: "invalid_request", message: "Custom provider slug must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens (max 63 characters)." };
    }
    const reserved = new Set(this.registry.list().map((adapter) => adapter.metadata.id));
    reserved.add("custom");
    reserved.add("opencodeft");
    if (reserved.has(slug)) {
      return { status: 400, code: "invalid_request", message: `Provider slug "${slug}" is reserved and cannot be used as a custom provider slug.` };
    }
    for (const row of await this.customProviders.list()) {
      if (row.id === excludeId) continue;
      if (row.slug === slug) {
        return { status: 409, code: "conflict", message: `A custom provider with slug "${slug}" already exists.` };
      }
    }
    return null;
  }

  async list(): Promise<readonly ProviderSummaryView[]> {
    const [configRows, customRows] = await Promise.all([this.providerConfig.list(), this.customProviders.list()]);
    const enabledById = new Map(configRows.map((row) => [row.id, row.enabled]));
    const customIds = new Set(customRows.map((row) => row.id).concat(customRows.map((row) => row.slug)));
    return this.registry.list().map((adapter) => ({
      id: adapter.metadata.id,
      name: adapter.metadata.displayName,
      protocol: adapter.metadata.protocol,
      credentialKind: adapter.metadata.credentialKind,
      credentialKinds: adapter.metadata.credentialKinds ?? [adapter.metadata.credentialKind],
      credentialUrl: adapter.metadata.credentialUrl ?? null,
      surfaces: adapter.capabilities.surfaces,
      enabled: enabledById.get(adapter.metadata.id) ?? true,
      custom: customIds.has(adapter.metadata.id),
    }));
  }

  async getConfig(id: string): Promise<ProviderConfigView | null> {
    return this.providerConfig.get(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ProviderConfigView | null> {
    return this.providerConfig.setEnabled(id, enabled);
  }

  async getRouting(id: string): Promise<ProviderRoutingSettings> {
    return this.providerConfig.getRouting(id);
  }

  async setRouting(id: string, patch: unknown): Promise<ProviderRoutingSettings> {
    const value = sanitizeProviderRoutingPatch(patch);
    return this.providerConfig.setRouting(id, value);
  }

  async listCustom(): Promise<readonly CustomProviderView[]> {
    return this.customProviders.list();
  }

  async createCustom(input: unknown): Promise<CustomProviderView | CustomProviderMutationError> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "provider name is required" };
    }
    if (typeof value.slug !== "string" || value.slug.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "provider slug is required" };
    }
    const slug = value.slug.trim();
    const slugError = await this.customSlugError(slug, null);
    if (slugError !== null) {
      return { ok: false, status: slugError.status, code: slugError.code, message: slugError.message };
    }
    if (typeof value.baseUrl !== "string" || value.baseUrl.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "provider base URL is required" };
    }
    const result = await this.customProviders.create({
      name: value.name.trim(),
      kind: customProviderKind(value.kind),
      slug,
      baseUrl: value.baseUrl.trim(),
      credential: stringOrUndefined(value.credential),
      timeoutSeconds: numberOrUndefined(value.timeoutSeconds),
      autoFetchModels: booleanOrUndefined(value.autoFetchModels),
      customHeaders: recordOrUndefined(value.customHeaders),
    });
    if ("error" in result) {
      return { ok: false, status: 409, code: "conflict", message: "a custom provider with this slug already exists" };
    }
    return result;
  }

  async updateCustom(id: string, patch: unknown): Promise<CustomProviderView | CustomProviderMutationError | null> {
    if (typeof patch !== "object" || patch === null) return null;
    const value = patch as Record<string, unknown>;
    const rawSlug = value.slug;
    if (typeof rawSlug === "string" && rawSlug.trim().length > 0) {
      const slugError = await this.customSlugError(rawSlug.trim(), id);
      if (slugError !== null) return { ok: false, ...slugError };
    }
    return this.customProviders.update(id, {
      name: stringOrUndefined(value.name),
      kind: customProviderKind(value.kind),
      slug: stringOrUndefined(value.slug),
      baseUrl: stringOrUndefined(value.baseUrl),
      credential: stringOrUndefined(value.credential),
      timeoutSeconds: numberOrUndefined(value.timeoutSeconds),
      autoFetchModels: booleanOrUndefined(value.autoFetchModels),
      customHeaders: recordOrUndefined(value.customHeaders),
      enabled: booleanOrUndefined(value.enabled),
    });
  }

  async removeCustom(id: string): Promise<boolean> {
    return this.customProviders.remove(id);
  }

  async customCredential(id: string): Promise<{ readonly credential: string } | null> {
    return this.customProviders.credential(id);
  }

  async fetchCustomModels(id: string): Promise<CustomProviderView | { readonly error: string }> {
    const provider = await this.customProviders.get(id);
    if (provider === null) return { error: "custom provider not found" };
    const credential = await this.customProviders.credential(id);
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const modelsUrl = `${baseUrl}/models`;
    await assertPublicUrlAtDispatch(modelsUrl, { label: `Custom provider "${provider.name}" model discovery` });
    const response = await fetch(modelsUrl, {
      headers: {
        accept: "application/json",
        ...(credential?.credential ? provider.kind === "anthropic" ? { "x-api-key": credential.credential, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential.credential}` } : {}),
      },
      signal: AbortSignal.timeout(Math.min(provider.timeoutSeconds * 1000, 30_000)),
    });
    if (!response.ok) return { error: `Model discovery returned HTTP ${response.status}.` };
    const body: unknown = await response.json();
    const rows = typeof body === "object" && body !== null && "data" in body && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : Array.isArray(body) ? body : [];
    const models = rows.flatMap((row) => {
      if (typeof row === "string") return [{ id: row, name: row }];
      if (typeof row !== "object" || row === null) return [];
      const value = row as Record<string, unknown>;
      const modelId = typeof value.id === "string" ? value.id : null;
      return modelId === null ? [] : [{ id: modelId, name: typeof value.name === "string" ? value.name : modelId, context: { inputTokens: typeof value.context_length === "number" ? value.context_length : null, outputTokens: typeof value.max_output_tokens === "number" ? value.max_output_tokens : null }, categories: [], pricing: { inputPerMillion: null, outputPerMillion: null } }];
    });
    return (await this.customProviders.updateModels(id, models)) ?? { error: "custom provider not found" };
  }

  async checkCustomProviderHealth(id: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const provider = await this.customProviders.get(id);
    if (provider === null) return { ok: false, latencyMs: 0, error: "custom provider not found" };
    const credential = await this.customProviders.credential(id);
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const start = performance.now();
    try {
      const response = await fetch(baseUrl, {
        method: "HEAD",
        headers: {
          ...(credential?.credential ? provider.kind === "anthropic" ? { "x-api-key": credential.credential, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential.credential}` } : {}),
        },
        signal: AbortSignal.timeout(Math.min(provider.timeoutSeconds * 1000, 10_000)),
      });
      const latencyMs = Math.max(0, Math.round(performance.now() - start));
      if (response.ok || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 405) {
        return { ok: true, latencyMs };
      }
      return { ok: false, latencyMs, error: `HTTP ${response.status}` };
    } catch (error) {
      const latencyMs = Math.max(0, Math.round(performance.now() - start));
      return { ok: false, latencyMs, error: error instanceof Error ? error.message : "Network error" };
    }
  }

  async addCustomModel(id: string, modelId: string): Promise<CustomProviderView | { readonly error: string }> {
    const provider = await this.customProviders.get(id);
    if (provider === null) return { error: "custom provider not found" };
    const normalized = modelId.trim();
    if (normalized.length === 0 || normalized.length > 200) return { error: "model id must be between 1 and 200 characters" };
    const exists = provider.models.some((model) => {
      if (typeof model === "string") return model === normalized;
      return typeof model === "object" && model !== null && "id" in model && model.id === normalized;
    });
    if (exists) return { error: "model already exists" };
    return (await this.customProviders.updateModels(id, [...provider.models, { id: normalized, name: normalized }])) ?? { error: "custom provider not found" };
  }

  async deleteCustomModel(id: string, modelId: string): Promise<boolean> {
    const provider = await this.customProviders.get(id);
    if (provider === null) return false;
    const models = provider.models.filter((model) => typeof model === "string" ? model !== modelId : !(typeof model === "object" && model !== null && "id" in model && (model as { id?: unknown }).id === modelId));
    await this.customProviders.updateModels(id, models);
    return models.length !== provider.models.length;
  }

  async discoverBuiltinModels(providerId: string): Promise<string[]> {
    const adapter = this.registry.get(providerId);
    if (!adapter) return [];
    const endpoint = MODEL_ENDPOINTS[providerId];
    if (!endpoint) return [];
    // Discover models using active provider account credentials — discoverProviderModels handles per-kind auth headers.
    const credentials = await this.accounts.listActiveCredentials(providerId);
    let lastStatus = 0;
    for (const { credential, credentialKind } of credentials) {
      try {
        const models = await discoverProviderModels(providerId, credential, credentialKind);
        if (models.length > 0) return models;
      } catch (error) {
        // Continue to the next account on auth/HTTP failures — throw only if every account fails.
        if (error instanceof Error && /HTTP \d+/.test(error.message)) {
          const match = error.message.match(/HTTP (\d+)/);
          if (match) lastStatus = Number(match[1]);
          continue;
        }
        throw error;
      }
    }
    if (lastStatus > 0) throw new Error(`Model discovery returned HTTP ${lastStatus} for every active account.`);
    return [];
  }
}

export class ModelService {
  constructor(
    private readonly repo: ModelRepository,
    private readonly registry: ProviderRegistry,
    private readonly modelMetadata?: ModelMetadataResolver,
  ) {}

  private metadataFor(providerId: string, modelId: string): ModelMetadata | undefined {
    return this.modelMetadata?.lookup(providerId, modelId) ?? undefined;
  }

  async list(providerId: string): Promise<readonly ModelView[]> {
    const adapter = this.registry.get(providerId);
    const stored = await this.repo.list(providerId);
    const storedByModel = new Map(stored.map((row) => [row.modelId, row]));
    const catalog = adapter?.models.list ?? [];
    const seen = new Set<string>();
    const merged: ModelView[] = [];
    for (const model of catalog) {
      seen.add(model.id);
      merged.push({ providerId, modelId: model.id, displayName: model.displayName, enabled: storedByModel.get(model.id)?.enabled ?? true, source: "built-in", images: model.capabilities.images, metadata: this.metadataFor(providerId, model.id) });
    }
    for (const row of stored) {
      if (seen.has(row.modelId)) continue;
      merged.push({ ...row, metadata: this.metadataFor(providerId, row.modelId) });
    }
    return merged.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
  }

  async setEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ModelView | null> {
    return this.repo.setEnabled(providerId, modelId, enabled);
  }

  async setAllEnabled(providerId: string, enabled: boolean): Promise<void> {
    return this.repo.setAllEnabled(providerId, enabled);
  }

  async addCustom(providerId: string, modelId: string): Promise<ModelView | null> {
    const normalized = modelId.trim();
    if (normalized.length === 0 || normalized.length > 200) return null;
    if (this.registry.get(providerId) === null) return null;
    if (this.registry.get(providerId)?.models.get(normalized) !== null) return (await this.list(providerId)).find((model) => model.modelId === normalized) ?? null;
    return this.repo.setEnabled(providerId, normalized, true);
  }

  async removeCustom(providerId: string, modelId: string): Promise<boolean> {
    const adapter = this.registry.get(providerId);
    if (adapter === null || adapter.models.get(modelId) !== null) return false;
    return this.repo.delete(providerId, modelId);
  }
}

export class AccountService {
  constructor(
    private readonly repo: AccountRepository,
    private readonly transitions: RouteTransitionStore,
  ) {}

  async list(providerId?: string): Promise<readonly AccountView[]> {
    const rows = await this.repo.list(providerId);
    return Promise.all(rows.map(async (row) => ({ ...row, ...(await loadRouteTransition("account", row.id, row.health, this.transitions)) })));
  }

  async listPaged(providerId: string, options: AccountListOptions): Promise<AccountListResult> {
    const page = await this.repo.listPaged(providerId, options);
    const items = await Promise.all(page.items.map(async (row) => ({ ...row, ...(await loadRouteTransition("account", row.id, row.health, this.transitions)) })));
    return { items, nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<AccountView | null> {
    const row = await this.repo.get(id);
    if (row === null) return null;
    return { ...row, ...(await loadRouteTransition("account", row.id, row.health, this.transitions)) };
  }

  async create(input: unknown): Promise<{ readonly id: string; readonly credentialHint: string } | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.providerId !== "string" || value.providerId.length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "provider is required" };
    }
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "account name is required" };
    }
    if (typeof value.credential !== "string" || value.credential.length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "credential is required" };
    }
    return this.repo.create({
      providerId: value.providerId,
      name: value.name.trim(),
      credentialKind: credentialKind(value.credentialKind),
      credential: value.credential,
      priority: numberOrUndefined(value.priority),
      active: booleanOrUndefined(value.active),
    });
  }

  async update(id: string, patch: unknown): Promise<AccountRowView | null> {
    if (typeof patch !== "object" || patch === null) return null;
    const value = patch as Record<string, unknown>;
    return this.repo.update(id, {
      name: stringOrUndefined(value.name),
      credentialKind: credentialKind(value.credentialKind),
      credential: stringOrUndefined(value.credential),
      priority: numberOrUndefined(value.priority),
      active: booleanOrUndefined(value.active),
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.repo.remove(id);
  }

  async removeBatch(ids: readonly string[]): Promise<number> {
    return this.repo.removeBatch(ids);
  }

  async setActiveBatch(ids: readonly string[], active: boolean): Promise<number> {
    return this.repo.setActiveBatch(ids, active);
  }

  async credential(id: string): Promise<{ readonly credential: string } | null> {
    return this.repo.credential(id);
  }
}

// ---------------------------------------------------------------------------
// OAuth lifecycle
// ---------------------------------------------------------------------------

export type OAuthStartResultView =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly providerId: string;
      readonly name: string;
      readonly authorizationUrl: string;
      readonly instructions: string;
      readonly redirectUri: string | null;
      readonly userCode: string | null;
      readonly verificationUri: string | null;
      readonly intervalSeconds: number | null;
      readonly state: string;
      readonly expiresAtMs: number;
    }
  | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string };

export type OAuthCompleteResultView =
  | { readonly ok: true; readonly accountId: string; readonly providerId: string; readonly status: "completed"; readonly credentialHint: string }
  | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string };

export type OAuthRefreshResultView =
  | { readonly ok: true; readonly expiresAt: string | null }
  | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string };

export interface OAuthAccountStatusView {
  readonly accountId: string;
  readonly providerId: string;
  /** False when the account exists but is not OAuth-linked. */
  readonly linked: boolean;
  readonly hasRefreshToken: boolean;
  readonly accessTokenExpiresAt: string | null;
  /** Access token is missing or within the safety skew of expiry. */
  readonly expired: boolean;
  readonly refreshable: boolean;
  readonly revocable: boolean;
}

function oauthCredentialBundle(providerId: string, token: OAuthTokenRecord, details?: TokenSet): string {
  const now = Date.now();
  const metadata = details as (TokenSet & { readonly region?: string; readonly authMethod?: string; readonly startUrl?: string; readonly clientId?: string; readonly clientSecret?: string; readonly profileArn?: string }) | undefined;
  const bundle: Record<string, unknown> = { version: 1, provider: providerId, refreshToken: token.refreshToken, accessToken: token.accessToken, accessExpiresAt: token.expiresAtMs, authorizedAt: now, updatedAt: now };
  if (details?.providerAccountId) {
    bundle.providerAccountId = details.providerAccountId;
    if (providerId === "antigravity") bundle.projectId = details.providerAccountId;
  }
  if (details?.email) bundle.email = details.email;
  if (details?.orgId) bundle.orgId = details.orgId;
  if (details?.orgName) bundle.orgName = details.orgName;
  for (const key of ["region", "authMethod", "startUrl", "clientId", "clientSecret", "profileArn"] as const) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.length > 0) bundle[key] = value;
  }
  return JSON.stringify(bundle);
}

function oauthSessionErrorView(error: unknown): { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string } {
  if (error instanceof OAuthSessionError) {
    const code: ConsoleErrorCode = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status >= 500 ? "internal_error" : "invalid_request";
    return { ok: false, status: error.status, code, message: error.message };
  }
    return { ok: false, status: 500, code: "internal_error", message: `OAuth operation failed: ${error instanceof Error ? sanitizeMessage(error) : "unknown internal error"}` };
}

function oauthRefreshErrorView(kind: ApplicationErrorKind, statusCode: number | null, message: string): { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string } {
  const code: ConsoleErrorCode = kind === "authentication_failed" ? "unauthorized" : kind === "provider_rate_limited" ? "rate_limited" : kind === "provider_protocol_error" ? "invalid_request" : "internal_error";
  return { ok: false, status: statusCode ?? 502, code, message };
}

/**
 * Console OAuth lifecycle: interactive login sessions (start/exchange/cancel),
 * explicit token refresh, provider-side revoke, and bounded account status.
 * Persists exchanged tokens through the durable OAuthTokenStore port; driver
 * lookup is provider-aware through the injected AuthDriverRegistry.
 */
export class OAuthService {
  private readonly sessions: OAuthLoginSessionManager;
  private readonly refresher: OAuthRefresher;
  private readonly drivers: AuthDriverRegistry;
  private readonly accounts: AccountRepository;
  private readonly tokens: OAuthTokenStore;
  private readonly refreshes = new Map<string, Promise<OAuthRefreshResultView>>();

  constructor(options: {
    readonly sessions: OAuthLoginSessionManager;
    readonly refresher: OAuthRefresher;
    readonly drivers: AuthDriverRegistry;
    readonly accounts: AccountRepository;
    readonly tokens: OAuthTokenStore;
  }) {
    this.sessions = options.sessions;
    this.refresher = options.refresher;
    this.drivers = options.drivers;
    this.accounts = options.accounts;
    this.tokens = options.tokens;
  }

  async start(input: unknown): Promise<OAuthStartResultView> {
    const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const providerId = typeof value.providerId === "string" ? value.providerId : "";
    if (providerId.length === 0) return { ok: false, status: 400, code: "invalid_request", message: "provider is required" };
    const name = typeof value.name === "string" ? value.name : "";
    if (name.trim().length === 0) return { ok: false, status: 400, code: "invalid_request", message: "account name is required" };
    try {
      const result = await this.sessions.start({
        providerId,
        name,
        redirectUri: typeof value.redirectUri === "string" && value.redirectUri.length > 0 ? value.redirectUri : undefined,
        scopes: Array.isArray(value.scopes) ? value.scopes.flatMap((item) => (typeof item === "string" ? [item] : [])) : undefined,
      });
      // Start the local callback server for providers that use one
      // (Codex, Anthropic, Antigravity, Kimchi). Device-flow providers
      // (Kiro, Cline) don't need a local listener.
      registerOAuthCallback(providerId, result.sessionId, result.state, this.sessions, async (sessionId, input) => {
        await this.complete(sessionId, { code: input.code, state: input.state, error: input.error, value: input.value });
      });
      return {
        ok: true,
        sessionId: result.sessionId,
        providerId: result.providerId,
        name: result.name,
        authorizationUrl: result.authorizationUrl,
        instructions: result.userCode ? "Open the verification URL, enter the device code, then check authorization here." : "Complete authorization in the provider window, then return here to finish the connection.",
        redirectUri: result.redirectUri,
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        intervalSeconds: result.intervalSeconds,
        state: result.state,
        expiresAtMs: result.expiresAtMs,
      };
    } catch (error) {
      return oauthSessionErrorView(error);
    }
  }

  /** Live session status; null when the session is unknown or expired. */
  async session(sessionId: string): Promise<ReturnType<OAuthLoginSessionManager["get"]>> {
    const before = this.sessions.get(sessionId);
    if (before === null) return null;
    const polled = await this.sessions.poll(sessionId);
    if (polled.status === "completed" && polled.accountId === null) {
      await this.complete(sessionId, {});
    }
    return this.sessions.get(sessionId);
  }

  async complete(sessionId: string, body: unknown): Promise<OAuthCompleteResultView> {
    const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    let completed: { readonly view: OAuthLoginSessionView; readonly tokenSet: TokenSet };
    try {
      const outcome = await this.sessions.complete(sessionId, {
        code: typeof value.code === "string" ? value.code : undefined,
        state: typeof value.state === "string" ? value.state : undefined,
        error: typeof value.error === "string" ? value.error : undefined,
        codeVerifier: typeof value.codeVerifier === "string" ? value.codeVerifier : undefined,
        redirectUri: typeof value.redirectUri === "string" ? value.redirectUri : undefined,
        value: typeof value.value === "string" ? value.value : undefined,
      });
      completed = outcome;
    } catch (error) {
      return oauthSessionErrorView(error);
    }
    const token: OAuthTokenRecord = {
      accessToken: completed.tokenSet.accessToken,
      expiresAtMs: typeof completed.tokenSet.expiresAt === "string" ? Number(new Date(completed.tokenSet.expiresAt)) : null,
      refreshToken: completed.tokenSet.refreshToken ?? null,
      kind: "oauth",
    };
    const created = await this.accounts.create({
      providerId: completed.view.providerId,
      name: completed.view.name,
      credentialKind: "oauth",
      credential: oauthCredentialBundle(completed.view.providerId, token, completed.tokenSet),
      priority: undefined,
      active: true,
    });
    await this.tokens.set(created.id, token);
    this.sessions.attachAccountId(sessionId, created.id);
    unregisterOAuthCallback(completed.view.providerId, sessionId);
    return { ok: true, accountId: created.id, providerId: completed.view.providerId, status: "completed", credentialHint: created.credentialHint };
  }

  /** Cancels a pending session; false when the session does not exist. */
  async cancel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const result = this.sessions.cancel(sessionId);
    if (result && session !== null) {
      unregisterOAuthCallback(session.providerId, sessionId);
    }
    return result;
  }

  /** Explicit, single-flight token refresh for an OAuth account; persists the rotated token. */
  async refreshAccount(accountId: string): Promise<OAuthRefreshResultView> {
    if (accountId.length === 0) return { ok: false, status: 400, code: "invalid_request", message: "accountId is required" };
    const account = await this.accounts.get(accountId);
    if (account === null) return { ok: false, status: 404, code: "not_found", message: "account not found" };
    if (account.credentialKind !== "oauth") return { ok: false, status: 400, code: "invalid_request", message: "account is not OAuth-linked" };
    const token = await this.tokens.get(accountId);
    const refreshToken = token?.refreshToken ?? null;
    // A completed OAuth login may intentionally return a non-refreshable
    // access token. It is already usable by the data plane, so an explicit
    // refresh request must not turn a healthy account into a local error.
    if (refreshToken === null && token?.accessToken) {
      return { ok: true, expiresAt: token.expiresAtMs === null ? null : new Date(token.expiresAtMs).toISOString() };
    }
    if (refreshToken === null) return { ok: false, status: 400, code: "invalid_request", message: "account has no access token" };
    const inflight = this.refreshes.get(accountId);
    if (inflight !== undefined) return inflight;
    const pending = this.performRefresh(accountId, token ?? null);
    this.refreshes.set(accountId, pending);
    pending.then(
      () => {
        this.refreshes.delete(accountId);
      },
      () => {
        this.refreshes.delete(accountId);
      },
    );
    return pending;
  }

  /**
   * Revokes an OAuth account: best-effort provider-side revoke through the
   * registered driver, then disables the account and clears the stored token.
   * False when the account does not exist.
   */
  async revoke(providerId: string, accountId: string): Promise<boolean> {
    const account = await this.accounts.get(accountId);
    if (account === null) return false;
    const resolvedProvider = providerId.length > 0 ? providerId : account.providerId;
    const driver = this.drivers.get(resolvedProvider);
    const token = await this.tokens.get(accountId);
    if (driver?.revoke !== undefined && token !== undefined) {
      try {
        await driver.revoke({ providerId: resolvedProvider, accountId, token: token.accessToken });
      } catch {
        // Best-effort: local disable + token clear still apply.
      }
    }
    await this.accounts.update(accountId, { active: false });
    await this.tokens.delete(accountId);
    return true;
  }

  /** Bounded OAuth account status; null when the account does not exist. */
  async accountStatus(accountId: string): Promise<OAuthAccountStatusView | null> {
    const account = await this.accounts.get(accountId);
    if (account === null) return null;
    const token = await this.tokens.get(accountId);
    const hasRefreshToken = token?.refreshToken !== null && token?.refreshToken !== undefined && token.refreshToken.length > 0;
    const expiresAtMs = token?.expiresAtMs ?? null;
    const expired = token === undefined || (expiresAtMs !== null && expiresAtMs - Date.now() <= OAUTH_SAFETY_SKEW_MS);
    const driver = this.drivers.get(account.providerId);
    return {
      accountId,
      providerId: account.providerId,
      linked: account.credentialKind === "oauth",
      hasRefreshToken,
      accessTokenExpiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      expired,
      refreshable: driver?.refresh !== undefined && hasRefreshToken,
      revocable: driver?.revoke !== undefined || hasRefreshToken,
    };
  }

  private async performRefresh(accountId: string, token: OAuthTokenRecord | null): Promise<OAuthRefreshResultView> {
    const result = await this.refresher.refresh({ accountId, token });
    if (!result.ok) {
      return oauthRefreshErrorView(result.error.kind, result.error.statusCode, result.error.sanitizedMessage);
    }
    await this.tokens.set(accountId, result.token);
    return { ok: true, expiresAt: result.token.expiresAtMs === null ? null : new Date(result.token.expiresAtMs).toISOString() };
  }
}

/** Account row plus failed/replacement route switch metadata. */
export interface AccountView extends AccountRowView, RouteTransitionView {}

const DEFAULT_PROXY_CANARY_URL = "https://www.google.com/generate_204";

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

export class QuotaService {
  private readonly inflight = new Map<string, Promise<AccountQuotaView | null>>();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly states: QuotaStateStore,
    private readonly tokens: OAuthTokenStore,
    private readonly oauth?: { ensureFresh(accountId: string): Promise<OAuthTokenRecord> } | null,
  ) {}

  async get(accountId: string): Promise<AccountQuotaView | null> {
    return this.accounts.quota(accountId);
  }

  async refresh(accountId: string): Promise<AccountQuotaView | null> {
    const existing = this.inflight.get(accountId);
    if (existing !== undefined) return existing;
    const pending = this.performRefresh(accountId);
    this.inflight.set(accountId, pending);
    void pending.then(
      () => this.inflight.delete(accountId),
      () => this.inflight.delete(accountId),
    );
    return pending;
  }

  private async performRefresh(accountId: string): Promise<AccountQuotaView | null> {
    const account = await this.accounts.get(accountId);
    if (account === null) return null;
    const credential = await this.accounts.credential(accountId);
    const previous = await this.states.get(accountId);
    const attemptAtMs = Date.now();
    // For OAuth accounts, ensureFresh the token before fetching quota —
    // an expired access token makes the quota API return 401 silently.
    let token = account.credentialKind === "oauth" ? await this.tokens.get(accountId) : undefined;
    if (account.credentialKind === "oauth" && this.oauth !== undefined && this.oauth !== null) {
      try {
        const fresh = await this.oauth.ensureFresh(accountId);
        token = fresh;
      } catch {
        // If refresh fails, fall through with the existing (possibly stale) token.
      }
    }
    const result = await fetchProviderQuota(account.providerId, credential?.credential ?? "", token);
    const successful = result.error === null;
    const previousQuota = previous?.quota ?? null;
    const snapshot: QuotaSnapshotState = {
      source: result.source,
      status: successful ? "ready" : "error",
      plan: successful ? result.plan : previousQuota?.plan ?? null,
      windows: successful ? result.windows : previousQuota?.windows ?? [],
      fetchedAt: successful ? new Date(attemptAtMs).toISOString() : previousQuota?.fetchedAt ?? null,
      lastAttemptAt: new Date(attemptAtMs).toISOString(),
      lastSuccessAt: successful ? new Date(attemptAtMs).toISOString() : previousQuota?.lastSuccessAt ?? null,
      error: successful ? null : result.error,
    };
    const quotaAvailable = snapshot.windows.length === 0 || snapshot.windows.some((window) => window.remainingPercent === null || window.remainingPercent > 0);
    await this.states.set({ accountId, quotaAvailable, lastQuotaRefreshAtMs: successful ? attemptAtMs : previous?.lastQuotaRefreshAtMs ?? null, lastQuotaAttemptAtMs: attemptAtMs, lastQuotaSuccessAtMs: successful ? attemptAtMs : previous?.lastQuotaSuccessAtMs ?? null, quota: snapshot });
    return snapshot;
  }
}

export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async get(): Promise<SettingsView> {
    const snapshot = await this.repo.get();
    return {
      hasPassword: snapshot.passwordHash !== null,
      passwordVersion: snapshot.passwordVersion,
      runtime: snapshot.runtime,
      updatedAt: snapshot.updatedAt,
    };
  }

  async patchRuntime(patch: unknown): Promise<ConsoleRuntimeSettings> {
    if (typeof patch !== "object" || patch === null) return (await this.repo.get()).runtime;
    const value = patch as Record<string, unknown>;
    return this.repo.patchRuntime(sanitizeRuntimePatch(value));
  }
}

/** Telemetry metadata writes (compact, content-free) from console actions. */
export class TelemetryService {
  constructor(private readonly runtimeMetadata: RuntimeMetadataRepository) {}

  async recordProbe(meta: ModelProbeMetadata): Promise<void> {
    await this.runtimeMetadata.recordModelProbe(meta);
  }

  async clearLogs(): Promise<void> {
    await this.runtimeMetadata.clearLogs();
  }
}

export class FilterRuleService {
  private cache: { rules: readonly FilterRuleView[]; at: number } | null = null;
  private static readonly CACHE_TTL_MS = 5_000;

  constructor(private readonly repo: FilterRuleRepository) {}

  private async getCachedRules(): Promise<readonly FilterRuleView[]> {
    if (this.cache !== null && Date.now() - this.cache.at < FilterRuleService.CACHE_TTL_MS) {
      return this.cache.rules;
    }
    const rules = await this.repo.list();
    this.cache = { rules, at: Date.now() };
    return rules;
  }

  private invalidate(): void { this.cache = null; }

  async list(): Promise<{ readonly count: number; readonly activeCount: number; readonly rules: readonly FilterRuleView[] }> {
    const rules = await this.getCachedRules();
    return { count: rules.length, activeCount: rules.filter((r) => r.isActive).length, rules };
  }

  async create(input: unknown): Promise<FilterRuleView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    const value = input as Record<string, unknown>;
    if (typeof value.pattern !== "string" || value.pattern.trim().length === 0) return { ok: false, status: 400, code: "invalid_request", message: "pattern is required" };
    const isRegex = value.isRegex !== false;
    if (isRegex) { try { new RegExp(value.pattern, "gi"); } catch { return { ok: false, status: 400, code: "invalid_request", message: "invalid regex pattern" }; } }
    try {
      const result = await this.repo.create({
        ruleId: typeof value.ruleId === "string" && value.ruleId.trim().length > 0 ? value.ruleId.trim() : undefined,
        pattern: value.pattern.trim(),
        replacement: typeof value.replacement === "string" ? value.replacement : "",
        isRegex,
        isActive: value.isActive !== false,
      });
      this.invalidate();
      return result;
    } catch (error) {
      return { ok: false, status: 400, code: "invalid_request", message: error instanceof Error ? error.message : "create failed" };
    }
  }

  async update(id: number, input: unknown): Promise<FilterRuleView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    const value = input as Record<string, unknown>;
    const patch: { pattern?: string; replacement?: string; isRegex?: boolean; isActive?: boolean; sortOrder?: number } = {};
    if (typeof value.pattern === "string") patch.pattern = value.pattern.trim();
    if (typeof value.replacement === "string") patch.replacement = value.replacement;
    if (typeof value.isRegex === "boolean") patch.isRegex = value.isRegex;
    if (typeof value.isActive === "boolean") patch.isActive = value.isActive;
    if (typeof value.sortOrder === "number") patch.sortOrder = value.sortOrder;
    if (patch.isRegex === true && patch.pattern !== undefined) { try { new RegExp(patch.pattern, "gi"); } catch { return { ok: false, status: 400, code: "invalid_request", message: "invalid regex pattern" }; } }
    try {
      const result = await this.repo.update(id, patch);
      if (result === null) return { ok: false, status: 404, code: "not_found", message: "filter rule not found" };
      this.invalidate();
      return result;
    } catch (error) {
      return { ok: false, status: 400, code: "invalid_request", message: error instanceof Error ? error.message : "update failed" };
    }
  }

  async remove(id: number): Promise<boolean> {
    const result = await this.repo.remove(id);
    if (result) this.invalidate();
    return result;
  }
}

export class RoutingConfigService {
  constructor(
    private readonly repo: RoutingConfigRepository,
    private readonly modelMetadata?: ModelMetadataResolver,
  ) {}

  async listAliases(): Promise<readonly AliasView[]> {
    const rows = await this.repo.listAliases();
    if (this.modelMetadata === undefined) return rows;
    return Promise.all(rows.map(async (row) => ({ ...row, metadata: (await this.modelMetadata!.resolve(row.model)) ?? undefined })));
  }

  async createAlias(input: unknown): Promise<AliasView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.alias !== "string" || value.alias.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "alias is required" };
    }
    if (typeof value.model !== "string" || value.model.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "model is required" };
    }
    const result = await this.repo.putAlias(value.alias.trim(), value.model.trim());
    return result;
  }

  async deleteAlias(alias: string): Promise<boolean> {
    return this.repo.deleteAlias(alias);
  }

  async listCombos(): Promise<readonly ComboView[]> {
    const rows = await this.repo.listCombos();
    if (this.modelMetadata === undefined) return rows;
    return Promise.all(rows.map(async (row) => ({ ...row, metadata: (await this.modelMetadata!.resolve(row.name)) ?? undefined })));
  }

  async putCombo(input: unknown, id?: string): Promise<ComboView | { readonly ok: false; readonly status: number; readonly code: ConsoleErrorCode; readonly message: string }> {
    if (typeof input !== "object" || input === null) {
      return { ok: false, status: 400, code: "invalid_request", message: "invalid request body" };
    }
    const value = input as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      return { ok: false, status: 400, code: "invalid_request", message: "combo name is required" };
    }
    if (!Array.isArray(value.models) || value.models.length === 0 || !value.models.every((item) => typeof item === "string" && item.length > 0)) {
      return { ok: false, status: 400, code: "invalid_request", message: "combo must list at least one model" };
    }
    const strategy = value.strategy === "round-robin" ? "round-robin" : "fallback";
    const stickyLimit = typeof value.stickyLimit === "number" && Number.isFinite(value.stickyLimit) ? Math.max(0, Math.floor(value.stickyLimit)) : 0;
    const existing = id === undefined ? null : await this.repo.getCombo(id);
    const name = id === undefined || existing === null || existing.name === value.name ? value.name.trim() : value.name.trim();
    return this.repo.putCombo({ name, models: value.models as readonly string[], strategy, stickyLimit });
  }

  async deleteCombo(id: string): Promise<boolean> {
    return this.repo.deleteCombo(id);
  }
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

export class BackupService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly backups: BackupRepository,
  ) {}

  async verifyPassword(password: unknown): Promise<BackupActionResult> {
    const snapshot = await this.settings.get();
    const verified =
      snapshot.passwordHash !== null &&
      typeof password === "string" &&
      (await verifyConsolePassword(password, snapshot.passwordHash));
    return verified
      ? { ok: true, status: 200, code: null, message: "" }
      : { ok: false, status: 401, code: "unauthorized", message: "password is wrong" };
  }

  exportBackup(): BackupPayload {
    return this.backups.exportBackup();
  }

  async resetAll(password: unknown, confirmation: unknown, resetConfig: () => void, resetRuntime: () => void): Promise<BackupActionResult> {
    const verified = await this.verifyPassword(password);
    if (!verified.ok) return verified;
    if (confirmation !== "RESET ALL DATABASE AND RUNTIME") return { ok: false, status: 400, code: "invalid_request", message: "confirmation text is incorrect" };
    try {
      resetConfig();
      resetRuntime();
      return { ok: true, status: 200, code: null, message: "all configuration and runtime data reset" };
    } catch (error) {
      return { ok: false, status: 500, code: "internal_error", message: `Database reset failed: ${error instanceof Error ? sanitizeMessage(error) : "unknown error"}` };
    }
  }

  async restore(password: unknown, payload: unknown): Promise<BackupActionResult> {
    const verified = await this.verifyPassword(password);
    if (!verified.ok) return verified;
    const validation = validateRestorePayload(payload);
    if (!validation.ok) {
      return { ok: false, status: 400, code: "invalid_request", message: validation.error };
    }
    try {
      this.backups.restore(validation);
      return { ok: true, status: 200, code: null, message: "backup restored" };
    } catch (error) {
      return { ok: false, status: 500, code: "internal_error", message: `Backup restore failed: ${error instanceof Error ? sanitizeMessage(error) : "unknown error"}; configuration was left unchanged` };
    }
  }
}

export interface ConsoleServices {
  readonly auth: AuthService;
  readonly keys: ApiKeyService;
  readonly providers: ProviderService;
  readonly models: ModelService;
  readonly accounts: AccountService;
  readonly oauth: OAuthService;
  readonly proxies: ProxyService;
  readonly quota: QuotaService;
  readonly settings: SettingsService;
  readonly routing: RoutingConfigService;
  readonly filterRules: FilterRuleService;
  readonly backup: BackupService;
  readonly telemetry: TelemetryService;
}

export interface CreateConsoleServicesOptions {
  readonly repositories: ConsoleRepositories;
  readonly registry: ProviderRegistry;
  readonly loginLimiter?: LoginLimiter;
  /** Provider-id keyed OAuth drivers; defaults to the bundled drivers. */
  readonly authDrivers?: AuthDriverRegistry;
  /** Driver-aware refresh pipeline; defaults to driver-first without env fallback. */
  readonly oauthRefresher?: OAuthRefresher;
  /** Canonical model metadata resolution for model/alias/combo views. */
  readonly modelMetadata?: ModelMetadataResolver;
  /** OAuth coordinator for proactive token refresh during quota checks. */
  readonly oauthCoordinator?: { ensureFresh(accountId: string): Promise<OAuthTokenRecord> } | null;
}

/** Composes the console application services over injected repository ports. */
export function createConsoleServices(options: CreateConsoleServicesOptions): ConsoleServices {
  const { repositories, registry, loginLimiter, modelMetadata } = options;
  const authDrivers = options.authDrivers ?? createAuthDriverRegistry();
  const oauthRefresher = options.oauthRefresher ?? createDriverAwareOAuthRefresher({
    drivers: authDrivers,
    resolveProvider: async (accountId) => (await repositories.accounts.get(accountId))?.providerId ?? null,
  });
  return {
    auth: new AuthService(repositories.settings, loginLimiter),
    keys: new ApiKeyService(repositories.keys),
    providers: new ProviderService(registry, repositories.providerConfig, repositories.customProviders, repositories.accounts),
    models: new ModelService(repositories.models, registry, modelMetadata),
    accounts: new AccountService(repositories.accounts, repositories.transitions),
    oauth: new OAuthService({
      sessions: new OAuthLoginSessionManager({ drivers: authDrivers }),
      refresher: oauthRefresher,
      drivers: authDrivers,
      accounts: repositories.accounts,
      tokens: repositories.oauthTokens,
    }),
    proxies: new ProxyService(repositories.proxies, repositories.proxySettings, repositories.transitions),
    quota: new QuotaService(repositories.accounts, repositories.quotaState, repositories.oauthTokens, options.oauthCoordinator ?? null),
    settings: new SettingsService(repositories.settings),
    routing: new RoutingConfigService(repositories.routing, modelMetadata),
    filterRules: new FilterRuleService(repositories.filterRules),
    backup: new BackupService(repositories.settings, repositories.backup),
    telemetry: new TelemetryService(repositories.runtimeMetadata),
  };
}

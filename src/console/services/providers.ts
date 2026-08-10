import type { CredentialKind } from "../../application/contracts";
import { extractAccessTokenOrRaw } from "../../application/auth";
import type { ProviderRegistry } from "../../providers/registry";
import { assertPublicUrl, assertPublicUrlAtDispatch, fetchWithSsrfGuard } from "../../security/ssrf-guard";
import type {
  AccountRepository,
  ConsoleErrorCode,
  CustomProviderRepository,
  CustomProviderView,
  ProviderConfigRepository,
  ProviderConfigView,
  ProviderRoutingSettings,
  ProviderSummaryView,
} from "../views";
import {
  booleanOrUndefined,
  customProviderKind,
  numberOrUndefined,
  recordOrUndefined,
  sanitizeProviderRoutingPatch,
  stringOrUndefined,
} from "../input-sanitizers";
export function normalizeApiKeyCredential(value: string): string {
  return value.replace(/\s+/g, "");
}
const BLOCKED_CUSTOM_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "host", "content-length", "connection", "transfer-encoding"]);

function customHeadersOrUndefined(value: unknown): Readonly<Record<string, string>> | undefined {
  const headers = recordOrUndefined(value);
  if (headers === undefined) return undefined;
  const filtered: Record<string, string> = {};
  for (const [key, item] of Object.entries(headers)) {
    const normalized = key.trim().toLowerCase();
    if (normalized.length === 0 || BLOCKED_CUSTOM_HEADERS.has(normalized) || normalized.startsWith("proxy-")) continue;
    filtered[key.trim()] = item;
  }
  return filtered;
}

function customBaseUrlError(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return "provider base URL is required";
  try {
    const url = assertPublicUrl(value.trim(), { label: "Custom provider base URL", allowedProtocols: Bun.env.NODE_ENV === "development" || Bun.env.NODE_ENV === "test" ? { "http:": true, "https:": true } : { "https:": true } });
    if (url.username !== "" || url.password !== "" || url.hash !== "") return "custom provider base URL must not contain credentials or a fragment";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid custom provider base URL";
  }
}
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

async function discoverProviderModels(providerId: string, credential: string | null, kind: CredentialKind): Promise<string[]> {
  const endpoint = MODEL_ENDPOINTS[providerId];
  if (!endpoint) return [];
  if (!credential) return [];
  const token = extractAccessTokenOrRaw(credential);
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
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
    const baseUrlError = customBaseUrlError(baseUrl);
    if (baseUrlError !== null) {
      return { ok: false, status: 400, code: "invalid_request", message: baseUrlError };
    }
    const result = await this.customProviders.create({
      name: value.name.trim(),
      kind: customProviderKind(value.kind),
      slug,
      baseUrl,
      credential: normalizeApiKeyCredential(stringOrUndefined(value.credential) ?? ""),
      timeoutSeconds: numberOrUndefined(value.timeoutSeconds),
      autoFetchModels: booleanOrUndefined(value.autoFetchModels),
      customHeaders: customHeadersOrUndefined(value.customHeaders),
    });
    if ("error" in result) {
      return { ok: false, status: 409, code: "conflict", message: "a custom provider with this slug already exists" };
    }
    const credential = await this.customProviders.credential(result.id);
    const normalizedCredential = credential === null ? "" : normalizeApiKeyCredential(credential.credential);
    if (normalizedCredential.length > 0) {
      await this.accounts.create({
        providerId: result.slug,
        name: result.name,
        credentialKind: "api_key",
        credential: normalizedCredential,
      });
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
    if (value.baseUrl !== undefined) {
      const baseUrlError = customBaseUrlError(value.baseUrl);
      if (baseUrlError !== null) return { ok: false, status: 400, code: "invalid_request", message: baseUrlError };
    }
    return this.customProviders.update(id, {
      name: stringOrUndefined(value.name),
      kind: customProviderKind(value.kind),
      slug: stringOrUndefined(value.slug),
      baseUrl: stringOrUndefined(value.baseUrl),
      credential: typeof value.credential === "string" ? normalizeApiKeyCredential(value.credential) : undefined,
      timeoutSeconds: numberOrUndefined(value.timeoutSeconds),
      autoFetchModels: booleanOrUndefined(value.autoFetchModels),
      customHeaders: customHeadersOrUndefined(value.customHeaders),
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
    const response = await fetchWithSsrfGuard(modelsUrl, {
      headers: {
        accept: "application/json",
        ...(credential?.credential ? provider.kind === "anthropic" ? { "x-api-key": credential.credential, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential.credential}` } : {}),
      },
      signal: AbortSignal.timeout(Math.min(provider.timeoutSeconds * 1000, 30_000)),
    }, { maxRedirects: 2 });
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
      await assertPublicUrlAtDispatch(baseUrl, { label: `Custom provider "${provider.name}" health check` });
      const response = await fetchWithSsrfGuard(baseUrl, {
        method: "HEAD",
        headers: {
          ...(credential?.credential ? provider.kind === "anthropic" ? { "x-api-key": credential.credential, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential.credential}` } : {}),
        },
        signal: AbortSignal.timeout(Math.min(provider.timeoutSeconds * 1000, 10_000)),
      }, { maxRedirects: 2 });
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


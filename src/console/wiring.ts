import { hashConsolePassword, MemoryRouteTransitionStore, quotaViewFromState } from "./services/composition";
import type {
  AccountRepository as ConsoleAccountRepository,
  AccountListResult,
  AccountRowView,
  ActiveAccountCredential,
  ApiKeyRepository as ConsoleApiKeyRepository,
  ApiKeyView,
  BackupRepository as ConsoleBackupRepository,
  ConsoleRepositories,
  CustomProviderRepository as ConsoleCustomProviderRepository,
  ModelRepository,
  ModelView,
  ProviderConfigRepository,
  ProviderRoutingSettings,
  ProxyRepository as ConsoleProxyRepository,
  ProxyRowView,
  ProxySettingsRepository,
  RoutingConfigRepository,
  SettingsRepository as ConsoleSettingsRepository,
  RuntimeMetadataRepository as ConsoleRuntimeMetadataRepository,
} from "./services/composition";
import type { ProviderRegistry } from "../providers/registry";
import type { ModelMetadata, ProviderModel, RouteHealth } from "../application/contracts";
import type { BackupPayload, ConfigPersistence, ProviderAccountRecord, RestoreResult, RestoreValidation, RuntimePersistence } from "../storage";
import { assertProductionBootstrapEnvironment, generateConsoleJwtSecret, isValidBootstrapPassword } from "../security/secrets";
import { normalizeSidebarIconDataUrl, runtimeRecord, runtimeSettings } from "./runtime-settings";

function listOrNull(value: string | null): readonly string[] | null {
  if (value === null || value.trim() === "") return null;
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function toApiKeyView(row: ReturnType<ConfigPersistence["apiKeys"]["list"]>[number]): ApiKeyView {
  return {
    ...row,
    quoteBigText: row.quoteBigText ?? null,
    quoteSubText: row.quoteSubText ?? null,
    quoteBody: row.quoteBody ?? null,
    providerAllowlist: listOrNull(row.providerAllowlist),
    modelAllowlist: listOrNull(row.modelAllowlist),
    modelDenylist: listOrNull(row.modelDenylist),
  };
}

function toAccountView(
  row: ProviderAccountRecord,
  health: RouteHealth | null,
  quota: AccountRowView["quota"] = null,
): AccountRowView {
  return {
    id: row.id,
    providerId: row.provider,
    name: row.name,
    credentialKind: row.credentialKind,
    credentialHint: row.credentialHint,
    priority: row.priority,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    health,
    quota,
  };
}

function toProxyView(
  row: ReturnType<ConfigPersistence["proxies"]["list"]>[number],
  health: RouteHealth | null,
): ProxyRowView {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    isRelay: row.isRelay,
    host: row.host,
    port: row.port,
    username: row.username,
    passwordHint: row.password === null || row.password.length === 0 ? null : `${row.password.slice(0, 2)}…`,
    maxConcurrency: row.maxConcurrency,
    priority: row.priority,
    weight: row.weight,
    active: row.active,
    lastTestAt: row.lastTestAt,
    lastTestSuccessAt: row.lastTestSuccessAt,
    lastTestSuccessLatencyMs: row.lastTestSuccessLatencyMs,
    lastTestErrorAt: row.lastTestErrorAt,
    lastTestError: row.lastTestError,
    lastTestStatusCode: row.lastTestStatusCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    health,
  };
}

function modelMetadataFor(providerId: string, model: ProviderModel, config: ConfigPersistence): ModelMetadata {
  const custom = config.customProviders.getBySlug(providerId);
  return {
    context: model.context ?? { inputTokens: null, outputTokens: null },
    categories: model.categories ?? [],
    pricing: model.pricing ?? { inputPerMillion: null, outputPerMillion: null },
    source: custom !== null ? "custom" : "catalog",
    updatedAt: custom !== null ? custom.updatedAt : null,
  };
}

function modelView(row: ReturnType<ConfigPersistence["providerModels"]["list"]>[number], registry: ProviderRegistry, config: ConfigPersistence): ModelView {
  const catalog = registry.get(row.provider)?.models.list.find((model) => model.id === row.modelId);
  const model = catalog ?? null;
  return {
    providerId: row.provider,
    modelId: row.modelId,
    displayName: model?.displayName ?? row.modelId,
    enabled: row.enabled,
    source: model === null ? (row.source === "imported" ? "imported" : "manual") : "built-in",
    images: model?.capabilities.images,
    metadata: model === null ? undefined : modelMetadataFor(row.provider, model, config),
  };
}

function createConsoleSettingsRepository(config: ConfigPersistence): ConsoleSettingsRepository {
  return {
    async get() {
      assertProductionBootstrapEnvironment();
      const row = config.settings.ensure();
      if (row.jwtSecret === null) config.settings.rotateJwtSecret(Bun.env.CONSOLE_JWT_SECRET?.trim() || generateConsoleJwtSecret());
      if (row.passwordHash === null) {
        const bootstrapPassword = Bun.env.CONSOLE_PASSWORD;
        if (bootstrapPassword !== undefined && isValidBootstrapPassword(bootstrapPassword)) {
          config.settings.setPasswordHash(await hashConsolePassword(bootstrapPassword));
        } else if ((Bun.env.NODE_ENV ?? "production") !== "development" && Bun.env.NODE_ENV !== "test") {
          throw new Error("CONSOLE_PASSWORD is required on first production startup");
        }
      }
      const current = config.settings.ensure();
      return { passwordHash: current.passwordHash, passwordVersion: current.passwordVersion, jwtSecret: current.jwtSecret ?? "", runtime: runtimeSettings(config), initializedAt: current.initializedAt, updatedAt: current.updatedAt };
    },
    async patchRuntime(patch) {
      const persisted = config.settings.patchRuntimeSettings({ logRetentionDays: patch.logRetentionDays, assetRetentionDays: patch.assetRetentionDays });
      const jsonPatch: Record<string, unknown> = {};
      if (patch.proxyAuthMode !== undefined) jsonPatch.proxyAuthMode = patch.proxyAuthMode;
      if (patch.privacyMode !== undefined) jsonPatch.privacyMode = patch.privacyMode;
      if (patch.trackPayloads !== undefined) jsonPatch.trackPayloads = patch.trackPayloads;
      if (patch.trackAssets !== undefined) jsonPatch.trackAssets = patch.trackAssets;
      if (patch.maxFlightsPerIp !== undefined) jsonPatch.maxFlightsPerIp = patch.maxFlightsPerIp;
      if (patch.trustProxy !== undefined) jsonPatch.trustProxy = patch.trustProxy;
      if (patch.sessionTtlHours !== undefined) jsonPatch.sessionTtlHours = patch.sessionTtlHours;
      if (patch.tokenSaverEnabled !== undefined) jsonPatch.tokenSaverEnabled = patch.tokenSaverEnabled;
      if (patch.tokenSaverQuality !== undefined) jsonPatch.tokenSaverQuality = patch.tokenSaverQuality;
      if (patch.headroomEnabled !== undefined) jsonPatch.headroomEnabled = patch.headroomEnabled;
      if (patch.headroomUrl !== undefined) jsonPatch.headroomUrl = patch.headroomUrl;
      if (patch.headroomTimeoutMs !== undefined) jsonPatch.headroomTimeoutMs = patch.headroomTimeoutMs;
      if (patch.ponytailEnabled !== undefined) jsonPatch.ponytailEnabled = patch.ponytailEnabled;
      if (patch.filterRulesEnabled !== undefined) jsonPatch.filterRulesEnabled = patch.filterRulesEnabled;
      if (patch.sidebarIconDataUrl !== undefined) {
        const icon = normalizeSidebarIconDataUrl(patch.sidebarIconDataUrl);
        if (patch.sidebarIconDataUrl !== null && icon === null) throw new Error("sidebar icon must be a PNG or GIF data URL under 25 MiB");
        jsonPatch.sidebarIconDataUrl = icon;
      }
      if (Object.keys(jsonPatch).length > 0) {
        config.settings.patchSettingsJson({ runtime: { ...runtimeRecord(config), ...jsonPatch } });
      }
      return { ...runtimeSettings(config), logRetentionDays: persisted.logRetentionDays, assetRetentionDays: persisted.assetRetentionDays };
    },
    async setPasswordHash(hash) { config.settings.setPasswordHash(hash); },
    async bumpPasswordVersion() { config.settings.bumpPasswordVersion(); },
  };
}

function createConsoleApiKeyRepository(config: ConfigPersistence): ConsoleApiKeyRepository {
  const createSecret = (): string => `ck-${crypto.randomUUID().replaceAll("-", "")}`;
  return {
    async list() { return config.apiKeys.list().map(toApiKeyView); },
    async get(id) { const row = config.apiKeys.getById(id); return row === null ? null : toApiKeyView(row); },
    async create(input) {
      const key = input.key ?? createSecret();
      const row = config.apiKeys.create({
        id: crypto.randomUUID(),
        name: input.name,
        key,
        keyPrefix: key.slice(0, 10),
        rateLimitRpm: input.rateLimitRpm ?? null,
        dailyTokenLimit: input.dailyTokenLimit ?? null,
        monthlyTokenLimit: input.monthlyTokenLimit ?? null,
        oneTimeTokenLimit: input.oneTimeTokenLimit ?? null,
        maxConcurrentRequests: input.maxConcurrentRequests ?? null,
        providerAllowlist: input.providerAllowlist?.join(",") ?? null,
        modelAllowlist: input.modelAllowlist?.join(",") ?? null,
        modelDenylist: input.modelDenylist?.join(",") ?? null,
      });
      return { key, record: toApiKeyView(row) };
    },
    async update(id, patch) {
      const row = config.apiKeys.update(id, { ...patch, providerAllowlist: patch.providerAllowlist?.join(",") ?? null, modelAllowlist: patch.modelAllowlist?.join(",") ?? null, modelDenylist: patch.modelDenylist?.join(",") ?? null });
      return row === null ? null : toApiKeyView(row);
    },
    async regenerate(id) {
      const existing = config.apiKeys.getById(id);
      if (existing === null) return null;
      config.apiKeys.revoke(id);
      const key = createSecret();
      // Regeneration replaces the row but keeps the configured limits and
      // allowlists that the schema exposes on api_keys.
      const row = config.apiKeys.create({
        id: crypto.randomUUID(),
        name: existing.name,
        key,
        keyPrefix: key.slice(0, 10),
        rateLimitRpm: existing.rateLimitRpm,
        dailyTokenLimit: existing.dailyTokenLimit,
        monthlyTokenLimit: existing.monthlyTokenLimit,
        oneTimeTokenLimit: existing.oneTimeTokenLimit,
        maxConcurrentRequests: existing.maxConcurrentRequests,
        providerAllowlist: existing.providerAllowlist,
        modelAllowlist: existing.modelAllowlist,
        modelDenylist: existing.modelDenylist,
      });
      return { key, record: toApiKeyView(row) };
    },
    async revoke(id) { return config.apiKeys.revoke(id); },
    async remove(id) { return config.apiKeys.delete(id); },
    async credential(id) {
      const key = config.apiKeys.credential(id);
      return key === null ? null : { key };
    },
  };
}

function createConsoleProviderConfigRepository(config: ConfigPersistence, registry: ProviderRegistry): ProviderConfigRepository {
  const enabled = new Map<string, boolean>();
  const defaults = { strategy: "priority" as const, stickyLimit: 1, useStickyLimit: false };
  const readRouting = (id: string): ProviderRoutingSettings => {
    const settings = config.settings.getSettingsJson();
    const stored = typeof settings.providerRouting === "object" && settings.providerRouting !== null && !Array.isArray(settings.providerRouting)
      ? (settings.providerRouting as Record<string, unknown>)[id]
      : null;
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return defaults;
    const value = stored as Record<string, unknown>;
    return {
      strategy: value.strategy === "round-robin" ? "round-robin" : "priority",
      stickyLimit: typeof value.stickyLimit === "number" ? Math.max(1, Math.min(100, Math.round(value.stickyLimit))) : defaults.stickyLimit,
      useStickyLimit: value.useStickyLimit === true,
    };
  };
  const writeRouting = (id: string, value: ProviderRoutingSettings): void => {
    const settings = config.settings.getSettingsJson();
    const current = typeof settings.providerRouting === "object" && settings.providerRouting !== null && !Array.isArray(settings.providerRouting) ? settings.providerRouting as Record<string, unknown> : {};
    config.settings.patchSettingsJson({ providerRouting: { ...current, [id]: value } });
  };
  return {
    async list() { return registry.list().map((adapter) => ({ id: adapter.metadata.id, enabled: enabled.get(adapter.metadata.id) ?? true })); },
    async get(id) { return registry.get(id) === null ? null : { id, enabled: enabled.get(id) ?? true }; },
    async setEnabled(id, value) { if (registry.get(id) === null) return null; enabled.set(id, value); return { id, enabled: value }; },
    async getRouting(id) { return readRouting(id); },
    async setRouting(id, patch) { const value = { ...readRouting(id), ...patch }; writeRouting(id, value); return value; },
  };
}

function createConsoleModelRepository(config: ConfigPersistence, registry: ProviderRegistry): ModelRepository {
  return {
    async list(providerId) {
      const persisted = config.providerModels.list(providerId);
      const rows = new Map(persisted.map((row) => [row.modelId, modelView(row, registry, config)]));
      for (const model of registry.get(providerId)?.models.list ?? []) if (!rows.has(model.id)) rows.set(model.id, { providerId, modelId: model.id, displayName: model.displayName, enabled: true, source: "built-in", images: model.capabilities.images, metadata: modelMetadataFor(providerId, model, config) });
      return [...rows.values()];
    },
    async get(providerId, modelId) { return (await this.list(providerId)).find((row) => row.modelId === modelId) ?? null; },
    async setEnabled(providerId, modelId, enabled) { const row = config.providerModels.upsert(providerId, modelId, { enabled }); return modelView(row, registry, config); },
    async setAllEnabled(providerId, enabled) { for (const model of await this.list(providerId)) config.providerModels.upsert(providerId, model.modelId, { enabled }); },
    async saveCatalog(providerId: string, models: readonly ProviderModel[]) { for (const model of models) config.providerModels.upsert(providerId, model.id, { source: "registry" }); },
    async delete(providerId: string, modelId: string) { return config.providerModels.delete(providerId, modelId); },
  };
}

function deriveCredentialHint(credential: string, credentialKind: string, name?: string): string {
  if (credentialKind === "oauth" || credentialKind === "token") {
    if (credential.startsWith("{")) {
      try {
        const parsed = JSON.parse(credential) as Record<string, unknown>;
        const direct = typeof parsed.email === "string" && parsed.email.length > 0 ? parsed.email : typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
        if (direct !== null) return direct.length > 40 ? `${direct.slice(0, 40)}…` : direct;
        const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : typeof parsed.access_token === "string" ? parsed.access_token : null;
        if (accessToken !== null && accessToken.includes(".")) {
          const segment = accessToken.split(".")[1];
          if (segment) {
            const payload = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
            const profile = payload["https://api.openai.com/profile"];
            const profileRecord = typeof profile === "object" && profile !== null ? profile as Record<string, unknown> : null;
            const identity = typeof profileRecord?.email === "string" && profileRecord.email.length > 0 ? profileRecord.email : typeof payload.email === "string" && payload.email.length > 0 ? payload.email : typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null;
            if (identity !== null) return identity.length > 40 ? `${identity.slice(0, 40)}…` : identity;
          }
        }
      } catch { /* fall through */ }
    }
    if (credential.includes(".")) {
      try {
        const segment = credential.split(".")[1];
        if (segment) {
          const payload = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
          if (typeof payload.email === "string" && payload.email.length > 0) return payload.email.length > 40 ? `${payload.email.slice(0, 40)}…` : payload.email;
          if (typeof payload.name === "string" && payload.name.length > 0) return payload.name.length > 40 ? `${payload.name.slice(0, 40)}…` : payload.name;
          if (typeof payload.sub === "string" && payload.sub.includes("@")) return payload.sub.length > 40 ? `${payload.sub.slice(0, 40)}…` : payload.sub;
        }
      } catch { /* fall through */ }
    }
  }
  if (name && name.length > 0) return name.length > 40 ? `${name.slice(0, 40)}…` : name;
  return `${credential.slice(0, 4)}…`;
}

function createConsoleAccountRepository(config: ConfigPersistence): ConsoleAccountRepository {
  const view = async (row: ProviderAccountRecord): Promise<AccountRowView> => {
    const [health, quota, stored] = await Promise.all([
      config.accountHealth.get(row.id),
      config.stores.quotaState.get(row.id),
      config.stores.credentialConfig.getAccount(row.id),
    ]);
    const hydrated = stored?.secret ? { ...row, credentialHint: deriveCredentialHint(stored.secret, row.credentialKind, row.name) } : row;
    return toAccountView(hydrated, health, quotaViewFromState(quota?.quota));
  };
  const views = async (rows: readonly ProviderAccountRecord[]): Promise<readonly AccountRowView[]> => {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [healthWithIds, quotaRows, credentials] = await Promise.all([
      config.accountHealth.listWithIds
        ? config.accountHealth.listWithIds(ids)
        : Promise.all(rows.map(async (row) => ({ id: row.id, health: await config.accountHealth.get(row.id) }))),
      config.stores.quotaState.listForAccountIds(ids),
      Promise.all(rows.map(async (row) => ({ id: row.id, secret: (await config.stores.credentialConfig.getAccount(row.id))?.secret ?? null }))),
    ]);
    const healthById = new Map(healthWithIds.map((item) => [item.id, item.health] as const));
    const quotaById = new Map(quotaRows.map((item) => [item.accountId, item] as const));
    const credentialById = new Map(credentials.map((item) => [item.id, item.secret] as const));
    return rows.map((row) => {
      const secret = credentialById.get(row.id);
      const hydrated = secret ? { ...row, credentialHint: deriveCredentialHint(secret, row.credentialKind, row.name) } : row;
      return toAccountView(hydrated, healthById.get(row.id) ?? null, quotaViewFromState(quotaById.get(row.id)?.quota));
    });
  };
  return {
    async list(providerId) { return views(config.accounts.list(providerId)); },
    async listPaged(providerId, options): Promise<AccountListResult> {
      const page = config.accounts.listPaged(providerId, { limit: options.limit, cursor: options.cursor });
      return { items: await views(page.items), nextCursor: page.nextCursor };
    },
    async get(id) { const row = config.accounts.get(id); return row === null ? null : view(row); },
    async create(input) { const id = crypto.randomUUID(); const row = config.accounts.create({ id, provider: input.providerId, name: input.name, credentialKind: input.credentialKind, credential: input.credential, credentialHint: deriveCredentialHint(input.credential, input.credentialKind, input.name), priority: input.priority, active: input.active }); return { id: row.id, credentialHint: row.credentialHint }; },
    async update(id, patch) { const existing = config.accounts.get(id); const row = config.accounts.patch(id, { name: patch.name, credentialKind: patch.credentialKind, credential: patch.credential, credentialHint: patch.credential !== undefined ? deriveCredentialHint(patch.credential, patch.credentialKind ?? "", patch.name ?? existing?.name) : undefined, priority: patch.priority, active: patch.active }); return row === null ? null : view(row); },
    async remove(id) { return config.accounts.delete(id); },
    async quota(id) { return quotaViewFromState((await config.stores.quotaState.get(id))?.quota); },
    async removeBatch(ids) { return config.accounts.deleteBatch(ids); },
    async setActiveBatch(ids, active) { return config.accounts.setActiveBatch(ids, active); },
    async credential(id) { const account = await config.stores.credentialConfig.getAccount(id); return account?.secret === undefined || account.secret === null ? null : { credential: account.secret }; },
    async health(id) { return config.accountHealth.get(id); },
    async listActiveCredentials(providerId) { const allRows = config.accounts.list(providerId); const activeRows = allRows.filter((row) => row.active === true); const results = await Promise.all(activeRows.map(async (row) => { const cred = await config.stores.credentialConfig.getAccount(row.id); const credential = cred?.secret; return credential === undefined ? null : { credential, credentialKind: row.credentialKind }; })); return results.filter((result): result is ActiveAccountCredential => result !== null); },
  };
}

function createConsoleProxyRepository(config: ConfigPersistence): ConsoleProxyRepository {
  return {
    async list() {
      const rows = config.proxies.list();
      const healthWithIds = config.proxyHealth.listWithIds
        ? await config.proxyHealth.listWithIds()
        : await Promise.all(rows.map(async (row) => ({ id: row.id, health: await config.proxyHealth.get(row.id) })));
      const byId = new Map(healthWithIds.map((item) => [item.id, item.health] as const));
      return rows.map((row) => toProxyView(row, byId.get(row.id) ?? null));
    },
    async get(id) { const row = config.proxies.get(id); return row === null ? null : toProxyView(row, await config.proxyHealth.get(id)); },
    async create(input) { const row = config.proxies.create({ id: crypto.randomUUID(), ...input }); return { id: row.id, passwordHint: row.password === null ? null : `${row.password.slice(0, 2)}…` }; },
    async update(id, patch) { const row = config.proxies.patch(id, patch); return row === null ? null : toProxyView(row, await config.proxyHealth.get(id)); },
    async remove(id) { return config.proxies.delete(id); },
    async credential(id) { const row = config.proxies.get(id); return row === null ? null : { password: row.password }; },
    async health(id) { return config.proxyHealth.get(id); },
    async setHealth(id, health) { await config.stores.routeHealth.writeHealth("proxy", id, health); },
    async recordTest(id, result) { config.proxies.recordTest(id, result); },
  };
}

function createConsoleProxySettingsRepository(config: ConfigPersistence): ProxySettingsRepository {
  return {
    async get() {
      const row = config.proxies.getSettings();
      return {
        enabled: row?.enabled ?? false,
        excludedProviders: row?.excludedProviders ?? [],
        smartDynamicRouting: row?.smartDynamicRouting ?? false,
        stickyProxyCount: row?.smartDynamicProxyCount ?? 1,
        routingPreset: row?.routingPreset ?? "auto",
        targetConcurrent: row?.targetConcurrent ?? 0,
      };
    },
    async patch(patch) {
      const row = config.proxies.patchSettings({
        enabled: patch.enabled,
        excludedProviders: patch.excludedProviders,
        smartDynamicRouting: patch.smartDynamicRouting,
        smartDynamicProxyCount: patch.stickyProxyCount,
        routingPreset: patch.routingPreset,
        targetConcurrent: patch.targetConcurrent,
      });
      return {
        enabled: row.enabled,
        excludedProviders: row.excludedProviders,
        smartDynamicRouting: row.smartDynamicRouting,
        stickyProxyCount: row.smartDynamicProxyCount,
        routingPreset: row.routingPreset,
        targetConcurrent: row.targetConcurrent,
      };
    },
  };
}

function createConsoleRoutingRepository(config: ConfigPersistence): RoutingConfigRepository {
  return {
    async listAliases() { return config.aliases.list(); },
    async putAlias(alias, model) { return config.aliases.upsert(alias, model); },
    async deleteAlias(alias) { return config.aliases.delete(alias); },
    async listCombos() { return config.combos.list().map((row) => ({ id: row.id, name: row.name, models: row.models, strategy: row.strategy === "round-robin" ? "round-robin" as const : "fallback" as const, stickyLimit: row.stickyLimit })); },
    async getCombo(id) { const row = config.combos.get(id); return row === null ? null : { id: row.id, name: row.name, models: row.models, strategy: row.strategy === "round-robin" ? "round-robin" : "fallback", stickyLimit: row.stickyLimit }; },
    async putCombo(input) { const row = config.combos.upsert({ id: crypto.randomUUID(), name: input.name, models: input.models, strategy: input.strategy, stickyLimit: input.stickyLimit }); return { id: row.id, name: row.name, models: row.models, strategy: row.strategy === "round-robin" ? "round-robin" : "fallback", stickyLimit: row.stickyLimit }; },
    async deleteCombo(id) { return config.combos.delete(id); },
  };
}

function createConsoleRuntimeMetadataRepository(runtime: RuntimePersistence, registry: ProviderRegistry, config: ConfigPersistence): ConsoleRuntimeMetadataRepository {
  const mapRow = (row: Awaited<ReturnType<RuntimePersistence["metadata"]["queryRequests"]>>["items"][number]) => ({
    requestId: row.requestId,
    endpoint: row.endpoint,
    surface: row.surface,
    apiKeyId: row.apiKeyId,
    apiKeyPrefix: row.apiKeyPrefix,
    providerId: row.provider,
    model: row.model,
    statusCode: row.status ?? 0,
    errorKind: row.errorKind,
    mode: row.mode,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? row.startedAt,
    durationMs: row.durationMs ?? 0,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    usageSource: row.usageSource,
    clientName: row.clientName,
    clientSource: row.clientSource,
    messageCount: row.messageCount,
    toolCount: row.toolCount,
    imageCount: row.imageCount,
    tfftMs: row.tfftMs,
  });
  return {
    async queryRequests(filters) {
      const page = runtime.metadata.queryRequests({ limit: filters.limit ?? 50, provider: filters.providerId, model: filters.model, key: filters.apiKeyId, status: filters.status === "error" ? 500 : filters.status === "ok" ? 200 : undefined, cursor: filters.cursor === undefined ? undefined : Number(filters.cursor) });
      return { items: page.items.map(mapRow), nextCursor: page.nextCursor !== null ? String(page.nextCursor) : null };
    },
    async getRequest(requestId) {
      const row = runtime.metadata.queryRequests({ limit: 1, q: requestId }).items.find((item) => item.requestId === requestId);
      if (row === undefined) return null;
      const mapped = mapRow(row);
      return { ...mapped, payloads: runtime.payloads.get(requestId) };
    },
    async queryUsageSummary(period) {
      const summary = runtime.metadata.querySummary(period);
      const modelTotals = runtime.metadata.queryModelTokenTotals(period);
      let costUsd = 0;
      let partial = false;
      for (const entry of modelTotals) {
        const model = registry.get(entry.provider ?? "")?.models.list.find((m) => m.id === entry.model) ?? null;
        if (model === null) { partial = true; continue; }
        const metadata = modelMetadataFor(entry.provider ?? "", model, config);
        const pricing = metadata.pricing;
        if (pricing.inputPerMillion === null || pricing.outputPerMillion === null) { partial = true; continue; }
        costUsd += (entry.inputTokens / 1_000_000) * pricing.inputPerMillion + (entry.outputTokens / 1_000_000) * pricing.outputPerMillion;
      }
      return { requests: summary.requests, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, cachedTokens: summary.cachedTokens, totalTokens: summary.inputTokens + summary.outputTokens, errors: summary.errors, avgDurationMs: summary.avgDurationMs, estimatedCostUsd: costUsd, partial };
    },
    async queryUsageCache(period) { return runtime.metadata.queryCache(period); },
    async queryUsageChart(period) { return runtime.metadata.queryChart(period); },
    async queryUsageBy(dimension, period) {
      const rows = runtime.metadata.queryBy(dimension, period);
      if (rows.length === 0) return rows;
      const modelTotals = runtime.metadata.queryModelTokenTotals(period);
      const costByModel = new Map<string, number>();
      for (const entry of modelTotals) {
        const model = registry.get(entry.provider ?? "")?.models.list.find((m) => m.id === entry.model) ?? null;
        if (model === null) continue;
        const metadata = modelMetadataFor(entry.provider ?? "", model, config);
        const pricing = metadata.pricing;
        if (pricing.inputPerMillion === null || pricing.outputPerMillion === null) continue;
        const cost = (entry.inputTokens / 1_000_000) * pricing.inputPerMillion + (entry.outputTokens / 1_000_000) * pricing.outputPerMillion;
        costByModel.set(entry.model, (costByModel.get(entry.model) ?? 0) + cost);
      }
      const costByProvider = new Map<string, number>();
      for (const entry of modelTotals) {
        if (entry.provider === null) continue;
        const modelCost = costByModel.get(entry.model);
        if (modelCost === undefined) continue;
        costByProvider.set(entry.provider, (costByProvider.get(entry.provider) ?? 0) + modelCost);
      }
      return rows.map((row) => {
        let costUsd: number | null = null;
        if (dimension === "model") {
          costUsd = costByModel.get(row.name) ?? null;
        } else if (dimension === "provider") {
          costUsd = costByProvider.get(row.name) ?? null;
        }
        return { ...row, costUsd };
      });
    },
    async queryModelTokenTotals(period) { return runtime.metadata.queryModelTokenTotals(period); },
    async queryProviderToday() { return runtime.metadata.queryProviderToday().map((row) => ({ providerId: row.provider, requests: row.requests, inputTokens: row.input, cachedTokens: row.cached, outputTokens: row.output, errors: row.errors })); },
    async queryLastProviderError(providerId) { return runtime.metadata.queryLastProviderError(providerId); },
    async queryIpSummary(limit) { return runtime.metadata.queryIpSummary(limit); },
    async sumKeyTokens(keyId) { return runtime.metadata.sumKeyTokens(keyId); },
    async queryLogs(limit) { return runtime.consoleLogs.list({ limit }).items.map((row) => ({ id: row.id, ts: row.ts, level: row.level, scope: row.scope, category: row.category, msg: row.msg })); },
    async clearLogs() { runtime.consoleLogs.clear(); },
    async recordModelProbe() { runtime.flush(); },
  };
}

function ensureBootstrapProxyKey(config: ConfigPersistence): void {
  const key = Bun.env.BOOTSTRAP_PROXY_API_KEY?.trim();
  if (!key) return;
  const existing = config.apiKeys.getBySecret(key);
  if (existing !== null) {
    if (existing.rateLimitRpm === null) config.apiKeys.update(existing.id, { rateLimitRpm: 120 });
    return;
  }
  config.apiKeys.create({
    id: crypto.randomUUID(),
    name: Bun.env.BOOTSTRAP_PROXY_API_KEY_NAME?.trim() || "bootstrap",
    key,
    keyPrefix: key.slice(0, 10),
    rateLimitRpm: 120,
  });
}

/** Default pudidil filter rules — descriptive IDs, strip agent identities, billing headers, etc. */
const DEFAULT_FILTER_RULES: Array<{ ruleId: string; pattern: string; replacement: string; isRegex: boolean }> = [
  { ruleId: "remove_billing_header", pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*", replacement: "", isRegex: true },
  { ruleId: "remove_cc_entrypoint", pattern: "cc_entrypoint=\\w+", replacement: "", isRegex: true },
  { ruleId: "remove_cc_version", pattern: "cc_version=[\\w.]+", replacement: "", isRegex: true },
  { ruleId: "remove_cch_hash", pattern: "c?ch=[a-f0-9]+", replacement: "", isRegex: true },
  { ruleId: "remove_claude_code_github_url", pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*", replacement: "", isRegex: true },
  { ruleId: "remove_claude_code_identity", pattern: "You are Claude Code[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_anthropic_cli_ref", pattern: "Anthropic'?s official (?:CLI|tool|agent)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "remove_cursor_identity", pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "remove_windsurf_identity", pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_cline_identity", pattern: "You are Cline[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_ai_coding_agent", pattern: "(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_mcp_server_ref", pattern: "MCP (?:server|client|protocol)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "remove_powered_by_anthropic", pattern: "powered by (?:Claude|Anthropic)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "replace_claude_code_mention", pattern: "Claude Code", replacement: "the assistant", isRegex: false },
];

/** Seeds default filter rules on first boot (table empty). */
async function seedDefaultFilterRules(config: ConfigPersistence): Promise<void> {
  const existing = await config.filterRules.list();
  if (existing.length > 0) return;
  for (const rule of DEFAULT_FILTER_RULES) {
    try {
      await config.filterRules.create({ ruleId: rule.ruleId, pattern: rule.pattern, replacement: rule.replacement, isRegex: rule.isRegex, isActive: true });
    } catch {
      // Skip individual rule errors during seed — don't block startup
    }
  }
}

export function createConsoleRepositories(config: ConfigPersistence, runtime: RuntimePersistence, registry: ProviderRegistry): ConsoleRepositories {
  assertProductionBootstrapEnvironment();
  ensureBootstrapProxyKey(config);
  void seedDefaultFilterRules(config);
  const settings = createConsoleSettingsRepository(config);
  return { settings, keys: createConsoleApiKeyRepository(config), providerConfig: createConsoleProviderConfigRepository(config, registry), customProviders: createConsoleCustomProviderRepository(config), models: createConsoleModelRepository(config, registry), accounts: createConsoleAccountRepository(config), oauthTokens: config.stores.oauthToken, quotaState: config.stores.quotaState, proxies: createConsoleProxyRepository(config), proxySettings: createConsoleProxySettingsRepository(config), routing: createConsoleRoutingRepository(config), filterRules: config.filterRules, backup: createConsoleBackupRepository(config), runtimeMetadata: createConsoleRuntimeMetadataRepository(runtime, registry, config), transitions: new MemoryRouteTransitionStore() };
}

function createConsoleBackupRepository(config: ConfigPersistence): ConsoleBackupRepository {
  return {
    exportBackup(): BackupPayload {
      return config.backup();
    },
    restore(validation: Extract<RestoreValidation, { ok: true }>): RestoreResult {
      return config.restoreBackup(validation);
    },
  };
}

function createConsoleCustomProviderRepository(config: ConfigPersistence): ConsoleCustomProviderRepository {
  const view = (row: ReturnType<ConfigPersistence["customProviders"]["list"]>[number]) => ({ id: row.id, slug: row.slug, name: row.name, kind: row.type === "anthropic-compatible" ? "anthropic" as const : "openai-compatible" as const, baseUrl: row.baseUrl, credentialHint: row.credential.length > 0 ? `${row.credential.slice(0, 4)}…` : "", timeoutSeconds: row.timeoutSeconds, autoFetchModels: true, customHeaders: row.customHeaders, models: row.models, enabled: true, createdAt: row.createdAt, updatedAt: row.updatedAt });
  return {
    async list() { return config.customProviders.list().map(view); },
    async get(id) { const row = config.customProviders.get(id); return row === null ? null : view(row); },
    async create(input) { const row = config.customProviders.upsert({ id: crypto.randomUUID(), slug: input.slug, name: input.name, type: input.kind === "anthropic" ? "anthropic-compatible" : "openai-compatible", baseUrl: input.baseUrl, credential: input.credential ?? "", timeoutSeconds: input.timeoutSeconds, customHeaders: input.customHeaders }); return view(row); },
    async update(id, patch) { const existing = config.customProviders.get(id); if (existing === null) return null; const row = config.customProviders.upsert({ id, slug: patch.slug ?? existing.slug, name: patch.name ?? existing.name, type: patch.kind === "anthropic" ? "anthropic-compatible" : existing.type, baseUrl: patch.baseUrl ?? existing.baseUrl, credential: patch.credential ?? existing.credential, timeoutSeconds: patch.timeoutSeconds ?? existing.timeoutSeconds, customHeaders: patch.customHeaders ?? existing.customHeaders, models: existing.models }); return view(row); },
    async remove(id) { return config.customProviders.delete(id); },
    async updateModels(id, models) { const row = config.customProviders.updateModels(id, models); return row === null ? null : view(row); },
    async credential(id) { const row = config.customProviders.get(id); return row === null ? null : { credential: row.credential }; },
  };
}

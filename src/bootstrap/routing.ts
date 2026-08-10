import type { AccountCandidate, AffinityKey, ClientIdentity, CredentialKind, ModelLockRecord, RouteCandidate } from "../application/contracts";
import type { ApplicationErrorKind } from "../application/contracts";
import type { ProxyRequest } from "../application/contracts";
import type { ProxyRequestLogEvent, ProxyRoutePlan } from "../application/request";
import { AccountHealthManager, QuotaCoordinator } from "../application/auth";
import { resolveCliModelMapping } from "../application/cli-model-mapping";
import { resolveModelChain } from "../application/routing";
import type { RouteSnapshotCache } from "../application/routing-snapshot";
import { createRouteSnapshotCache } from "../application/routing-snapshot";
import { resolveModelWireSurface, resolveWireSurface } from "../open-sse/translate";
import { syncCustomAdapters } from "../providers/custom";
import { ProviderRegistry } from "../providers/registry";
import type { AccountRepository, AliasRepository, CliModelMappingRepository, ComboRepository, ConfigPersistence, CustomProviderRepository, ProxyRepository } from "../storage";
import type { FilterRuleRepository } from "../console/views";
import { runtimeSettings } from "../console/runtime-settings";
import { ProxyPool } from "../traffic";

function applicationKind(value: string | null): ApplicationErrorKind | null {
  const kinds: readonly ApplicationErrorKind[] = ["invalid_request", "authentication_failed", "authorization_denied", "quota_exceeded", "concurrency_exceeded", "model_not_found", "capability_unsupported", "credential_unavailable", "network_unavailable", "provider_rate_limited", "provider_unavailable", "provider_protocol_error", "stream_timeout", "stream_truncated", "client_aborted", "internal_error"];
  return value === null ? null : kinds.find((kind) => kind === value) ?? null;
}

function requestLogLevel(event: ProxyRequestLogEvent): "info" | "warn" | "error" {
  if (event.event === "failed") return "error";
  if (event.event === "incoming") return "info";
  if (event.status !== null && event.status >= 500) return "error";
  if (event.status !== null && event.status >= 400) return "warn";
  return "info";
}

function requestPrivacyMode(config: ConfigPersistence): "masked" | "full" {
  return runtimeSettings(config).privacyMode;
}

function maskIp(value: string | null): string {
  if (value === null || value.length === 0) return "unknown";
  if (value.includes(":")) {
    const segments = value.split(":").filter((segment) => segment.length > 0);
    return segments.length > 1 ? `${segments.slice(0, 3).join(":")}::*` : "masked";
  }
  const segments = value.split(".");
  return segments.length === 4 ? `${segments.slice(0, 3).join(".")}.xxx` : "masked";
}

function formatRequestLog(event: ProxyRequestLogEvent, privacyMode: "masked" | "full"): string {
  const ip = privacyMode === "full" ? event.clientIp ?? "unknown" : maskIp(event.clientIp);
  const parts = [
    `${event.event} request`,
    `endpoint=${event.endpoint}`,
    ...(event.providerId === null ? [] : [`provider=${event.providerId}`]),
    ...(event.model === null ? [] : [`model=${event.model}`]),
    `client=${event.clientName}/${event.clientSource}`,
    `request_id=${event.requestId}`,
    `ip=${ip}`,
    `messages=${event.messageCount}`,
    `tools=${event.toolCount}`,
  ];
  if (event.status !== null) parts.push(`status=${event.status}`);
  if (event.event !== "incoming") {
    parts.push(`${Math.round(event.durationMs)}ms`);
    if (event.inputTokens !== null) parts.push(`in=${event.inputTokens}`);
    if (event.outputTokens !== null) parts.push(`out=${event.outputTokens}`);
    if (event.cachedTokens !== null && event.cachedTokens > 0) parts.push(`cached=${event.cachedTokens}`);
    if (event.cacheWriteTokens !== null && event.cacheWriteTokens > 0) parts.push(`cache_write=${event.cacheWriteTokens}`);
  }
  return parts.join(" ");
}

async function listAccountCandidates(cache: RouteSnapshotCache, health: AccountHealthManager, quota: QuotaCoordinator, providerId: string): Promise<readonly AccountCandidate[]> {
  const snapshot = await cache.get();
  const stored: Array<{ readonly id: string; readonly providerId: string; readonly credentialKind: CredentialKind; readonly active: boolean }> = (snapshot.accountsByProvider.get(providerId) ?? []).map((row) => ({ id: row.id, providerId: row.providerId, credentialKind: row.credentialKind, active: row.active }));
  if (stored.length === 0) return [];
  // Batch: 3 queries total regardless of account count (was 3×N individual queries).
  const accountIds = stored.map((row) => row.id);
  const [healthMap, lockMap, quotaMap] = await Promise.all([
    health.getHealthBatch(accountIds),
    health.listModelLocksForAccounts(accountIds),
    quota.getQuotaAvailableBatch(accountIds),
  ]);
  return stored.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    credentialKind: row.credentialKind,
    health: healthMap.get(row.id) ?? null,
    enabled: row.active,
    quotaAvailable: quotaMap.get(row.id) ?? true,
    modelLocks: lockMap.get(row.id) ? new Map((lockMap.get(row.id) as readonly ModelLockRecord[]).map((lock) => [lock.modelId, lock])) : null,
  }));
}


function isClaudeWebSearchRequest(request: ProxyRequest): boolean {
  if (request.sourceSurface !== "anthropic-messages" || !request.tools.some((tool) => tool.name === "web_search")) return false;
  const systemText = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content)
    .map((block) => block.text ?? "")
    .join("\n");
  const userText = [...request.messages]
    .reverse()
    .find((message) => message.role === "user")
    ?.content
    .map((block) => block.text ?? "")
    .join("\n")
    .trim() ?? "";
  return systemText.includes("assistant for performing a web search tool use")
    && /^Perform a web search for the query:\s*\S/i.test(userText);
}

function createRouteResolver(
  registry: ProviderRegistry,
  cache: RouteSnapshotCache,
  _health: AccountHealthManager,
  _quota: QuotaCoordinator,
): (request: ProxyRequest, affinity: AffinityKey, client: ClientIdentity) => Promise<ProxyRoutePlan> {
  return async (request, affinity, client) => {
    const snapshot = await cache.get();
    if (isClaudeWebSearchRequest(request)) {
      const adapter = registry.get("exa");
      if (adapter !== null && resolveWireSurface(adapter.metadata, adapter.capabilities, request.sourceSurface) !== null) {
        return {
          affinity,
          candidates: [{
            id: "exa/exa-search",
            providerId: "exa",
            modelId: "exa-search",
            surface: request.sourceSurface,
            health: null,
            enabled: true,
            authorized: true,
            compatible: true,
          }],
          requestedModel: "exa/exa-search",
        };
      }
    }
    const mappedModel = resolveCliModelMapping(client, request.model, snapshot.cliModelMappings);
    const routedRequest = mappedModel === request.model ? request : { ...request, model: mappedModel };
    const chain = resolveModelChain(routedRequest.model, { prefixes: snapshot.prefixes, aliases: snapshot.aliases, combos: snapshot.combos }, affinity);
    const resolved = chain.kind === "qualified" ? [chain.model] : chain.kind === "combo" ? chain.candidates : [];
    const candidates: RouteCandidate[] = [];
    for (const target of resolved) {
      const adapter = registry.get(target.providerId);
      if (adapter === null) continue;
      // Curated catalogs gate model ids; catalog-less adapters (routers,
      // local servers, and custom providers) intentionally accept arbitrary
      // upstream ids, matching their adapter-level resolveTarget contract.
      // DB-stored fetched/custom models supplement the adapter catalog so
      // they pass the gate without a server restart.
      const dbKnown = snapshot.knownModelIds.get(target.providerId);
      const model = adapter.models.get(target.modelId);
      const known = adapter.models.list.length === 0 || model !== null || (dbKnown !== undefined && dbKnown.has(target.modelId));
      if (!known || resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, request.sourceSurface) === null) continue;
      candidates.push({
        id: `${target.providerId}/${target.modelId}`,
        providerId: target.providerId,
        modelId: target.modelId,
        surface: request.sourceSurface,
        health: null,
        enabled: true,
        authorized: true,
        compatible: true,
      });
    }
    // Bare model ID fallback: when the chain couldn't resolve the model
    // (no prefix, no alias, no combo), search every adapter's catalog and
    // DB-known models for an exact match.  This lets clients send just the
    // model id (e.g. "blackbox-pro") without a provider prefix.
    if (candidates.length === 0 && chain.kind === "unresolved") {
      for (const adapter of registry.list()) {
        const model = adapter.models.get(routedRequest.model);
        if (resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, routedRequest.sourceSurface) === null) continue;
        const dbKnown = snapshot.knownModelIds.get(adapter.metadata.id);
        const known = model !== null || (dbKnown !== undefined && dbKnown.has(routedRequest.model));
        if (!known) continue;
        candidates.push({
          id: `${adapter.metadata.id}/${routedRequest.model}`,
          providerId: adapter.metadata.id,
          modelId: routedRequest.model,
          surface: routedRequest.sourceSurface,
          health: null,
          enabled: true,
          authorized: true,
          compatible: true,
        });
      }
    }
    return { affinity, candidates, requestedModel: routedRequest.model };
  };
}

/**
 * Monotonic revision of routing-relevant configuration. Every console
 * mutation that flows through the wrapped repositories below increments it;
 * the route snapshot and catalog caches rebuild only when this counter moves.
 */
function createRoutingRevisionTrackedPersistence(
  config: ConfigPersistence,
  registry: ProviderRegistry,
  proxyPool?: ProxyPool,
  revision: { value: number } = { value: 0 },
): ConfigPersistence {
  const bump = (): void => {
    revision.value += 1;
  };
  const invalidateProxyCache = (): void => proxyPool?.invalidate();
  const aliases: AliasRepository = {
    ...config.aliases,
    upsert: (alias, model) => {
      const record = config.aliases.upsert(alias, model);
      bump();
      return record;
    },
    delete: (alias) => {
      const deleted = config.aliases.delete(alias);
      bump();
      return deleted;
    },
  };
  const combos: ComboRepository = {
    ...config.combos,
    upsert: (input) => {
      const record = config.combos.upsert(input);
      bump();
      return record;
    },
    delete: (id) => {
      const deleted = config.combos.delete(id);
      bump();
      return deleted;
    },
  };
  const cliModelMappings: CliModelMappingRepository = {
    ...config.cliModelMappings,
    upsert: (input) => {
      const record = config.cliModelMappings.upsert(input);
      bump();
      return record;
    },
    delete: (toolId, slotKey) => {
      const deleted = config.cliModelMappings.delete(toolId, slotKey);
      if (deleted) bump();
      return deleted;
    },
    setEnabled: (toolId, enabled) => {
      const record = config.cliModelMappings.setEnabled(toolId, enabled);
      bump();
      return record;
    },
    reset: (toolId) => {
      config.cliModelMappings.reset(toolId);
      bump();
    },
  };
  const proxies: ProxyRepository = {
    ...config.proxies,
    create: (input) => {
      const record = config.proxies.create(input);
      bump();
      invalidateProxyCache();
      return record;
    },
    patch: (id, patch) => {
      const record = config.proxies.patch(id, patch);
      bump();
      invalidateProxyCache();
      return record;
    },
    delete: (id) => {
      const deleted = config.proxies.delete(id);
      bump();
      invalidateProxyCache();
      return deleted;
    },
    patchSettings: (patch) => {
      const record = config.proxies.patchSettings(patch);
      bump();
      invalidateProxyCache();
      return record;
    },
  };
  const accounts: AccountRepository = {
    ...config.accounts,
    create: (input) => {
      const record = config.accounts.create(input);
      bump();
      return record;
    },
    patch: (id, patch) => {
      const record = config.accounts.patch(id, patch);
      bump();
      return record;
    },
    delete: (id) => {
      const deleted = config.accounts.delete(id);
      bump();
      return deleted;
    },
  };
  const customProviders: CustomProviderRepository = {
    ...config.customProviders,
    upsert: (input) => {
      const record = config.customProviders.upsert(input);
      bump();
      syncCustomAdapters(registry, config.customProviders);
      return record;
    },
    delete: (id) => {
      const deleted = config.customProviders.delete(id);
      if (deleted) {
        bump();
        syncCustomAdapters(registry, config.customProviders);
      }
      return deleted;
    },
    updateModels: (id, models) => {
      const record = config.customProviders.updateModels(id, models);
      if (record !== null) {
        bump();
        syncCustomAdapters(registry, config.customProviders);
      }
      return record;
    },
  };
  const providerModels = {
    list: (provider: string) => config.providerModels.list(provider),
    get: (provider: string, modelId: string) => config.providerModels.get(provider, modelId),
    upsert: (provider: string, modelId: string, input: { enabled?: boolean; source?: string }) => {
      const record = config.providerModels.upsert(provider, modelId, input);
      bump();
      return record;
    },
    delete: (provider: string, modelId: string) => {
      const deleted = config.providerModels.delete(provider, modelId);
      bump();
      return deleted;
    },
  };
  const filterRules: FilterRuleRepository = {
    ...config.filterRules,
    create: async (input) => {
      const record = await config.filterRules.create(input);
      bump();
      return record;
    },
    update: async (id, patch) => {
      const record = await config.filterRules.update(id, patch);
      if (record !== null) bump();
      return record;
    },
    remove: async (id) => {
      const deleted = await config.filterRules.remove(id);
      if (deleted) bump();
      return deleted;
    },
  };
  return { ...config, aliases, combos, cliModelMappings, proxies, accounts, customProviders, providerModels, filterRules };
}

export {
  applicationKind,
  requestLogLevel,
  requestPrivacyMode,
  maskIp,
  formatRequestLog,
  listAccountCandidates as accountCandidates,
  createRouteResolver as routeResolver,
  createRoutingRevisionTrackedPersistence as withRoutingRevisionTracking,
};
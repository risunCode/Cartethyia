/**
 * Providers API — registry list/detail, model test, routing config and
 * account CRUD (REQ-3.7, REQ-11, REQ-20).
 */

import { Elysia, t } from "elysia";
import { consoleError } from "../errors";
import { providerRegistry } from "../../upstream/providers";
import type { ProviderResult, ResolvedCredential } from "../../upstream/providers";
import { lookupKnownModelMeta } from "../../upstream/providers/model-catalog-index";
import { ADDED_PROVIDER_IDS, type AddedProviderId } from "../../routing/types";
import { isProviderId, prefixOf, accountCredentialKindOf } from "../../routing/providerMeta";
import { buildProviderOverview } from "./overview";
import { importAccountsForProvider } from "../import/importAccounts";
import { addAuditEvent } from "../db/repos/audit";
import { pushConsoleLog } from "../logs/ring";
import {
  accountsVersion,
  listAccounts,
  listAccountsPage,
  listActiveAccountCredentials,
  getAccount,
  createAccount,
  patchAccount,
  deleteAccount,
  RESOLVED_KIND_BY_ACCOUNT_KIND,
  type CredentialKind,
} from "../db/repos/accounts";
import { resolveCredentialForDispatch } from "../../upstream/dispatch";
import {
  getProviderRouting,
  upsertProviderRouting,
  type ProxyMode,
  type RoutingStrategy,
} from "../db/repos/routing";
import { getDb } from "../db/client";
import { appendJsonl, insertUsageHistory, utcNow } from "../db/repos/usage";
import { extractUsage } from "../tracking/usage-extractor";
import { deleteProviderModel, isProviderModelEnabled, listProviderModelStates, setAllKnownProviderModels, setProviderModelEnabled, upsertProviderModel } from "../db/repos/provider-models";
import { extractModelIds, extractResponseSample } from "../../shared/text-utils";

async function collectSample(result: ProviderResult): Promise<string> {
  if (result.type === "json") return extractResponseSample(result.body);
  let sample = "";
  for await (const event of result.events) {
    if (event.type === "text_delta") {
      sample += event.text;
      if (sample.length > 400) break;
    }
  }
  return sample;
}

const MODEL_ENDPOINTS: Partial<Record<AddedProviderId, string>> = {
  kimchi: "https://llm.kimchi.dev/openai/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "https://ollama.com/v1",
  cerebras: "https://api.cerebras.ai/v1",
  deepseek: "https://api.deepseek.com",
  siliconflow: "https://api.siliconflow.com/v1",
  mistral: "https://api.mistral.ai/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
  tpxiaomi: "https://token-plan-sgp.xiaomimimo.com/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

function supportsModelFetch(providerId: AddedProviderId): boolean {
  return providerId in MODEL_ENDPOINTS;
}

async function discoverProviderModels(providerId: AddedProviderId): Promise<string[]> {
  const provider = providerRegistry.get(providerId);
  if (!provider) return [];
  const endpoint = MODEL_ENDPOINTS[providerId];
  if (!endpoint) return provider.models.list().map((model) => model.id);
  const credentials = await listActiveAccountCredentials(providerId);
  if (credentials.length === 0) throw new Error("Add an active provider account before fetching models.");
  let lastStatus = 0;
  for (const credential of credentials) {
    const headers: Record<string, string> = providerId === "anthropic"
      ? { "x-api-key": credential, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${credential}` };
    const response = await fetch(`${endpoint}/models`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      lastStatus = response.status;
      continue;
    }
    const models = extractModelIds(await response.json(), true);
    if (models.length > 0) return models;
  }
  if (lastStatus > 0) throw new Error(`Model discovery returned ${lastStatus} for every active account.`);
  throw new Error("The provider returned no model IDs.");
}

export const providersRoutes = new Elysia({ prefix: "/console/api" })
  .get("/providers", () => {
    const overview = new Map(buildProviderOverview().map((p) => [p.id, p]));
    // "custom" is data-driven (managed via the Custom Providers section),
    // not a built-in provider that should appear as a card.
    const SKIP_IDS = new Set(["custom"]);
    const items = ADDED_PROVIDER_IDS.filter((id) => !SKIP_IDS.has(id)).map((id) => {
      const provider = providerRegistry.get(id);
      const accounts = listAccounts(id);
      return {
        id,
        name: provider?.display.name ?? id,
        icon: provider?.display.icon ?? id,
        authKind: provider?.display.authKind ?? "api-key",
        prefix: prefixOf(id) ?? id,
        modelCount: new Set([...(provider?.models.list().map((model) => model.id) ?? []), ...listProviderModelStates(id).map((model) => model.modelId)]).size,
        status: overview.get(id)?.status ?? "ok",
        connections: accounts.filter((a) => a.active).length,
      };
    });
    return { items };
  })
  .get("/providers/:id", async ({ params, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const provider = providerRegistry.get(params.id);
    if (!provider) {
      set.status = 404;
      return consoleError("not_found", "provider is not registered");
    }
    const overview = buildProviderOverview().find((p) => p.id === params.id);
    const routing = getProviderRouting(params.id);
    const savedModels = new Map(listProviderModelStates(params.id).map((model) => [model.modelId, model]));
    const builtInModels = provider.models.list().map((model) => ({ ...model, enabled: savedModels.get(model.id)?.enabled ?? true, source: "built-in" as const }));
    const manualModels = [...savedModels.values()]
      .filter((model) => !builtInModels.some((builtIn) => builtIn.id === model.modelId))
      .map((model) => ({ id: model.modelId, ...lookupKnownModelMeta(model.modelId), enabled: model.enabled, source: model.source }));
    return {
      id: params.id,
      name: provider.display.name,
      icon: provider.display.icon,
      authKind: provider.display.authKind,
      authHint: provider.display.authHint,
      credentialUrl: provider.display.credentialUrl ?? null,
      // Single source of truth for the account form's `credentialKind` field
      // (bearer/pat/session-token) — avoids the dashboard maintaining its own
      // copy of this table that silently drifts out of sync per-provider.
      accountCredentialKind: accountCredentialKindOf(params.id),
      prefix: prefixOf(params.id) ?? params.id,
      models: [...builtInModels, ...manualModels],
      modelManagement: {
        canAddModels: true,
        canFetchModels: supportsModelFetch(params.id),
      },
      status: overview?.status ?? "ok",
      usageToday: overview ?? null,
      routing: {
        strategy: routing.strategy,
        stickyLimit: routing.stickyLimit,
        proxyMode: routing.proxyMode,
        proxyPoolId: routing.proxyPoolId,
      },
      accounts: listAccounts(params.id),
    };
  })
  .post("/providers/:id/models/:model/test", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const provider = providerRegistry.get(params.id);
    if (!provider) {
      set.status = 404;
      return consoleError("not_found", "provider is not registered");
    }
    const modelId = params.model;
    const managedModel = listProviderModelStates(params.id).find((model) => model.modelId === modelId);
    if (!provider.models.resolve(modelId) && !managedModel) {
      set.status = 404;
      return consoleError("not_found", "unknown model for this provider");
    }
    if (!isProviderModelEnabled(params.id, modelId)) {
      set.status = 404;
      return consoleError("not_found", "model is disabled for this provider");
    }

    const input = (body ?? {}) as { mode?: string; accountId?: string; credential?: string };
    const target = await provider.resolveTarget(modelId);
    if (!target) {
      pushConsoleLog("warn", "model-test", `${params.id}/${modelId}: no route target`);
      return { resolveOk: false, latencyMs: 0, ok: false, error: "provider could not resolve a route target" };
    }

    let credential: ResolvedCredential;
    if (input.mode === "auto") {
      // Shares resolveCredentialForDispatch with live dispatch (upstream/dispatch.ts)
      // so the console's test button rotates accounts exactly the way a real
      // request would — one implementation instead of two that can drift.
      const resolved = await resolveCredentialForDispatch(params.id, {}, modelId);
      if (!resolved) {
        set.status = 400;
        return consoleError("invalid_request", "no active account is available to rotate through");
      }
      credential = resolved;
    } else if (input.mode === "account") {
      const account = input.accountId ? getAccount(input.accountId) : null;
      if (!account || account.provider !== params.id) {
        set.status = 400;
        return consoleError("invalid_request", "account not found for this provider");
      }
      const kind = RESOLVED_KIND_BY_ACCOUNT_KIND[account.credential_kind as CredentialKind] ?? "provider-bearer";
      credential = { kind, value: account.credential };
    } else if (input.mode === "manual") {
      if (target.credential !== "none" && !input.credential) {
        set.status = 400;
        return consoleError("invalid_request", "manual mode requires a credential");
      }
      credential = { kind: target.credential, value: input.credential ?? "" };
    } else {
      set.status = 400;
      return consoleError("invalid_request", "mode must be 'auto', 'account', or 'manual'");
    }

    const started = performance.now();
    try {
      const result = await provider.call(
        target,
        {
          surface: "openai-chat",
          body: {
            model: modelId,
            stream: false,
            // Big Pickle spends a substantial part of its completion budget
            // reasoning. 1,024 tokens can end before it emits visible text.
            max_tokens: 4_096,
            messages: [{ role: "user", content: "Briefly say who you are." }],
          },
        },
        credential,
        AbortSignal.timeout(30_000)
      );
      const sample = (await collectSample(result)).slice(0, 400);
      const latencyMs = Math.round(performance.now() - started);
      const finishedAt = utcNow();
      const usage = result.type === "json" ? extractUsage("chat", result.body) : undefined;
      const traceId = crypto.randomUUID();
      insertUsageHistory({
        traceId,
        endpoint: "/console/provider-test",
        surface: "openai-chat",
        apiKeyId: null,
        apiKeyPrefix: null,
        provider: params.id,
        model: modelId,
        status: 200,
        errorKind: null,
        stream: false,
        startedAt: finishedAt,
        finishedAt,
        durationMs: latencyMs,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        usageSource: usage?.source ?? "missing",
        meta: { kind: "provider-test", accountId: input.accountId ?? null },
      });
      appendJsonl("requests", { traceId, endpoint: "/console/provider-test", provider: params.id, model: modelId, status: 200, durationMs: latencyMs, usage: usage ?? null });
      pushConsoleLog("info", "model-test", `${params.id}/${modelId} ok in ${latencyMs}ms`);
      addAuditEvent("provider.model_test", { provider: params.id, model: modelId, mode: input.mode, ok: true, latencyMs });
      return { resolveOk: true, latencyMs, ok: true, sample: sample || undefined };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      pushConsoleLog("warn", "model-test", `${params.id}/${modelId} failed in ${latencyMs}ms: ${message}`);
      addAuditEvent("provider.model_test", { provider: params.id, model: modelId, mode: input.mode, ok: false, error: message });
      return { resolveOk: true, latencyMs, ok: false, error: message };
    }
  })
  .post("/providers/:id/models", ({ params, body, set }) => {
    if (!isProviderId(params.id) || !providerRegistry.get(params.id)) {
      set.status = 404;
      return consoleError("not_found", "provider not found");
    }
    const modelId = typeof (body as { modelId?: unknown } | null)?.modelId === "string" ? (body as { modelId: string }).modelId.trim() : "";
    if (!modelId || modelId.length > 200) {
      set.status = 400;
      return consoleError("invalid_request", "modelId is required");
    }
    upsertProviderModel(params.id, modelId, "manual");
    return { ok: true, modelId };
  })
  .delete("/providers/:id/models/:model", ({ params, set }) => {
    if (!isProviderId(params.id) || !providerRegistry.get(params.id)) {
      set.status = 404;
      return consoleError("not_found", "provider not found");
    }
    if (!deleteProviderModel(params.id, params.model)) {
      set.status = 404;
      return consoleError("not_found", "only imported or manually added models can be deleted");
    }
    return { ok: true };
  })
  .post("/providers/:id/models/:model/enabled", ({ params, body, set }) => {
    if (!isProviderId(params.id) || !providerRegistry.get(params.id)) {
      set.status = 404;
      return consoleError("not_found", "provider not found");
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      set.status = 400;
      return consoleError("invalid_request", "enabled must be a boolean");
    }
    setProviderModelEnabled(params.id, params.model, enabled);
    return { ok: true };
  })
  .post("/providers/:id/models/enabled", ({ params, body, set }) => {
    const provider = isProviderId(params.id) ? providerRegistry.get(params.id) : undefined;
    if (!provider) {
      set.status = 404;
      return consoleError("not_found", "provider not found");
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      set.status = 400;
      return consoleError("invalid_request", "enabled must be a boolean");
    }
    setAllKnownProviderModels(params.id, provider.models.list().map((model) => model.id), enabled);
    return { ok: true };
  })
  .post("/providers/:id/models/import", async ({ params, set }) => {
    if (!isProviderId(params.id) || !providerRegistry.get(params.id)) {
      set.status = 404;
      return consoleError("not_found", "provider not found");
    }
    if (!supportsModelFetch(params.id)) {
      set.status = 400;
      return consoleError("invalid_request", "this provider does not publish a supported /models endpoint");
    }
    try {
      const models = await discoverProviderModels(params.id);
      for (const modelId of models) upsertProviderModel(params.id, modelId, "imported");
      return { ok: true, models };
    } catch (err) {
      set.status = 400;
      return consoleError("invalid_request", err instanceof Error ? err.message : "Model discovery failed.");
    }
  })
  .post("/providers/models/import", async () => {
    const results = await Promise.all(
      ADDED_PROVIDER_IDS.filter(supportsModelFetch).map(async (providerId) => {
        try {
          const models = await discoverProviderModels(providerId);
          for (const modelId of models) upsertProviderModel(providerId, modelId, "imported");
          return { providerId, imported: models.length };
        } catch (error) {
          return { providerId, imported: 0, error: error instanceof Error ? error.message : "Model discovery failed." };
        }
      }),
    );
    return { results };
  })
  .post("/providers/:id/routing", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const input = (body ?? {}) as {
      strategy?: string;
      stickyLimit?: number;
      proxyMode?: string;
      proxyPoolId?: string | null;
    };
    if (input.strategy !== undefined && input.strategy !== "priority" && input.strategy !== "round-robin") {
      set.status = 400;
      return consoleError("invalid_request", "strategy must be 'priority' or 'round-robin'");
    }
    if (input.stickyLimit !== undefined && (!Number.isInteger(input.stickyLimit) || input.stickyLimit < 0)) {
      set.status = 400;
      return consoleError("invalid_request", "stickyLimit must be a non-negative integer");
    }
    if (input.proxyMode !== undefined && !["direct", "proxy-pool", "mixed"].includes(input.proxyMode)) {
      set.status = 400;
      return consoleError("invalid_request", "proxyMode must be 'direct', 'proxy-pool' or 'mixed'");
    }
    if (input.proxyMode === "proxy-pool" || input.proxyMode === "mixed") {
      const poolId = input.proxyPoolId ?? getProviderRouting(params.id).proxyPoolId;
      if (!poolId) {
        set.status = 400;
        return consoleError("invalid_request", "proxyPoolId is required when proxyMode uses a pool");
      }
      const pool = getDb().query("SELECT id FROM proxy_pools WHERE id = ?").get(poolId);
      if (!pool) {
        set.status = 400;
        return consoleError("invalid_request", "proxy pool not found");
      }
    }
    const next = upsertProviderRouting(params.id, {
      strategy: input.strategy as RoutingStrategy | undefined,
      stickyLimit: input.stickyLimit,
      proxyMode: input.proxyMode as ProxyMode | undefined,
      proxyPoolId: input.proxyPoolId === undefined ? undefined : (input.proxyPoolId ?? null),
    });
    addAuditEvent("provider.routing", { provider: params.id, strategy: next.strategy, stickyLimit: next.stickyLimit, proxyMode: next.proxyMode, proxyPoolId: next.proxyPoolId });
    return { ok: true, routing: next };
  })
  .get("/providers/:id/accounts", ({ params, query, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const version = accountsVersion(params.id);
    if (query.since === version) return { unchanged: true, version };
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const page = listAccountsPage(params.id, Number.isFinite(limit) ? limit : 50, query.cursor);
    return { items: page.items, nextCursor: page.nextCursor, version: page.version };
  })
  /**
   * Reveals one account's credential so the console can offer a copy action.
   * Deliberately a separate endpoint from the account list: the list is polled
   * on every provider page render, and the secret should only cross the wire
   * when the operator explicitly asks for it. Access is already gated by the
   * console session guard, and the read is audited.
   */
  .get("/providers/:id/accounts/:accountId/credential", ({ params, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    addAuditEvent("provider.account.credential_revealed", { provider: params.id, id: account.id, name: account.name });
    return { credential: account.credential };
  })
  .post("/providers/:id/accounts/import", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return { error: { message: `Unknown provider: ${params.id}` } };
    }
    if (body.text.length > 1_000_000) {
      set.status = 413;
      return { error: { message: "Import text exceeds the 1 MB limit" } };
    }
    try {
      const summary = await importAccountsForProvider(params.id, body.text);
      addAuditEvent("provider.account.imported", { provider: params.id, imported: summary.imported, skipped: summary.skipped.length, renamed: summary.renamed.length });
      return summary;
    } catch (error) {
      set.status = 400;
      return { error: { message: error instanceof Error ? error.message : "Account import failed" } };
    }
  }, {
    body: t.Object({ text: t.String() }),
  })
  .post("/providers/:id/accounts", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const input = (body ?? {}) as {
      name?: string;
      credentialKind?: string;
      credential?: string;
      proxyPoolId?: string | null;
      useDirect?: boolean;
      priority?: number;
      active?: boolean;
    };
    if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
      set.status = 400;
      return consoleError("invalid_request", "name is required");
    }
    if (!input.credential || typeof input.credential !== "string") {
      set.status = 400;
      return consoleError("invalid_request", "credential is required");
    }
    const expectedKind = accountCredentialKindOf(params.id);
    const credentialKind = (input.credentialKind ?? expectedKind) as CredentialKind;
    if (credentialKind !== expectedKind) {
      set.status = 400;
      return consoleError("invalid_request", `provider ${params.id} expects credential kind '${expectedKind}'`);
    }
    if (input.proxyPoolId) {
      const pool = getDb().query("SELECT id FROM proxy_pools WHERE id = ?").get(input.proxyPoolId);
      if (!pool) {
        set.status = 400;
        return consoleError("invalid_request", "proxy pool not found");
      }
    }
    try {
      const created = await createAccount({
        provider: params.id,
        name: input.name.trim(),
        credentialKind,
        credential: input.credential,
        proxyPoolId: input.proxyPoolId ?? null,
        useDirect: input.useDirect,
        priority: input.priority,
        active: input.active,
      });
      addAuditEvent("provider.account.created", { provider: params.id, id: created.id, name: input.name.trim() });
      set.status = 201;
      return created;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        set.status = 409;
        return consoleError("conflict", "an account with this name already exists for this provider");
      }
      set.status = 500;
      return consoleError("internal", message);
    }
  })
  .post("/providers/:id/accounts/:accountId", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    const input = (body ?? {}) as {
      name?: string;
      credential?: string;
      proxyPoolId?: string | null;
      useDirect?: boolean;
      priority?: number;
      active?: boolean;
    };
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim().length === 0)) {
      set.status = 400;
      return consoleError("invalid_request", "name must be a non-empty string");
    }
    if (input.priority !== undefined && (!Number.isFinite(input.priority) || input.priority < 0 || input.priority > 1000)) {
      set.status = 400;
      return consoleError("invalid_request", "priority must be between 0 and 1000");
    }
    if (input.proxyPoolId) {
      const pool = getDb().query("SELECT id FROM proxy_pools WHERE id = ?").get(input.proxyPoolId);
      if (!pool) {
        set.status = 400;
        return consoleError("invalid_request", "proxy pool not found");
      }
    }
    try {
      await patchAccount(params.accountId, {
        name: input.name?.trim(),
        credential: input.credential,
        proxyPoolId: input.proxyPoolId === undefined ? undefined : (input.proxyPoolId ?? null),
        useDirect: input.useDirect,
        priority: input.priority,
        active: input.active,
      });
      addAuditEvent("provider.account.patched", { provider: params.id, id: params.accountId });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        set.status = 409;
        return consoleError("conflict", "an account with this name already exists for this provider");
      }
      set.status = 500;
      return consoleError("internal", message);
    }
  })
  .delete("/providers/:id/accounts/:accountId", ({ params, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const account = getAccount(params.accountId);
    if (!account || account.provider !== params.id) {
      set.status = 404;
      return consoleError("not_found", "account not found");
    }
    deleteAccount(params.accountId);
    addAuditEvent("provider.account.deleted", { provider: params.id, id: params.accountId, name: account.name });
    return { ok: true };
  });

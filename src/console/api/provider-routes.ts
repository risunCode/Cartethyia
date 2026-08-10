import { Elysia } from "elysia";
import { consoleError, type ConsoleServices } from "../services/composition";

export interface ProviderRouteDependencies {
  readonly services: ConsoleServices;
}

function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra };
}

function notFound(set: { status?: number | string }, message = "resource not found"): ReturnType<typeof consoleError> {
  set.status = 404;
  return consoleError("not_found", message);
}

function conflict(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 409;
  return consoleError("conflict", message);
}

function badRequest(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 400;
  return consoleError("invalid_request", message);
}

async function resolveProviderId(services: ConsoleServices, id: string): Promise<string> {
  const custom = (await services.providers.listCustom()).find((provider) => provider.id === id || provider.slug === id);
  return custom?.slug ?? id;
}

/** Registers built-in, custom-provider, and model-management routes. */
export function registerProviderRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: ProviderRouteDependencies): T {
  const { services } = deps;
  return app
    .route("QUERY", "/providers", async () => {
      const providers = await services.providers.list();
      const items = await Promise.all(providers.map(async (provider) => {
        const [routingResult, accountsResult, modelsResult] = await Promise.allSettled([
          services.providers.getRouting(provider.id),
          services.accounts.list(provider.id),
          services.models.list(provider.id),
        ]);
        const routing = routingResult.status === "fulfilled"
          ? routingResult.value
          : { strategy: "priority" as const, stickyLimit: 1, useStickyLimit: false };
        const accounts = accountsResult.status === "fulfilled" ? accountsResult.value : [];
        const models = modelsResult.status === "fulfilled" ? modelsResult.value : [];
        return {
          ...provider,
          routing,
          accountCount: accounts.length,
          modelCount: models.length,
          configured: provider.credentialKind === "none" || accounts.some((account) => account.active),
        };
      }));
      return { items };
    })
    .route("QUERY", "/providers/:id", async ({ params, set }) => {
      const custom = await services.providers.listCustom();
      const customRecord = custom.find((entry) => entry.id === params.id || entry.slug === params.id);
      const providerId = customRecord?.slug ?? params.id;
      const [summary, config, routing, models, accounts] = await Promise.all([
        services.providers.list(),
        services.providers.getConfig(providerId),
        services.providers.getRouting(providerId),
        services.models.list(providerId),
        services.accounts.list(providerId),
      ]);
      const provider = summary.find((entry) => entry.id === providerId);
      if (provider === undefined && customRecord === undefined) return notFound(set, "provider not found");
      return {
        ...(provider ?? {
          id: providerId,
          name: customRecord?.name ?? providerId,
          protocol: "openai",
          credentialKind: "api_key",
          surfaces: ["openai-chat"],
          enabled: config?.enabled ?? true,
          custom: true,
        }),
        enabled: config?.enabled ?? true,
        custom: customRecord !== undefined,
        routing,
        models,
        modelManagement: { canAddModels: true, canFetchModels: provider !== undefined },
        accounts,
        customProvider: customRecord ?? null,
      };
    })
    .patch("/providers/:id", async ({ params, body, set }) => {
      const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof value.enabled !== "boolean") return badRequest(set, "enabled must be a boolean");
      const config = await services.providers.setEnabled(params.id, value.enabled);
      if (config === null) return notFound(set, "provider not found");
      return config;
    })
    .post("/providers/:id/routing", async ({ params, body }) => ({ settings: await services.providers.setRouting(await resolveProviderId(services, params.id), body) }))
    .route("QUERY", "/providers/:id/models", async ({ params }) => ({ items: await services.models.list(await resolveProviderId(services, params.id)) }))
    .post("/providers/:id/models/fetch", async ({ params, set }) => {
      const providerId = await resolveProviderId(services, params.id);
      try {
        const discovered = await services.providers.discoverBuiltinModels(providerId);
        for (const modelId of discovered) await services.models.addCustom(providerId, modelId);
        return { items: await services.models.list(providerId), discovered };
      } catch (error) {
        return badRequest(set, error instanceof Error ? error.message : "Model fetch failed");
      }
    })
    .post("/providers/:id/models/discover", async ({ params, set }) => {
      try {
        const models = await services.providers.discoverBuiltinModels(await resolveProviderId(services, params.id));
        return { models };
      } catch (error) {
        return badRequest(set, error instanceof Error ? error.message : "Model discovery failed");
      }
    })
    .post("/providers/:id/models", async ({ params, body, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      if (typeof value.modelId !== "string" || value.modelId.trim().length === 0) return badRequest(set, "modelId is required");
      const model = await services.models.addCustom(await resolveProviderId(services, params.id), value.modelId);
      if (model === null) return badRequest(set, "provider or model is invalid");
      return model;
    })
    .delete("/providers/:id/models/:modelId", async ({ params, set }) => {
      if (!(await services.models.removeCustom(await resolveProviderId(services, params.id), params.modelId))) return notFound(set, "only custom or fetched models can be deleted");
      return ok();
    })
    .patch("/providers/:id/models/:modelId", async ({ params, body, set }) => {
      const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof value.enabled !== "boolean") return badRequest(set, "enabled must be a boolean");
      const model = await services.models.setEnabled(await resolveProviderId(services, params.id), params.modelId, value.enabled);
      if (model === null) return notFound(set, "model not found");
      return model;
    })
    .post("/providers/:id/models/enabled", async ({ params, body }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const enabled = value.enabled === true;
      await services.models.setAllEnabled(await resolveProviderId(services, params.id), enabled);
      return ok({ enabled });
    })
    .route("QUERY", "/custom-providers", async () => ({ items: await services.providers.listCustom() }))
    .post("/custom-providers", async ({ body, set }) => {
      const result = await services.providers.createCustom(body);
      if (!("id" in result)) return result.status === 400 ? badRequest(set, result.message) : conflict(set, result.message);
      return result;
    })
    .patch("/custom-providers/:id", async ({ params, body, set }) => {
      const record = await services.providers.updateCustom(params.id, body);
      if (record === null) return notFound(set);
      if (!("id" in record)) return record.status === 400 ? badRequest(set, record.message) : conflict(set, record.message);
      return record;
    })
    .delete("/custom-providers/:id", async ({ params, set }) => {
      if (!(await services.providers.removeCustom(params.id))) return notFound(set);
      return ok();
    })
    .route("QUERY", "/custom-providers/:id/credential", async ({ params, set }) => {
      const secret = await services.providers.customCredential(params.id);
      if (secret === null) return notFound(set);
      return secret;
    })
    .post("/custom-providers/:id/models/fetch", async ({ params, set }) => {
      const result = await services.providers.fetchCustomModels(params.id);
      if (!("id" in result)) return badRequest(set, result.error);
      return result;
    })
    .post("/custom-providers/:id/health", async ({ params, set }) => {
      const result = await services.providers.checkCustomProviderHealth(params.id);
      if (!result.ok) set.status = 503;
      return result;
    })
    .post("/custom-providers/:id/models", async ({ params, body, set }) => {
      const value = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
      const modelId = "modelId" in value ? value.modelId : undefined;
      if (typeof modelId !== "string" || modelId.trim().length === 0) return badRequest(set, "modelId is required");
      const result = await services.providers.addCustomModel(params.id, modelId);
      if (!("id" in result)) return badRequest(set, result.error);
      return result;
    })
    .delete("/custom-providers/:id/models/:modelId", async ({ params, set }) => {
      if (!(await services.providers.deleteCustomModel(params.id, params.modelId))) return notFound(set, "model not found");
      return ok();
    }) as unknown as T;
}

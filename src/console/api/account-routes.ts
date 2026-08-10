import { Elysia } from "elysia";
import { consoleError, type ConsoleServices } from "../services/composition";

export interface AccountRouteDependencies {
  readonly services: ConsoleServices;
}

function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra };
}

function notFound(set: { status?: number | string }, message = "resource not found"): ReturnType<typeof consoleError> {
  set.status = 404;
  return consoleError("not_found", message);
}

function badRequest(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 400;
  return consoleError("invalid_request", message);
}

async function resolveProviderId(services: ConsoleServices, id: string): Promise<string> {
  const custom = (await services.providers.listCustom()).find((provider) => provider.id === id || provider.slug === id);
  return custom?.slug ?? id;
}

/** Registers account, quota, and OAuth lifecycle routes. */
export function registerAccountRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: AccountRouteDependencies): T {
  const { services } = deps;
  return app
    .route("QUERY", "/providers/:id/accounts", async ({ params, query }) => {
      const providerId = await resolveProviderId(services, params.id);
      const limit = Number(query.limit) || 50;
      const cursor = typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : undefined;
      return await services.accounts.listPaged(providerId, { limit, cursor });
    })
    .post("/providers/:id/accounts", async ({ params, body, set }) => {
      const providerId = await resolveProviderId(services, params.id);
      const value = typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>), providerId } : { providerId };
      const result = await services.accounts.create(value);
      if (!("id" in result)) return badRequest(set, result.message);
      return result;
    })
    .post("/providers/:id/accounts/:accountId", async ({ params, body, set }) => {
      const record = await services.accounts.update(params.accountId, body);
      if (record === null) return notFound(set, "account not found");
      return record;
    })
    .delete("/providers/:id/accounts/:accountId", async ({ params, set }) => {
      if (!(await services.accounts.remove(params.accountId))) return notFound(set, "account not found");
      return ok();
    })
    .post("/providers/:id/accounts/batch-delete", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const raw = Array.isArray(value.ids) ? value.ids : undefined;
      if (raw === undefined) return badRequest(set, "ids array is required");
      const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length === 0) return badRequest(set, "at least one id is required");
      const deleted = await services.accounts.removeBatch(ids);
      return { ok: true, deleted };
    })
    .patch("/providers/:id/accounts/batch", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const raw = Array.isArray(value.ids) ? value.ids : undefined;
      if (raw === undefined) return badRequest(set, "ids array is required");
      const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length === 0) return badRequest(set, "at least one id is required");
      if (typeof value.active !== "boolean") return badRequest(set, "active boolean is required");
      const updated = await services.accounts.setActiveBatch(ids, value.active);
      return { ok: true, updated };
    })
    .patch("/accounts/:id", async ({ params, body, set }) => {
      const record = await services.accounts.update(params.id, body);
      if (record === null) return notFound(set);
      return record;
    })
    .delete("/accounts/:id", async ({ params, set }) => {
      if (!(await services.accounts.remove(params.id))) return notFound(set);
      return ok();
    })
    .route("QUERY", "/accounts/:id/credential", async ({ params, set }) => {
      const secret = await services.accounts.credential(params.id);
      if (secret === null) return notFound(set);
      return secret;
    })
    .post("/accounts/:id/quota/refresh", async ({ params, set }) => {
      const quota = await services.quota.refresh(params.id);
      if (quota === null) return notFound(set);
      return quota;
    })
    .post("/quota/refresh", async ({ body }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const rawIds = Array.isArray(value.accountIds) ? value.accountIds : [];
      const accountIds = rawIds.filter((id): id is string => typeof id === "string" && id.length > 0);
      return { ok: true, ...services.quota.enqueueRefresh(accountIds) };
    })
    .route("QUERY", "/accounts/:id/quota", async ({ params, set }) => {
      const quota = await services.quota.get(params.id);
      if (quota === null) return notFound(set);
      return quota;
    })
    .post("/providers/:id/oauth/start", async ({ params, body, set }) => {
      const value = typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>), providerId: params.id } : { providerId: params.id };
      const result = await services.oauth.start(value);
      if (!("sessionId" in result)) {
        set.status = result.status;
        return consoleError(result.code ?? "invalid_request", result.message);
      }
      return result;
    })
    .route("QUERY", "/oauth/sessions/:sessionId", async ({ params, set }) => {
      const session = await services.oauth.session(params.sessionId);
      if (session === null) return notFound(set, "OAuth login session not found");
      return session;
    })
    .post("/oauth/sessions/:sessionId/complete", async ({ params, body, set }) => {
      const result = await services.oauth.complete(params.sessionId, body);
      if (!("accountId" in result)) {
        set.status = result.status;
        return consoleError(result.code ?? "invalid_request", result.message);
      }
      return result;
    })
    .post("/oauth/sessions/:sessionId/cancel", async ({ params, set }) => {
      if (!(await services.oauth.cancel(params.sessionId))) return notFound(set, "OAuth login session not found");
      return ok();
    })
    .post("/oauth/refresh", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const result = await services.oauth.refreshAccount(typeof value.accountId === "string" ? value.accountId : "");
      if (!result.ok) {
        set.status = result.status;
        return consoleError(result.code ?? "invalid_request", result.message);
      }
      return result;
    })
    .post("/accounts/:id/revoke", async ({ params, set }) => {
      if (!(await services.oauth.revoke("", params.id))) return notFound(set, "account not found");
      return ok();
    })
    .post("/providers/:id/accounts/:accountId/revoke", async ({ params, set }) => {
      if (!(await services.oauth.revoke(params.id, params.accountId))) return notFound(set, "account not found");
      return ok();
    })
    .route("QUERY", "/accounts/:id/oauth-status", async ({ params, set }) => {
      const status = await services.oauth.accountStatus(params.id);
      if (status === null) return notFound(set, "account not found");
      return status;
    }) as unknown as T;
}

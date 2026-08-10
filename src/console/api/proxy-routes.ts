import { Elysia } from "elysia";
import { consoleError, type ConsoleServices } from "../services/composition";

export interface ProxyRouteDependencies {
  readonly services: ConsoleServices;
}

function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra };
}

function notFound(set: { status?: number | string }): ReturnType<typeof consoleError> {
  set.status = 404;
  return consoleError("not_found", "resource not found");
}

function badRequest(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 400;
  return consoleError("invalid_request", message);
}

/** Registers persisted proxy and proxy-settings routes. */
export function registerProxyRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: ProxyRouteDependencies): T {
  const { services } = deps;
  return app
    .route("QUERY", "/proxies", async ({ query }) => {
      const items = await services.proxies.list();
      const limit = typeof query.limit === "string" && Number.isFinite(Number(query.limit)) ? Math.min(Math.max(Number(query.limit), 1), 100) : 100;
      return { items: items.slice(0, limit) };
    })
    .post("/proxies", async ({ body, set }) => {
      const result = await services.proxies.create(body);
      if (!("id" in result)) return badRequest(set, result.message);
      return result;
    })
    .patch("/proxies/:id", async ({ params, body, set }) => {
      const record = await services.proxies.update(params.id, body);
      if (record === null) return notFound(set);
      return record;
    })
    .post("/proxies/:id/test", async ({ params, set }) => {
      const result = await services.proxies.test(params.id);
      if (result === null) return notFound(set);
      return result;
    })
    .post("/proxies/test", async ({ body }) => services.proxies.testAdHoc(body))
    .delete("/proxies/:id", async ({ params, set }) => {
      if (!(await services.proxies.remove(params.id))) return notFound(set);
      return ok();
    })
    .route("QUERY", "/proxies/:id/credential", async ({ params, set }) => {
      const secret = await services.proxies.credential(params.id);
      if (secret === null) return notFound(set);
      return secret;
    })
    .route("QUERY", "/proxy-settings", async () => services.proxies.getSettings())
    .post("/proxy-settings", async ({ body }) => services.proxies.patchSettings(body)) as unknown as T;
}

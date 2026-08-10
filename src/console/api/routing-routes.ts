import { Elysia } from "elysia";
import { consoleError, type ConsoleServices } from "../services/composition";

export interface RoutingRouteDependencies {
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

/** Registers aliases, combos, and request filter policy routes. */
export function registerRoutingRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: RoutingRouteDependencies): T {
  const { services } = deps;
  return app
    .route("QUERY", "/aliases", async () => ({ items: await services.routing.listAliases() }))
    .post("/aliases", async ({ body, set }) => {
      const result = await services.routing.createAlias(body);
      if (!("alias" in result)) return badRequest(set, result.message);
      return result;
    })
    .delete("/aliases/:alias", async ({ params, set }) => {
      if (!(await services.routing.deleteAlias(params.alias))) return notFound(set);
      return ok();
    })
    .route("QUERY", "/combos", async () => ({ items: await services.routing.listCombos() }))
    .post("/combos", async ({ body, set }) => {
      const result = await services.routing.putCombo(body);
      if (!("id" in result)) return badRequest(set, result.message);
      return result;
    })
    .patch("/combos/:id", async ({ params, body, set }) => {
      const result = await services.routing.putCombo(body, params.id);
      if (!("id" in result)) return badRequest(set, result.message);
      return result;
    })
    .delete("/combos/:id", async ({ params, set }) => {
      if (!(await services.routing.deleteCombo(params.id))) return notFound(set);
      return ok();
    })
    .route("QUERY", "/filters", async () => services.filterRules.list())
    .post("/filters", async ({ body, set }) => {
      const result = await services.filterRules.create(body);
      if (!("ruleId" in result)) { set.status = result.status; return consoleError(result.code, result.message); }
      set.status = 201;
      return result;
    })
    .patch("/filters/:id", async ({ params, body, set }) => {
      const id = Number(params.id);
      if (!Number.isFinite(id)) return badRequest(set, "invalid id");
      const result = await services.filterRules.update(id, body);
      if (!("ruleId" in result)) { set.status = result.status; return consoleError(result.code, result.message); }
      return result;
    })
    .delete("/filters/:id", async ({ params, set }) => {
      const id = Number(params.id);
      if (!Number.isFinite(id)) return badRequest(set, "invalid id");
      if (!(await services.filterRules.remove(id))) return notFound(set);
      return ok();
    }) as unknown as T;
}

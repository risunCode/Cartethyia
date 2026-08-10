import { Elysia } from "elysia";
import type { ConfigPersistence } from "../../storage";
import { createShareLink } from "../share";
import { consoleError, type ConsoleServices } from "../services/composition";

export interface ApiKeyRouteDependencies {
  readonly services: ConsoleServices;
  readonly config: ConfigPersistence;
}

function notFound(set: { status?: number | string }): ReturnType<typeof consoleError> {
  set.status = 404;
  return consoleError("not_found", "resource not found");
}

function conflict(set: { status?: number | string }, message: string): ReturnType<typeof consoleError> {
  set.status = 409;
  return consoleError("conflict", message);
}

/** Registers API key management and credential-link routes. */
export function registerApiKeyRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: ApiKeyRouteDependencies): T {
  const { services, config } = deps;
  return app
    .route("QUERY", "/keys", async () => ({ items: await services.keys.list() }))
    .post("/keys", async ({ body, set }) => {
      const result = await services.keys.create(body);
      if (!("key" in result)) return conflict(set, result.message);
      return { ...result.record, key: result.key, note: "store this key now; it will not be shown again" };
    })
    .patch("/keys/:id", async ({ params, body, set }) => {
      const record = await services.keys.update(params.id, body);
      if (record === null) return notFound(set);
      return record;
    })
    .post("/keys/:id/regenerate", async ({ params, set }) => {
      const result = await services.keys.regenerate(params.id);
      if (result === null) return notFound(set);
      return { ...result.record, key: result.key };
    })
    .post("/keys/:id/revoke", async ({ params, set }) => {
      if (!(await services.keys.revoke(params.id))) return notFound(set);
      return { ok: true };
    })
    .delete("/keys/:id", async ({ params, set }) => {
      if (!(await services.keys.remove(params.id))) return notFound(set);
      return { ok: true };
    })
    .route("QUERY", "/keys/:id/credential", async ({ params, set }) => {
      const secret = await services.keys.credential(params.id);
      if (secret === null) return notFound(set);
      return secret;
    })
    .post("/keys/:id/share", async ({ params, request, set }) => {
      const key = config.apiKeys.getById(params.id);
      if (key === null) return notFound(set);
      const link = await createShareLink(config, params.id, "monitor");
      return { url: new URL(link.urlPath, request.url).toString(), expiresAt: link.expiresAt };
    })
    .post("/keys/:id/setup-link", async ({ params, request, set }) => {
      const key = config.apiKeys.getById(params.id);
      if (key === null) return notFound(set);
      const link = await createShareLink(config, params.id, "setup");
      return { url: new URL(link.urlPath, request.url).toString(), expiresAt: link.expiresAt };
    })
    .delete("/keys/:id/share", async ({ params, set }) => {
      const key = config.apiKeys.getById(params.id);
      if (key === null) return notFound(set);
      let removed = 0;
      for (const link of config.shareLinks.listByApiKey(params.id)) {
        if (link.kind === "monitor" && link.active && config.shareLinks.patchActive(link.id, false)) removed += 1;
      }
      return { removed };
    }) as unknown as T;
}

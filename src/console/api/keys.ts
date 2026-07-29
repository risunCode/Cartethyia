/** Keys API — create (reveal once), list (prefix only), revoke. */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { createApiKey, listApiKeys, revokeApiKey, deleteApiKey, getApiKeyById } from "../db/repos/api-keys";

export const keysRoutes = new Elysia({ prefix: "/console/api" })
  .get("/keys", async () => ({ items: listApiKeys() }))
  .post("/keys", async ({ body, set }) => {
    const input = (body ?? {}) as {
      name?: string;
      rateLimitRpm?: number;
      dailyTokenLimit?: number;
      providerAllowlist?: string[];
      modelAllowlist?: string[];
    };
    if (typeof input.name !== "string" || input.name.trim().length < 2) {
      set.status = 400;
      return consoleError("invalid_request", "name must be at least 2 characters");
    }
    const created = createApiKey({ ...input, name: input.name.trim() });
    if ("error" in created) {
      set.status = 409;
      return consoleError("conflict", "a key with this name already exists");
    }
    addAuditEvent("key.created", { name: input.name, prefix: created.record.keyPrefix });
    set.status = 201;
    return { ...created.record, key: created.key, note: "store this key now; it is shown only once" };
  })
  .post("/keys/:id/revoke", async ({ params, set }) => {
    if (!revokeApiKey(params.id)) {
      set.status = 404;
      return consoleError("not_found", "key not found or already revoked");
    }
    addAuditEvent("key.revoked", { id: params.id });
    return { ok: true };
  })
  .delete("/keys/:id", async ({ params, set }) => {
    if (!deleteApiKey(params.id)) {
      set.status = 404;
      return consoleError("not_found", "key not found");
    }
    addAuditEvent("key.deleted", { id: params.id });
    return { ok: true };
  })
  .get("/keys/:id/credential", async ({ params, set }) => {
    const key = listApiKeys().find((k) => k.id === params.id);
    if (!key) {
      set.status = 404;
      return consoleError("not_found", "key not found");
    }
    const row = getApiKeyById(params.id);
    if (!row || !row.key) {
      set.status = 404;
      return consoleError("not_found", "key not found");
    }
    addAuditEvent("key.credential_revealed", { id: params.id, name: key.name });
    return { key: row.key };
  });

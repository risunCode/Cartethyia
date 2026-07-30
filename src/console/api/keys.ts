/** Keys API — create (reveal once), list (prefix only), update, revoke. */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { createApiKey, listApiKeys, revokeApiKey, deleteApiKey, getApiKeyById, updateApiKey } from "../db/repos/api-keys";

type KeyBody = {
  name?: string;
  rateLimitRpm?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  maxConcurrentRequests?: number | null;
  providerAllowlist?: string[] | null;
  modelAllowlist?: string[] | null;
  modelDenylist?: string[] | null;
};

function parseLimit(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function parseStringList(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

export const keysRoutes = new Elysia({ prefix: "/console/api" })
  .get("/keys", async () => ({ items: listApiKeys() }))
  .post("/keys", async ({ body, set }) => {
    const input = (body ?? {}) as KeyBody;
    if (typeof input.name !== "string" || input.name.trim().length < 2) {
      set.status = 400;
      return consoleError("invalid_request", "name must be at least 2 characters");
    }
    const rateLimitRpm = parseLimit(input.rateLimitRpm);
    const dailyTokenLimit = parseLimit(input.dailyTokenLimit);
    const monthlyTokenLimit = parseLimit(input.monthlyTokenLimit);
    const maxConcurrentRequests = parseLimit(input.maxConcurrentRequests);
    const providerAllowlist = parseStringList(input.providerAllowlist);
    const modelAllowlist = parseStringList(input.modelAllowlist);
    const modelDenylist = parseStringList(input.modelDenylist);
    if (
      input.rateLimitRpm !== undefined && rateLimitRpm === undefined ||
      input.dailyTokenLimit !== undefined && dailyTokenLimit === undefined ||
      input.monthlyTokenLimit !== undefined && monthlyTokenLimit === undefined ||
      input.maxConcurrentRequests !== undefined && maxConcurrentRequests === undefined ||
      input.providerAllowlist !== undefined && providerAllowlist === undefined ||
      input.modelAllowlist !== undefined && modelAllowlist === undefined ||
      input.modelDenylist !== undefined && modelDenylist === undefined
    ) {
      set.status = 400;
      return consoleError("invalid_request", "one or more limit or allowlist fields are invalid");
    }
    const created = createApiKey({
      name: input.name.trim(),
      rateLimitRpm: rateLimitRpm ?? undefined,
      dailyTokenLimit: dailyTokenLimit ?? undefined,
      monthlyTokenLimit: monthlyTokenLimit ?? undefined,
      maxConcurrentRequests: maxConcurrentRequests ?? undefined,
      providerAllowlist: providerAllowlist ?? undefined,
      modelAllowlist: modelAllowlist ?? undefined,
      modelDenylist: modelDenylist ?? undefined,
    });
    if ("error" in created) {
      set.status = 409;
      return consoleError("conflict", "a key with this name already exists");
    }
    addAuditEvent("key.created", { name: input.name, prefix: created.record.keyPrefix });
    set.status = 201;
    return { ...created.record, key: created.key, note: "store this key now; it is shown only once" };
  })
  .patch("/keys/:id", async ({ params, body, set }) => {
    const input = (body ?? {}) as KeyBody;
    const rateLimitRpm = parseLimit(input.rateLimitRpm);
    const dailyTokenLimit = parseLimit(input.dailyTokenLimit);
    const monthlyTokenLimit = parseLimit(input.monthlyTokenLimit);
    const maxConcurrentRequests = parseLimit(input.maxConcurrentRequests);
    const providerAllowlist = parseStringList(input.providerAllowlist);
    const modelAllowlist = parseStringList(input.modelAllowlist);
    const modelDenylist = parseStringList(input.modelDenylist);
    if (
      input.rateLimitRpm !== undefined && rateLimitRpm === undefined ||
      input.dailyTokenLimit !== undefined && dailyTokenLimit === undefined ||
      input.monthlyTokenLimit !== undefined && monthlyTokenLimit === undefined ||
      input.maxConcurrentRequests !== undefined && maxConcurrentRequests === undefined ||
      input.providerAllowlist !== undefined && providerAllowlist === undefined ||
      input.modelAllowlist !== undefined && modelAllowlist === undefined ||
      input.modelDenylist !== undefined && modelDenylist === undefined
    ) {
      set.status = 400;
      return consoleError("invalid_request", "one or more limit or allowlist fields are invalid");
    }
    const updated = updateApiKey(params.id, {
      rateLimitRpm,
      dailyTokenLimit,
      monthlyTokenLimit,
      maxConcurrentRequests,
      providerAllowlist,
      modelAllowlist,
      modelDenylist,
    });
    if (!updated) {
      set.status = 404;
      return consoleError("not_found", "key not found");
    }
    addAuditEvent("key.updated", { id: params.id, name: updated.name });
    return updated;
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

/** Keys API — create (reveal once), list (prefix only), update, revoke. */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { createApiKey, listApiKeys, regenerateApiKey, revokeApiKey, deleteApiKey, getApiKeyById, updateApiKey } from "../db/repos/api-keys";
import { sumDailyTokensForKey, sumAllTimeTokensForKey } from "../db/repos/usage";

type KeyBody = {
  name?: string;
  prefix?: string;
  rateLimitRpm?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  oneTimeTokenLimit?: number | null;
  maxConcurrentRequests?: number | null;
  providerAllowlist?: string[] | null;
  modelAllowlist?: string[] | null;
  modelDenylist?: string[] | null;
  quoteBigText?: string | null;
  quoteSubText?: string | null;
  quoteBody?: string | null;
  active?: boolean;
};

const MAX_RPM_LIMIT = 1_000_000;

function parseLimit(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const limit = Math.floor(value);
  return limit <= maximum ? limit : undefined;
}

function parseStringList(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function parseText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) return undefined;
  return value.trim();
}

export const keysRoutes = new Elysia({ prefix: "/console/api" })
  .get("/keys", async () => ({
    items: listApiKeys().map((key) => ({
      ...key,
      todayTokens: sumDailyTokensForKey(key.id),
      totalTokens: sumAllTimeTokensForKey(key.id),
      oneTimeTokensRemaining: key.oneTimeTokenLimit === null ? null : Math.max(0, key.oneTimeTokenLimit - key.oneTimeTokensUsed),
    })),
  }))
  .post("/keys", async ({ body, set }) => {
    const input = (body ?? {}) as KeyBody;
    if (typeof input.name !== "string" || input.name.trim().length < 2) {
      set.status = 400;
      return consoleError("invalid_request", "name must be at least 2 characters");
    }
    const rateLimitRpm = parseLimit(input.rateLimitRpm, MAX_RPM_LIMIT);
    const dailyTokenLimit = parseLimit(input.dailyTokenLimit);
    const monthlyTokenLimit = parseLimit(input.monthlyTokenLimit);
    const oneTimeTokenLimit = parseLimit(input.oneTimeTokenLimit);
    const maxConcurrentRequests = parseLimit(input.maxConcurrentRequests);
    const providerAllowlist = parseStringList(input.providerAllowlist);
    const modelAllowlist = parseStringList(input.modelAllowlist);
    const modelDenylist = parseStringList(input.modelDenylist);
    if (
      input.rateLimitRpm !== undefined && rateLimitRpm === undefined ||
      input.dailyTokenLimit !== undefined && dailyTokenLimit === undefined ||
      input.monthlyTokenLimit !== undefined && monthlyTokenLimit === undefined ||
      input.oneTimeTokenLimit !== undefined && oneTimeTokenLimit === undefined ||
      input.maxConcurrentRequests !== undefined && maxConcurrentRequests === undefined ||
      input.providerAllowlist !== undefined && providerAllowlist === undefined ||
      input.modelAllowlist !== undefined && modelAllowlist === undefined ||
      input.modelDenylist !== undefined && modelDenylist === undefined ||
      input.active !== undefined && typeof input.active !== "boolean"
    ) {
      set.status = 400;
      return consoleError("invalid_request", "one or more limit or allowlist fields are invalid");
    }
    const created = createApiKey({
      prefix: typeof input.prefix === "string" ? input.prefix : undefined,
      name: input.name.trim(),
      rateLimitRpm: rateLimitRpm ?? undefined,
      dailyTokenLimit: oneTimeTokenLimit ? undefined : dailyTokenLimit ?? undefined,
      monthlyTokenLimit: oneTimeTokenLimit ? undefined : monthlyTokenLimit ?? undefined,
      oneTimeTokenLimit: oneTimeTokenLimit ?? undefined,
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
    return { ...created.record, todayTokens: 0, totalTokens: 0, key: created.key, note: "store this key now; it is shown only once" };
  })
  .patch("/keys/:id", async ({ params, body, set }) => {
    const input = (body ?? {}) as KeyBody;
    const rateLimitRpm = parseLimit(input.rateLimitRpm, MAX_RPM_LIMIT);
    const dailyTokenLimit = parseLimit(input.dailyTokenLimit);
    const monthlyTokenLimit = parseLimit(input.monthlyTokenLimit);
    const oneTimeTokenLimit = parseLimit(input.oneTimeTokenLimit);
    const maxConcurrentRequests = parseLimit(input.maxConcurrentRequests);
    const providerAllowlist = parseStringList(input.providerAllowlist);
    const modelAllowlist = parseStringList(input.modelAllowlist);
    const modelDenylist = parseStringList(input.modelDenylist);
    const quoteBigText = parseText(input.quoteBigText, 160);
    const quoteSubText = parseText(input.quoteSubText, 240);
    const quoteBody = parseText(input.quoteBody, 2000);
    if (
      input.rateLimitRpm !== undefined && rateLimitRpm === undefined ||
      input.dailyTokenLimit !== undefined && dailyTokenLimit === undefined ||
      input.monthlyTokenLimit !== undefined && monthlyTokenLimit === undefined ||
      input.oneTimeTokenLimit !== undefined && oneTimeTokenLimit === undefined ||
      input.maxConcurrentRequests !== undefined && maxConcurrentRequests === undefined ||
      input.providerAllowlist !== undefined && providerAllowlist === undefined ||
      input.modelAllowlist !== undefined && modelAllowlist === undefined ||
      input.modelDenylist !== undefined && modelDenylist === undefined ||
      input.quoteBigText !== undefined && quoteBigText === undefined ||
      input.quoteSubText !== undefined && quoteSubText === undefined ||
      input.quoteBody !== undefined && quoteBody === undefined ||
      input.active !== undefined && typeof input.active !== "boolean"
    ) {
      set.status = 400;
      return consoleError("invalid_request", "one or more limit, allowlist, or quote fields are invalid");
    }
    const updated = updateApiKey(params.id, {
      rateLimitRpm,
      dailyTokenLimit: oneTimeTokenLimit ? null : dailyTokenLimit,
      monthlyTokenLimit: oneTimeTokenLimit ? null : monthlyTokenLimit,
      oneTimeTokenLimit,
      maxConcurrentRequests,
      providerAllowlist,
      modelAllowlist,
      modelDenylist,
      quoteBigText,
      quoteSubText,
      quoteBody,
      active: input.active,
    });
    if (!updated) {
      set.status = 404;
      return consoleError("not_found", "key not found");
    }
    addAuditEvent("key.updated", { id: params.id, name: updated.name });
    return updated;
  })
  .post("/keys/:id/regenerate", async ({ params, set }) => {
    const regenerated = regenerateApiKey(params.id);
    if (!regenerated) {
      set.status = 404;
      return consoleError("not_found", "key not found");
    }
    addAuditEvent("key.regenerated", { id: params.id, name: regenerated.record.name });
    return { ...regenerated.record, key: regenerated.key, note: "store this regenerated key now; it is shown only once" };
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

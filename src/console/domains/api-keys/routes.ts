// Console API-key domain: HTTP routes.
//
// Owns validation, CRUD operations, and route wiring through the ApiKeyStore.

import { Elysia, t } from "elysia";
import { randomBytes, randomUUID } from "node:crypto";
import { decryptCredentialToString, encryptCredential } from "../../../security/crypto";
import { hashShareToken } from "../../../persistence/share-store";
import type { AccessDecision } from "../../../security/access-control";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { API_KEY_MODES, type ShareLinkKind } from "../../../persistence/schema";
import type { ApiKeyConfig, ApiKeyResponse, UpdateApiKeyResponse } from "./contracts";
import type { ApiKeyPatch, ApiKeyRecord } from "../../../persistence/api-key-store";
import {
  generateApiKeySecret,
  sanitizeApiKeyResponse,
  validateApiKeyRequest,
  parseRequest,
  finitePositive,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  resolveKeyPrefix,
  prepareCustomKey,
  mapShareLinkResponse,
  type ShareKeyResponse,
  type ShareLinkResponse,
} from "./contracts";
import type { SharedKeyActivityDetail, SharedKeySummary } from "../../share/share-usage";

export function createApiKeyOperations(config: ApiKeyConfig) {
  const operations = {
    async listKeys(access: AccessDecision | undefined): Promise<ApiKeyResponse[]> {
        const authorized = requireTenantScope(access, "dashboard:read");
        const records = await config.store.list(authorized.tenantId);
        return records
          .filter((record) => record.revokedAt === undefined && record.parentKeyId === undefined)
          .map(sanitizeApiKeyResponse);
      },
    async getKeyDetail(access: AccessDecision | undefined, keyId: string): Promise<ApiKeyResponse> {
        const authorized = requireTenantScope(access, "dashboard:read");
        const record = await config.store.get(authorized.tenantId, keyId);
        if (!record) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
        return sanitizeApiKeyResponse(record);
      },
    async createKey(
      access: AccessDecision | undefined,
      request: CreateApiKeyRequest,
    ): Promise<CreateApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const scopes = validateApiKeyRequest(request);
      const keyMode = request.keyMode ?? "personal";
      const generated =
        keyMode === "personal"
          ? request.key === undefined
            ? generateApiKeySecret(request.keyPrefix)
            : { ...prepareCustomKey(request.key), prefix: resolveKeyPrefix(request.keyPrefix) }
          : undefined;
      const record: ApiKeyRecord = {
        id: randomUUID(),
        tenantId: authorized.tenantId,
        keyHash: generated?.hash ?? null,
        keyMode,
        label: request.label?.trim() || (keyMode === "share" ? "Share template" : "API key"),
        scopes,
        keyPrefix: generated?.prefix ?? resolveKeyPrefix(request.keyPrefix),
        ...(generated ? { keyEncrypted: encryptCredential(generated.secret) } : {}),
        ...(request.notesTitle === undefined ? {} : { notesTitle: request.notesTitle }),
        ...(request.notesSubtitle === undefined ? {} : { notesSubtitle: request.notesSubtitle }),
        ...(request.notesBody === undefined ? {} : { notesBody: request.notesBody }),
        ...(request.requestsPerMinute == null ? {} : { requestsPerMinute: request.requestsPerMinute }),
        ...(request.dailyTokenLimit == null ? {} : { dailyTokenLimit: request.dailyTokenLimit }),
        ...(request.monthlyTokenLimit == null ? {} : { monthlyTokenLimit: request.monthlyTokenLimit }),
        ...(request.lifetimeTokenBudget == null ? {} : { lifetimeTokenBudget: request.lifetimeTokenBudget }),
        ...(request.maxConcurrentRequests == null ? {} : { maxConcurrentRequests: request.maxConcurrentRequests }),
        ...(request.modelPrefix === undefined ? {} : { modelPrefix: request.modelPrefix }),
        ...(request.providerAllowlist === undefined ? {} : { providerAllowlist: request.providerAllowlist }),
        ...(request.modelAllowlist === undefined ? {} : { modelAllowlist: request.modelAllowlist }),
        ...(request.modelDenylist === undefined ? {} : { modelDenylist: request.modelDenylist }),
        createdAt: new Date(),
        tokensConsumed: 0,
      };
      await config.store.create(record);
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.created",
        target: record.id,
        detail: { scopes, keyMode },
      });
      return {
        ...sanitizeApiKeyResponse(record),
        ...(generated ? { secret: generated.secret } : {}),
      };
    },
    async updateKey(
      access: AccessDecision | undefined,
      keyId: string,
      request: Partial<CreateApiKeyRequest>,
    ): Promise<UpdateApiKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const patchRequest = parseRequest(request);
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "shared_key_managed_by_parent",
          409,
          "Edit or revoke this key through its share parent",
        );

      validateApiKeyRequest(patchRequest);
      finitePositive(patchRequest.requestsPerMinute, "requestsPerMinute");
      finitePositive(patchRequest.dailyTokenLimit, "dailyTokenLimit");
      finitePositive(patchRequest.monthlyTokenLimit, "monthlyTokenLimit");
      finitePositive(patchRequest.lifetimeTokenBudget, "lifetimeTokenBudget");
      finitePositive(patchRequest.maxConcurrentRequests, "maxConcurrentRequests");

      const nextMode = patchRequest.keyMode ?? current.keyMode;
      const modeChanged = nextMode !== current.keyMode;
      const nextPrefix = resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix);
      const prefixChanged =
        patchRequest.keyPrefix !== undefined &&
        nextPrefix !== resolveKeyPrefix(current.keyPrefix);

      let secret: string | undefined;
      let credentialPatch: ApiKeyPatch = {};
      if (modeChanged && nextMode === "share") {
        credentialPatch = {
          keyMode: "share",
          keyHash: null,
          keyEncrypted: null,
          keyPrefix: resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix),
        };
      } else if (
        nextMode === "personal" &&
        (modeChanged || patchRequest.key !== undefined || prefixChanged)
      ) {
        const generated = patchRequest.key === undefined
          ? generateApiKeySecret(resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix))
          : {
              ...prepareCustomKey(patchRequest.key),
              prefix: resolveKeyPrefix(patchRequest.keyPrefix ?? current.keyPrefix),
            };
        secret = generated.secret;
        credentialPatch = {
          ...(modeChanged ? { keyMode: "personal" as const } : {}),
          keyHash: generated.hash,
          keyEncrypted: encryptCredential(generated.secret),
          keyPrefix: generated.prefix,
        };
      } else if (patchRequest.keyPrefix !== undefined && nextMode === "share") {
        credentialPatch = { keyPrefix: resolveKeyPrefix(patchRequest.keyPrefix) };
      }

      const scopes =
        patchRequest.scopes === undefined ? undefined : validateApiKeyRequest(patchRequest);
      const updated = await config.store.update(authorized.tenantId, keyId, {
        ...credentialPatch,
        ...(patchRequest.keyMode === undefined ? {} : { keyMode: nextMode }),
        ...(patchRequest.label === undefined ? {} : { label: patchRequest.label.trim() }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(patchRequest.notesTitle === undefined
          ? {}
          : { notesTitle: patchRequest.notesTitle.trim() === "" ? null : patchRequest.notesTitle }),
        ...(patchRequest.notesSubtitle === undefined
          ? {}
          : { notesSubtitle: patchRequest.notesSubtitle.trim() === "" ? null : patchRequest.notesSubtitle }),
        ...(patchRequest.notesBody === undefined
          ? {}
          : { notesBody: patchRequest.notesBody.trim() === "" ? null : patchRequest.notesBody }),
        ...(patchRequest.requestsPerMinute === undefined ? {} : { requestsPerMinute: patchRequest.requestsPerMinute }),
        ...(patchRequest.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: patchRequest.dailyTokenLimit }),
        ...(patchRequest.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: patchRequest.monthlyTokenLimit }),
        ...(patchRequest.lifetimeTokenBudget === undefined ? {} : { lifetimeTokenBudget: patchRequest.lifetimeTokenBudget }),
        ...(patchRequest.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: patchRequest.maxConcurrentRequests }),
        ...(patchRequest.modelPrefix === undefined ? {} : { modelPrefix: patchRequest.modelPrefix }),
        ...(patchRequest.providerAllowlist === undefined ? {} : { providerAllowlist: patchRequest.providerAllowlist }),
        ...(patchRequest.modelAllowlist === undefined ? {} : { modelAllowlist: patchRequest.modelAllowlist }),
        ...(patchRequest.modelDenylist === undefined ? {} : { modelDenylist: patchRequest.modelDenylist }),
      });
      if (!updated) throw new ConsoleDomainError("key_not_found", 404, "Key not found");

      if (modeChanged || secret !== undefined) {
        const children = await config.store.listChildren(authorized.tenantId, keyId);
        await Promise.all([
          config.admissionService.purgeKey(keyId),
          ...children.map((child) => config.admissionService.purgeKey(child.id)),
        ]);
      }
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.updated",
        target: keyId,
        detail: { fields: Object.keys(request) },
      });
      return { ...sanitizeApiKeyResponse(updated), ...(secret === undefined ? {} : { secret }) };
    },
    async revokeKey(access: AccessDecision | undefined, keyId: string): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const revoked = await config.store.revoke(authorized.tenantId, keyId, new Date());
      if (!revoked) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      const children = await config.store.listChildren(authorized.tenantId, keyId);
      await Promise.all([
        config.admissionService.purgeKey(keyId),
        ...children.map((child) => config.admissionService.purgeKey(child.id)),
      ]);
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.revoked",
        target: keyId,
      });
      return { success: true };
    },
    /**
     * Establishes or rotates the key's single stable link.
     *
     * The console shows one link that never moves; `regenerate` replaces the
     * token in place so the previous URL stops resolving. A share template
     * hands out child keys; a personal key hands out the key itself.
     */
    async shareKey(
      access: AccessDecision | undefined,
      keyId: string,
      options: { expiresAt?: string | null; origin?: string; regenerate?: boolean } = {},
    ): Promise<ShareKeyResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "key_not_share_parent",
          409,
          "Only a top-level key can carry a handoff link",
        );
      const kind: ShareLinkKind = record.keyMode === "share" ? "enroll" : "handoff";
      const origin = (options.origin ?? "").replace(/\/$/, "");
      // Re-issuing without regeneration must return the link that is actually
      // stored. Minting a fresh token here would hand back a URL that was never
      // persisted, so the link would be dead on arrival.
      if (options.regenerate !== true) {
        const existing = await shareStore.findTokenForApiKey(keyId);
        if (existing !== null && existing.tokenEncrypted !== null) {
          try {
            const token = decryptCredentialToString(existing.tokenEncrypted);
            return {
              id: existing.id,
              url: `${origin}/share/${token}`,
              token,
              kind: existing.kind,
              expiresAt: existing.expiresAt === null ? null : existing.expiresAt.toISOString(),
            };
          } catch {
            // A row written under a different encryption key cannot be shown;
            // fall through and establish a fresh link.
          }
        }
      }
      let expiresAt: Date | null = null;
      if (options.expiresAt !== undefined && options.expiresAt !== null) {
        const parsed = new Date(options.expiresAt);
        if (Number.isNaN(parsed.getTime()))
          throw new ConsoleDomainError(
            "invalid_share_expiry",
            400,
            "expiresAt must be a valid ISO timestamp",
          );
        expiresAt = parsed;
      }
      const token = randomBytes(32).toString("base64url");
      const link = await shareStore.create({
        apiKeyId: keyId,
        tokenHash: hashShareToken(token),
        tokenEncrypted: encryptCredential(token),
        kind,
        expiresAt,
        rotate: options.regenerate === true,
      });
      await config.auditSink?.record({
        access: authorized,
        action: options.regenerate === true ? "api_key.share_regenerated" : "api_key.shared",
        target: keyId,
        detail: { shareId: link.id, kind },
      });
      return {
        id: link.id,
        url: `${origin}/share/${token}`,
        token,
        kind: link.kind,
        expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
      };
    },
    /**
     * The key's stable link with its retained token, for the console to show
     * without rotating it. Returns null when the key has no link yet or the
     * link predates token retention.
     */
    async getShare(
      access: AccessDecision | undefined,
      keyId: string,
      options: { origin?: string } = {},
    ): Promise<ShareKeyResponse | null> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (record.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "key_not_share_parent",
          409,
          "Only a top-level key can carry a handoff link",
        );
      const link = await shareStore.findTokenForApiKey(keyId);
      if (link === null || link.tokenEncrypted === null) return null;
      let token: string;
      try {
        token = decryptCredentialToString(link.tokenEncrypted);
      } catch {
        // A row written under a different key cannot be shown; the operator
        // regenerates to establish a fresh link.
        return null;
      }
      const origin = (options.origin ?? "").replace(/\/$/, "");
      return {
        id: link.id,
        url: `${origin}/share/${token}`,
        token,
        kind: link.kind,
        expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
      };
    },
    /**
     * Rotates a personal key's credential in place and re-points its handoff
     * link at the new secret. Share templates have no credential of their own,
     * so they are rejected here.
     */
    async regenerateKey(
      access: AccessDecision | undefined,
      keyId: string,
      options: { origin?: string } = {},
    ): Promise<{ secret: string; share: ShareKeyResponse | null }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const current = await config.store.get(authorized.tenantId, keyId);
      if (!current || current.revokedAt !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      if (current.parentKeyId !== undefined)
        throw new ConsoleDomainError(
          "shared_key_managed_by_parent",
          409,
          "Edit or revoke this key through its share parent",
        );
      if (current.keyMode !== "personal")
        throw new ConsoleDomainError(
          "key_not_personal",
          409,
          "Only a personal key can be regenerated; rotate a share template's link instead",
        );
      const generated = generateApiKeySecret(current.keyPrefix ?? undefined);
      const updated = await config.store.update(authorized.tenantId, keyId, {
        keyHash: generated.hash,
        keyEncrypted: encryptCredential(generated.secret),
        keyPrefix: generated.prefix,
      });
      if (!updated) throw new ConsoleDomainError("key_not_found", 404, "Key not found");
      await config.admissionService.purgeKey(keyId);
      const shareStore = config.shareStore;
      let share: ShareKeyResponse | null = null;
      if (shareStore) {
        const token = randomBytes(32).toString("base64url");
        const link = await shareStore.create({
          apiKeyId: keyId,
          tokenHash: hashShareToken(token),
          tokenEncrypted: encryptCredential(token),
          kind: "handoff",
          expiresAt: null,
          rotate: true,
        });
        const origin = (options.origin ?? "").replace(/\/$/, "");
        share = {
          id: link.id,
          url: `${origin}/share/${token}`,
          token,
          kind: link.kind,
          expiresAt: null,
        };
      }
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.regenerated",
        target: keyId,
      });
      return { secret: generated.secret, share };
    },
    async listShares(
      access: AccessDecision | undefined,
      keyId: string,
    ): Promise<ShareLinkResponse[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      if (!config.shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.keyMode !== "share" || record.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      return (await config.shareStore.listForApiKey(keyId)).map(mapShareLinkResponse);
    },
    async listSharedKeys(
      access: AccessDecision | undefined,
      parentKeyId: string,
    ): Promise<readonly SharedKeySummary[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const activity = config.shareActivity;
      if (!activity)
        throw new ConsoleDomainError("capability_unsupported", 501, "share telemetry not configured");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.revokedAt !== undefined ||
          parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const children = await config.store.listChildren(authorized.tenantId, parentKeyId);
      return activity.getSharedKeySummaries(authorized.tenantId, children);
    },
    async getSharedKeyActivity(
      access: AccessDecision | undefined,
      parentKeyId: string,
      childKeyId: string,
    ): Promise<SharedKeyActivityDetail> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const activity = config.shareActivity;
      if (!activity)
        throw new ConsoleDomainError("capability_unsupported", 501, "share telemetry not configured");
      const parent = await config.store.get(authorized.tenantId, parentKeyId);
      if (!parent || parent.revokedAt !== undefined ||
          parent.keyMode !== "share" || parent.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const children = await config.store.listChildren(authorized.tenantId, parentKeyId);
      if (!children.some((child) => child.id === childKeyId))
        throw new ConsoleDomainError("key_not_found", 404, "Shared API key not found");
      return activity.getSharedKeyDetail(authorized.tenantId, childKeyId);
    },
    async revokeShare(
      access: AccessDecision | undefined,
      keyId: string,
      shareId: string,
    ): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const shareStore = config.shareStore;
      if (!shareStore)
        throw new ConsoleDomainError("capability_unsupported", 501, "key share not configured");
      const record = await config.store.get(authorized.tenantId, keyId);
      if (!record || record.keyMode !== "share" || record.parentKeyId !== undefined)
        throw new ConsoleDomainError("key_not_found", 404, "Share template not found");
      const revoked = await shareStore.revoke(keyId, shareId);
      if (!revoked) throw new ConsoleDomainError("share_not_found", 404, "Share link not found");
      await config.auditSink?.record({
        access: authorized,
        action: "api_key.share_revoked",
        target: shareId,
        detail: { keyId },
      });
      return { success: true };
    },
  };
  return operations;
}

const apiKeyBody = t.Object({
  label: t.Optional(t.String()),
  keyMode: t.Optional(literalUnion(API_KEY_MODES)),
  scopes: t.Optional(t.Array(t.String())),
  keyPrefix: t.Optional(t.String()),
  key: t.Optional(t.String()),
  // Limit fields accept `null` to clear a previously set limit ("unlimited");
  // `undefined` leaves it unchanged.
  requestsPerMinute: t.Optional(t.Union([t.Number(), t.Null()])),
  dailyTokenLimit: t.Optional(t.Union([t.Number(), t.Null()])),
  monthlyTokenLimit: t.Optional(t.Union([t.Number(), t.Null()])),
  lifetimeTokenBudget: t.Optional(t.Union([t.Number(), t.Null()])),
  maxConcurrentRequests: t.Optional(t.Union([t.Number(), t.Null()])),
  modelPrefix: t.Optional(t.String()),
  providerAllowlist: t.Optional(t.Array(t.String())),
  modelAllowlist: t.Optional(t.Array(t.String())),
  modelDenylist: t.Optional(t.Array(t.String())),
  notesTitle: t.Optional(t.String()),
  notesSubtitle: t.Optional(t.String()),
  notesBody: t.Optional(t.String()),
});

const apiKeyShareBody = t.Object({
  expiresAt: t.Optional(t.Union([t.String(), t.Null()])),
  /** Replaces the existing link's token so the previous URL stops resolving. */
  regenerate: t.Optional(t.Boolean()),
});
/** Creates tenant-bound API-key routes with request-local authorization. */
export function createApiKeyRoutes(config: ApiKeyConfig): Elysia {
  const factory = createApiKeyOperations(config);
  return new Elysia({ prefix: "/api-keys" })
    .get("/", async ({ request, set }) => {
      try {
        return await factory.listKeys(config.accessResolver(request));
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId", async ({ request, params, set }) => {
      try {
        return await factory.getKeyDetail(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/shares", async ({ request, params, set }) => {
      try {
        return await factory.listShares(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/shared-keys", async ({ request, params, set }) => {
      try {
        return await factory.listSharedKeys(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/shared-keys/:childKeyId/activity", async ({ request, params, set }) => {
      try {
        return await factory.getSharedKeyActivity(
          config.accessResolver(request),
          params.keyId,
          params.childKeyId,
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .delete("/:keyId/shares/:shareId", async ({ request, params, set }) => {
      try {
        return await factory.revokeShare(
          config.accessResolver(request),
          params.keyId,
          params.shareId,
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/", { body: apiKeyBody }, async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await factory.createKey(config.accessResolver(request), parseRequest(body));
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .patch("/:keyId", { body: apiKeyBody }, async ({ request, params, body, set }) => {
      try {
        return await factory.updateKey(
          config.accessResolver(request),
          params.keyId,
          parseRequest(body),
        );
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .delete("/:keyId", async ({ request, params, set }) => {
      try {
        return await factory.revokeKey(config.accessResolver(request), params.keyId);
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .get("/:keyId/share", async ({ request, params, set }) => {
      try {
        return await factory.getShare(config.accessResolver(request), params.keyId, {
          origin: new URL(request.url).origin,
        });
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/:keyId/share", { body: t.Optional(apiKeyShareBody) }, async ({ request, params, body, set }) => {
      try {
        set.status = 201;
        const input = (body ?? {}) as { expiresAt?: string | null; regenerate?: boolean };
        return await factory.shareKey(config.accessResolver(request), params.keyId, {
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.regenerate === undefined ? {} : { regenerate: input.regenerate }),
          origin: new URL(request.url).origin,
        });
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    })
    .post("/:keyId/regenerate", async ({ request, params, set }) => {
      try {
        return await factory.regenerateKey(config.accessResolver(request), params.keyId, {
          origin: new URL(request.url).origin,
        });
      } catch (error) {
        return errorResponse(error, set, "API-key operation failed");
      }
    }) as unknown as Elysia;
}

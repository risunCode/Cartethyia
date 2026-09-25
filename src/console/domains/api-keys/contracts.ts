// Console API-key domain contracts: request/response shapes and pure helpers.
//
// Single source for key creation validation and response sanitization;
// routes consume it, they do not redeclare it.

import type { AuditSink } from "../audit/contracts";
import { randomBytes } from "node:crypto";
import type { ApiKeyRecord, ApiKeyStore } from "../../../persistence/api-key-store";
import { hashSecret } from "../../../security/crypto";
import { type ShareLinkStore, type ShareLinkSummary } from "../../../persistence/share-store";
import { API_KEY_MODES, type ApiKeyMode, type ShareLinkKind } from "../../../persistence/schema";
import { isValidTenantKeyScope, type AccessScope } from "../../../security/access-control";
import type { ShareActivityPort } from "../../share/share-usage";
import { ConsoleDomainError } from "../../shared/errors";
import type { ConsoleAccessResolver } from "../../auth/access";
import type { ApiKeyAdmissionService } from "../../../security/admission";
export type {
  SharedKeySummary,
  SharedKeyActivityDetail,
} from "../../share/share-usage";
/** Input accepted when creating or editing a key. Null limits mean unlimited. */
export interface CreateApiKeyRequest {
  label?: string;
  keyMode?: ApiKeyMode;
  scopes?: readonly string[];
  /** Public leading fragment used for generated keys; defaults to `rk_`. */
  keyPrefix?: string;
  /** Owner-supplied raw key value; valid only for personal keys. */
  key?: string;
  requestsPerMinute?: number | null;
  dailyTokenLimit?: number | null;
  monthlyTokenLimit?: number | null;
  lifetimeTokenBudget?: number | null;
  maxConcurrentRequests?: number | null;
  modelPrefix?: string;
  providerAllowlist?: readonly string[];
  modelAllowlist?: readonly string[];
  modelDenylist?: readonly string[];
  notesTitle?: string;
  notesSubtitle?: string;
  notesBody?: string;
}

/** Public key representation; it never contains a secret, hash, or IP-key digest. */
export interface ApiKeyResponse {
  readonly id: string;
  readonly label: string;
  readonly keyMode: ApiKeyMode;
  readonly scopes: readonly AccessScope[];
  readonly keyPrefix?: string;
  readonly parentKeyId?: string;
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly modelPrefix?: string;
  readonly providerAllowlist?: readonly string[];
  readonly modelAllowlist?: readonly string[];
  readonly modelDenylist?: readonly string[];
  readonly maxConcurrentRequests?: number;
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
  readonly tokensConsumed: number;
}
/** Creation result; plaintext is returned only when a personal key is minted. */
export interface CreateApiKeyResponse extends ApiKeyResponse {
  readonly secret?: string;
}

/** Edit result carries one new secret on personal rotation or template conversion. */
export interface UpdateApiKeyResponse extends ApiKeyResponse {
  readonly secret?: string;
}

/** API-key route dependency boundary. */
export interface ApiKeyConfig {
  readonly store: ApiKeyStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  readonly shareStore?: ShareLinkStore;
  readonly shareActivity?: ShareActivityPort;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey">;
}

/** Result of minting a share link. The bearer token is returned exactly once. */
export interface ShareKeyResponse {
  readonly id: string;
  readonly url: string;
  readonly token: string;
  readonly kind: ShareLinkKind;
  readonly expiresAt: string | null;
}

/** One share link as shown in the owner's console list. Never carries the token. */
export interface ShareLinkResponse {
  readonly id: string;
  readonly kind: ShareLinkKind;
  readonly active: boolean;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastViewedAt: string | null;
}

/** Default public prefix for generated keys, matching the console form hint. */
export const DEFAULT_API_KEY_PREFIX = "rk_";

/** Label of the default gateway API key seeded at first boot; never revoked. */
export const DEFAULT_API_KEY_LABEL = "Default Cartethyia API key";

/** Generates an inbound key and its one-way hash. */
export function generateApiKeySecret(prefix = DEFAULT_API_KEY_PREFIX): {
  secret: string;
  hash: string;
  prefix: string;
} {
  const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashSecret(secret), prefix };
}

/** Normalizes a caller-supplied prefix; falls back to the default. */
export function resolveKeyPrefix(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_API_KEY_PREFIX;
}

/** Hashes an owner-supplied personal key; persistence encrypts it for Studio handoff. */
export function prepareCustomKey(secret: string): { secret: string; hash: string } {
  if (secret.trim().length === 0) {
    throw new ConsoleDomainError("invalid_key", 400, "Custom key must be a non-empty string");
  }
  return { secret, hash: hashSecret(secret) };
}

export function finitePositive(value: number | null | undefined, name: string): void {
  // `null` explicitly clears a previously set limit; `undefined` leaves it
  // unchanged. Only a real non-null number must be finite and positive.
  if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 1)) {
    throw new ConsoleDomainError("invalid_limits", 400, `${name} must be a finite positive number`);
  }
}

/** Validates scopes and quota fields before persistence. */
export function validateApiKeyRequest(request: CreateApiKeyRequest): readonly AccessScope[] {
  const keyMode = request.keyMode ?? "personal";
  if (!(API_KEY_MODES as readonly string[]).includes(keyMode)) {
    throw new ConsoleDomainError("invalid_key_mode", 400, "keyMode must be personal or share");
  }
  if (keyMode === "share" && request.key !== undefined) {
    throw new ConsoleDomainError("invalid_key_mode", 400, "Share templates cannot carry a personal key");
  }
  const scopes = request.scopes ?? ["routing:invoke"];
  for (const scope of scopes) {
    if (!isValidTenantKeyScope(scope as AccessScope)) {
      throw new ConsoleDomainError("invalid_scope", 400, `Scope is not allowed: ${scope}`);
    }
  }
  finitePositive(request.requestsPerMinute, "requestsPerMinute");
  finitePositive(request.dailyTokenLimit, "dailyTokenLimit");
  finitePositive(request.monthlyTokenLimit, "monthlyTokenLimit");
  finitePositive(request.lifetimeTokenBudget, "lifetimeTokenBudget");
  finitePositive(request.maxConcurrentRequests, "maxConcurrentRequests");
  if (
    request.modelPrefix !== undefined &&
    (typeof request.modelPrefix !== "string" || request.modelPrefix.trim().length === 0)
  ) {
    throw new ConsoleDomainError(
      "invalid_model_prefix",
      400,
      "modelPrefix must be a non-empty string if provided",
    );
  }
  if (
    request.keyPrefix !== undefined &&
    (typeof request.keyPrefix !== "string" || request.keyPrefix.trim().length === 0)
  ) {
    throw new ConsoleDomainError(
      "invalid_key_prefix",
      400,
      "keyPrefix must be a non-empty string if provided",
    );
  }
  return scopes as AccessScope[];
}

/** Serializes a persisted record without credential material or IP-key digests. */
export function sanitizeApiKeyResponse(record: ApiKeyRecord): ApiKeyResponse {
  return {
    id: record.id,
    label: record.label,
    keyMode: record.keyMode,
    scopes: record.scopes,
    ...(record.keyPrefix === undefined ? {} : { keyPrefix: record.keyPrefix }),
    ...(record.parentKeyId === undefined ? {} : { parentKeyId: record.parentKeyId }),
    ...(record.notesTitle === undefined ? {} : { notesTitle: record.notesTitle }),
    ...(record.notesSubtitle === undefined ? {} : { notesSubtitle: record.notesSubtitle }),
    ...(record.notesBody === undefined ? {} : { notesBody: record.notesBody }),
    ...(record.requestsPerMinute === undefined ? {} : { requestsPerMinute: record.requestsPerMinute }),
    ...(record.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: record.dailyTokenLimit }),
    ...(record.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: record.monthlyTokenLimit }),
    ...(record.lifetimeTokenBudget === undefined ? {} : { lifetimeTokenBudget: record.lifetimeTokenBudget }),
    ...(record.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: record.maxConcurrentRequests }),
    ...(record.modelPrefix === undefined ? {} : { modelPrefix: record.modelPrefix }),
    ...(record.providerAllowlist === undefined ? {} : { providerAllowlist: record.providerAllowlist }),
    ...(record.modelAllowlist === undefined ? {} : { modelAllowlist: record.modelAllowlist }),
    ...(record.modelDenylist === undefined ? {} : { modelDenylist: record.modelDenylist }),
    createdAt: record.createdAt.toISOString(),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt.toISOString() }),
    tokensConsumed: record.tokensConsumed,
  };
}

export function parseRequest(value: unknown): CreateApiKeyRequest {
  if (typeof value !== "object" || value === null)
    throw new ConsoleDomainError("invalid_request", 400, "Request body must be an object");
  return value as CreateApiKeyRequest;
}

/** Maps a persisted share link to the console response (ISO timestamps, no token). */
export function mapShareLinkResponse(link: ShareLinkSummary): ShareLinkResponse {
  return {
    id: link.id,
    kind: link.kind,
    active: link.active,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt === null ? null : link.expiresAt.toISOString(),
    lastViewedAt: link.lastViewedAt === null ? null : link.lastViewedAt.toISOString(),
  };
}


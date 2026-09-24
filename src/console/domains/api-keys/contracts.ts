// Console API-key domain contracts: request/response shapes and pure helpers.
//
// Single source for key creation validation and response sanitization;
// routes consume it, they do not redeclare it.

import type { AuditSink } from "../audit/contracts";
import { randomBytes } from "node:crypto";
import type { ApiKeyRecord, ApiKeyStore } from "../../../persistence/api-key-store";
import { hashSecret } from "../../../security/crypto";
import { type ShareLinkStore, type ShareLinkSummary } from "../../../persistence/share-store";
import type { ShareLinkKind } from "../../../persistence/schema";
import { isValidTenantKeyScope, type AccessScope } from "../../../security/access-control";
import { ConsoleDomainError } from "../../shared/errors";
import type { ConsoleAccessResolver } from "../../auth/access";
import type { ApiKeyAdmissionService } from "../../../security/admission";
/** Input accepted when creating an API key. `null` on a limit clears it (unlimited). */
export interface CreateApiKeyRequest {
  label?: string;
  scopes?: readonly string[];
  /** Public leading fragment of the generated key; defaults to `rk_`. */
  keyPrefix?: string;
  /** Owner-supplied raw key value; when omitted a secret is generated. */
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

/** Public key representation; it never contains a secret or hash. */
export interface ApiKeyResponse {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly AccessScope[];
  readonly keyPrefix?: string;
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

/** Creation result; plaintext secret is returned only by create. */
export interface CreateApiKeyResponse extends ApiKeyResponse {
  readonly secret: string;
}

/** Records privileged API-key mutations to `admin_audit_log`. */
/** API-key route dependency boundary. */
export interface ApiKeyConfig {
  readonly store: ApiKeyStore;
  readonly accessResolver: ConsoleAccessResolver;
  /** Records privileged mutations to `admin_audit_log`; a no-op when omitted (e.g. tests). */
  readonly auditSink?: AuditSink;
  /** Share-link persistence; share routes report 501 when omitted. */
  readonly shareStore?: ShareLinkStore;
  /** Admission-state purge on revocation; required so a recycled key id never inherits history. */
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
  readonly usedAt: string | null;
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

/** Hashes and encrypts an owner-supplied raw key so it can be shared later. */
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

/** Serializes a persisted record without credential material or undefined keys. */
export function sanitizeApiKeyResponse(record: ApiKeyRecord): ApiKeyResponse {
  return {
    id: record.id,
    label: record.label,
    scopes: record.scopes,
    ...(record.keyPrefix === undefined ? {} : { keyPrefix: record.keyPrefix }),
    ...(record.notesTitle === undefined ? {} : { notesTitle: record.notesTitle }),
    ...(record.notesSubtitle === undefined ? {} : { notesSubtitle: record.notesSubtitle }),
    ...(record.notesBody === undefined ? {} : { notesBody: record.notesBody }),
    ...(record.requestsPerMinute === undefined
      ? {}
      : { requestsPerMinute: record.requestsPerMinute }),
    ...(record.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: record.dailyTokenLimit }),
    ...(record.monthlyTokenLimit === undefined
      ? {}
      : { monthlyTokenLimit: record.monthlyTokenLimit }),
    ...(record.lifetimeTokenBudget === undefined
      ? {}
      : { lifetimeTokenBudget: record.lifetimeTokenBudget }),
    ...(record.maxConcurrentRequests === undefined
      ? {}
      : { maxConcurrentRequests: record.maxConcurrentRequests }),
    ...(record.modelPrefix === undefined ? {} : { modelPrefix: record.modelPrefix }),
    ...(record.providerAllowlist === undefined
      ? {}
      : { providerAllowlist: record.providerAllowlist }),
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
    usedAt: link.usedAt === null ? null : link.usedAt.toISOString(),
    lastViewedAt: link.lastViewedAt === null ? null : link.lastViewedAt.toISOString(),
  };
}


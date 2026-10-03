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
import { normalizeClientRouterId } from "../../../security/client-router-fingerprint";
import type { ShareActivityPort } from "../../share/share-usage";
import { ConsoleDomainError } from "../../shared/errors";
import type { ConsoleAccessResolver } from "../../auth/access";
import type { ApiKeyAdmissionService } from "../../../security/admission/service";
import {
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
  sniffSharePopupImageMime,
  type SharePopupImageMime,
} from "./share-popup-image";

// Re-exported so consumers reach the image bounds from this contract module.
// `share-popup-image.ts` is the pure authority; it stays import-free so the
// dashboard can read the same bounds its upload control enforces.
export {
  SHARE_POPUP_IMAGE_MAX_BYTES,
  SHARE_POPUP_IMAGE_MIMES,
  type SharePopupImageMime,
} from "./share-popup-image";
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
  modelAllowlist?: readonly string[];
  modelDenylist?: readonly string[];
  /** Client-router ids this key refuses; see `client-router-fingerprint.ts`. */
  clientRouterDenylist?: readonly string[];
  notesTitle?: string;
  notesSubtitle?: string;
  notesBody?: string;
  sharePopupEnabled?: boolean | null;
  /**
   * Uploaded popup art as a `data:<mime>;base64,…` URL. `null` clears it and
   * omitting it leaves the stored image alone. There is no remote-URL form: a
   * hotlink leaked each visitor's IP to a third party and rotted on host moves.
   */
  sharePopupImage?: string | null;
  sharePopupTitle?: string;
  sharePopupBody?: string;
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
  readonly modelAllowlist?: readonly string[];
  readonly modelDenylist?: readonly string[];
  readonly clientRouterDenylist?: readonly string[];
  readonly maxConcurrentRequests?: number;
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly sharePopupEnabled?: boolean;
  /** Mime of the stored popup art; its bytes are served by a dedicated route. */
  readonly sharePopupImageMime?: string;
  readonly sharePopupTitle?: string;
  readonly sharePopupBody?: string;
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
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey"> & {
    seedBuckets?(request: {
      readonly apiKeyId: string;
      readonly now?: number;
      readonly daily?: number;
      readonly monthly?: number;
    }): Promise<void>;
  };
  /**
   * Reads tokens already spent in the current daily/monthly bucket, so a
   * newly-added limit is enforced against the whole bucket. Optional: without
   * it a new limit simply starts counting from the moment it was set.
   */
  readonly bucketSpend?: (
    keyId: string,
    now: Date,
  ) => Promise<{ daily: number; monthly: number }>;
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

/** Maximum hint the enroll page accepts; the dashboard caps its input there. */
export const SHARED_CHILD_HINT_MAX_LENGTH = 20;

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

/**
 * Decodes an uploaded popup image into the bytes and mime to persist.
 *
 * Returns `null` for absent/blank input (nothing to store). Throws
 * `invalid_share_popup` for a non-data URL, an oversized payload, or bytes that
 * are not one of the four raster formats the share page may safely serve.
 */
export function parseSharePopupImage(
  value: string | null | undefined,
): { image: Buffer; mime: SharePopupImageMime } | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const match =
    /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
  const declared = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  if (!payload || declared === undefined || !(SHARE_POPUP_IMAGE_MIMES as readonly string[]).includes(declared)) {
    throw new ConsoleDomainError(
      "invalid_share_popup",
      400,
      "sharePopupImage must be an uploaded PNG, JPEG, WebP, or GIF file",
    );
  }
  const image = Buffer.from(payload, "base64");
  if (image.length === 0 || image.length > SHARE_POPUP_IMAGE_MAX_BYTES) {
    throw new ConsoleDomainError(
      "invalid_share_popup",
      400,
      `sharePopupImage must be at most ${Math.floor(SHARE_POPUP_IMAGE_MAX_BYTES / (1024 * 1024))} MB`,
    );
  }
  const mime = sniffSharePopupImageMime(image);
  if (mime === undefined || mime !== declared) {
    throw new ConsoleDomainError(
      "invalid_share_popup",
      400,
      "sharePopupImage bytes do not match a supported image format",
    );
  }
  return { image, mime };
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
  parseSharePopupImage(request.sharePopupImage);
  if (request.sharePopupTitle != null && request.sharePopupTitle.length > 120) {
    throw new ConsoleDomainError("invalid_share_popup", 400, "Share popup title is too long");
  }
  if (request.sharePopupBody != null && request.sharePopupBody.length > 1200) {
    throw new ConsoleDomainError("invalid_share_popup", 400, "Share popup body is too long");
  }
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
  if (request.clientRouterDenylist !== undefined) {
    if (!Array.isArray(request.clientRouterDenylist)) {
      throw new ConsoleDomainError(
        "invalid_client_router_denylist",
        400,
        "clientRouterDenylist must be an array of client-router ids",
      );
    }
    // An unrecognised id would persist a rule that can never match — the operator
    // would believe a router is blocked while nothing blocks it. Rejecting it is
    // the only outcome that keeps the stored policy honest.
    for (const id of request.clientRouterDenylist) {
      if (typeof id !== "string" || normalizeClientRouterId(id) === undefined) {
        throw new ConsoleDomainError(
          "invalid_client_router_denylist",
          400,
          `Unknown client router: ${String(id)}`,
        );
      }
    }
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
    ...(record.sharePopupEnabled === undefined ? {} : { sharePopupEnabled: record.sharePopupEnabled }),
    ...(record.sharePopupImageMime === undefined
      ? {}
      : { sharePopupImageMime: record.sharePopupImageMime }),
    ...(record.sharePopupTitle === undefined ? {} : { sharePopupTitle: record.sharePopupTitle }),
    ...(record.sharePopupBody === undefined ? {} : { sharePopupBody: record.sharePopupBody }),
    ...(record.requestsPerMinute === undefined ? {} : { requestsPerMinute: record.requestsPerMinute }),
    ...(record.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: record.dailyTokenLimit }),
    ...(record.monthlyTokenLimit === undefined ? {} : { monthlyTokenLimit: record.monthlyTokenLimit }),
    ...(record.lifetimeTokenBudget === undefined ? {} : { lifetimeTokenBudget: record.lifetimeTokenBudget }),
    ...(record.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: record.maxConcurrentRequests }),
    ...(record.modelPrefix === undefined ? {} : { modelPrefix: record.modelPrefix }),
    ...(record.modelAllowlist === undefined ? {} : { modelAllowlist: record.modelAllowlist }),
    ...(record.modelDenylist === undefined ? {} : { modelDenylist: record.modelDenylist }),
    ...(record.clientRouterDenylist === undefined
      ? {}
      : { clientRouterDenylist: record.clientRouterDenylist }),
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


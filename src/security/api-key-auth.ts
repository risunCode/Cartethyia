// API-key authentication and authorization snapshots: token extraction, hashing, lookup, and admission identity.

import type { CartethyiaDatabase } from "../persistence/postgres";
import { DrizzleApiKeyStore } from "../persistence/api-key-store";
import { GatewayError } from "../transport/gateway-error";
import { hashSecret } from "./crypto";
import type { AccessScope } from "./access-control";

/**
 * Resolves an inbound `/v1/*` bearer token to its persisted API key row and
 * builds the immutable `ApiKeyAuthorizationSnapshot` consumed by
 * `ApiKeyAdmissionService`. This is the only place a raw client bearer token
 * is hashed and looked up against Postgres.
 */
/** Immutable tenant-scoped authorization snapshot. */

export interface ApiKeyAuthorizationSnapshot {
  readonly api_key_id: string;
  readonly tenant_id: string;
  /** Admission identity used as key for rolling counters; defaults to api_key_id when absent. */
  readonly admission_identity?: string;
  /** Null/undefined means unrestricted. Database returns array or Set; normalized to frozen array. */
  readonly provider_allowlist?: readonly string[] | ReadonlySet<string> | null | undefined;
  readonly model_allowlist?: readonly string[] | ReadonlySet<string> | null | undefined;
  readonly model_denylist?: readonly string[] | ReadonlySet<string> | null | undefined;
  readonly rpm?: number | null | undefined;
  readonly rpm_limit?: number | null | undefined;
  readonly daily_tokens?: number | null | undefined;
  readonly monthly_tokens?: number | null | undefined;
  readonly lifetime_token_budget?: number | null | undefined;
  readonly lifetime_tokens_consumed?: number | null | undefined;
  readonly max_concurrent?: number | null | undefined;
  readonly scopes?: readonly string[] | undefined;
}

function freezeList(
  list: readonly string[] | ReadonlySet<string> | null | undefined,
): readonly string[] | null | undefined {
  if (list == null) return list as null | undefined;
  const arr: readonly string[] =
    list instanceof Set ? Object.freeze([...list] as string[]) : Object.freeze([...list]);
  return arr;
}

export function freezeSnapshot(s: ApiKeyAuthorizationSnapshot): ApiKeyAuthorizationSnapshot {
  const provider_allowlist = freezeList(s.provider_allowlist);
  const model_allowlist = freezeList(s.model_allowlist);
  const model_denylist = freezeList(s.model_denylist);

  const api_key_id = s.api_key_id ?? "";
  const tenant_id = s.tenant_id ?? "";
  const admission_identity = s.admission_identity ?? api_key_id;

  const frozen: ApiKeyAuthorizationSnapshot = {
    api_key_id,
    tenant_id,
    admission_identity,
    provider_allowlist,
    model_allowlist,
    model_denylist,
    rpm: s.rpm ?? s.rpm_limit ?? null,
    daily_tokens: s.daily_tokens ?? null,
    monthly_tokens: s.monthly_tokens ?? null,
    lifetime_token_budget: s.lifetime_token_budget ?? null,
    lifetime_tokens_consumed: s.lifetime_tokens_consumed ?? null,
    max_concurrent: s.max_concurrent ?? null,
    scopes: s.scopes ? Object.freeze([...s.scopes]) : undefined,
  };
  return Object.freeze(frozen) as ApiKeyAuthorizationSnapshot;
}

export function createAuthorizationSnapshot(input: {
  readonly api_key_id: string;
  readonly tenant_id: string;
  readonly admission_identity?: string;
  readonly provider_allowlist?: readonly string[] | ReadonlySet<string> | null;
  readonly model_allowlist?: readonly string[] | ReadonlySet<string> | null;
  readonly model_denylist?: readonly string[] | ReadonlySet<string> | null;
  readonly rpm?: number | null;
  readonly daily_tokens?: number | null;
  readonly monthly_tokens?: number | null;
  readonly lifetime_token_budget?: number | null;
  readonly lifetime_tokens_consumed?: number | null;
  readonly max_concurrent?: number | null;
  readonly rpm_limit?: number | null;
  readonly scopes?: readonly string[];
}): ApiKeyAuthorizationSnapshot {
  return freezeSnapshot({
    api_key_id: input.api_key_id,
    tenant_id: input.tenant_id,
    ...(input.provider_allowlist !== undefined && input.provider_allowlist !== null
      ? { provider_allowlist: input.provider_allowlist as readonly string[] }
      : {}),
    ...(input.model_allowlist !== undefined && input.model_allowlist !== null
      ? { model_allowlist: input.model_allowlist as readonly string[] }
      : {}),
    ...(input.model_denylist !== undefined && input.model_denylist !== null
      ? { model_denylist: input.model_denylist as readonly string[] }
      : {}),
    ...(input.rpm !== undefined && input.rpm !== null ? { rpm: input.rpm } : {}),
    ...(input.daily_tokens !== undefined && input.daily_tokens !== null
      ? { daily_tokens: input.daily_tokens }
      : {}),
    ...(input.monthly_tokens !== undefined && input.monthly_tokens !== null
      ? { monthly_tokens: input.monthly_tokens }
      : {}),
    ...(input.lifetime_token_budget !== undefined && input.lifetime_token_budget !== null
      ? { lifetime_token_budget: input.lifetime_token_budget }
      : {}),
    ...(input.lifetime_tokens_consumed !== undefined && input.lifetime_tokens_consumed !== null
      ? { lifetime_tokens_consumed: input.lifetime_tokens_consumed }
      : {}),
    ...(input.max_concurrent !== undefined && input.max_concurrent !== null
      ? { max_concurrent: input.max_concurrent }
      : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
  });
}

/** Membership test over an allowlist/denylist that may be an array, a Set, or absent. */
export function listIncludes(list: readonly string[] | ReadonlySet<string> | null | undefined, value: string): boolean {
  if (list == null) return false;
  if (list instanceof Set) return list.has(value);
  return (list as readonly string[]).includes(value);
}

function listSize(list: readonly string[] | ReadonlySet<string> | null | undefined): number {
  if (list == null) return 0;
  if (list instanceof Set) return list.size;
  return (list as readonly string[]).length;
}

/** Bare model id behind an optional `provider/` qualifier. */
function bareModelId(targetModel: string): string {
  const slash = targetModel.lastIndexOf("/");
  return slash < 0 ? targetModel : targetModel.slice(slash + 1);
}

/**
 * The two model-authorization rejection reasons. They are indistinguishable on
 * the wire (both 404 `model_not_found`) and in the admission metric label; only
 * the error's `details.reason` distinguishes a denylist hit from an allowlist
 * miss, so this vocabulary has exactly one definition.
 */
export type ModelRejectionReason = "model-denied" | "model-not-allowed";

/**
 * Single source of truth for the API-key model allow/deny rule. Returns the
 * rejection reason, or `null` when the target model is authorized.
 *
 * Dual-form matching: a bare entry matches its provider-qualified use and vice
 * versa, so neither allow nor deny silently misses a qualified form.
 *
 * Denylist wins over an allowlist. A request that names an allowed alias (or
 * combo) is authorized by that name: routing resolves it to a provider/model
 * the operator never typed into the allowlist, so the resolved form alone
 * would reject an explicitly permitted route. Denial keeps dual-form matching
 * but ignores the alias name — an allowlisted alias must not launder a denied
 * target.
 */
export function modelRejectionReason(
  snapshot: ApiKeyAuthorizationSnapshot,
  targetModel: string,
  targetProvider?: string,
  requestedModel?: string,
): ModelRejectionReason | null {
  const qualified = targetProvider ? `${targetProvider}/${bareModelId(targetModel)}` : undefined;
  const names = [targetModel, bareModelId(targetModel), ...(qualified ? [qualified] : [])];
  if (requestedModel && requestedModel !== targetModel) names.push(requestedModel);
  if (names.some((name) => listIncludes(snapshot.model_denylist, name))) return "model-denied";
  const allowlist = snapshot.model_allowlist;
  if (allowlist == null || listSize(allowlist) === 0) return null;
  return names.some((name) => listIncludes(allowlist, name)) ? null : "model-not-allowed";
}

export function isModelAllowed(
  snapshot: ApiKeyAuthorizationSnapshot,
  targetModel: string,
  targetProvider?: string,
  requestedModel?: string,
): boolean {
  return modelRejectionReason(snapshot, targetModel, targetProvider, requestedModel) === null;
}

export function isProviderAllowed(
  snapshot: ApiKeyAuthorizationSnapshot,
  targetProvider: string,
): boolean {
  const allowlist = snapshot.provider_allowlist;
  if (allowlist == null || listSize(allowlist) === 0) return true;
  return listIncludes(allowlist, targetProvider);
}

export function getAdmissionIdentity(snapshot: ApiKeyAuthorizationSnapshot): string {
  return snapshot.admission_identity ?? snapshot.api_key_id;
}

export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly AccessScope[];
  readonly snapshot: ApiKeyAuthorizationSnapshot;
  readonly modelPrefix?: string;
}

/** Extracts exactly one supported credential source, preserving public auth statuses. */
export function requestToken(headers: Headers | Record<string, string>): string {
  const get = (name: string): string | null =>
    headers instanceof Headers ? headers.get(name) : (headers[name] ?? null);
  const authorization = get("authorization")?.trim() ?? "";
  const apiKey = get("x-api-key")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authorization);
  const hasAuthorization = authorization.length > 0;
  const hasApiKey = apiKey.length > 0;
  if (hasAuthorization && hasApiKey)
    throw new GatewayError("invalid_request", 400, "conflicting credential headers");
  if (hasApiKey) return apiKey;
  const token = bearerMatch?.[1];
  if (token === undefined)
    throw new GatewayError("invalid_request", 401, "missing or malformed Authorization header");
  return token;
}

/**
 * Looks up the API key by its hashed bearer token. Returns `undefined` for
 * an unknown or revoked key — callers must reject with 401, never fall back
 * to an implicit/default identity.
 */
export async function resolveApiKeyAuthorization(
  db: CartethyiaDatabase,
  token: string,
): Promise<ResolvedApiKey | undefined> {
  const hash = hashSecret(token);
  const store = new DrizzleApiKeyStore(db);
  const row = await store.findActiveByHash(hash);
  if (!row) return undefined;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as AccessScope[]) : [];
  const snapshot = createAuthorizationSnapshot({
    api_key_id: row.id,
    tenant_id: row.tenantId,
    ...(row.providerAllowlist ? { provider_allowlist: row.providerAllowlist as string[] } : {}),
    ...(row.modelAllowlist ? { model_allowlist: row.modelAllowlist as string[] } : {}),
    ...(row.modelDenylist ? { model_denylist: row.modelDenylist as string[] } : {}),
    ...(row.requestsPerMinute != null ? { rpm: row.requestsPerMinute } : {}),
    ...(row.dailyTokenLimit != null ? { daily_tokens: row.dailyTokenLimit } : {}),
    ...(row.monthlyTokenLimit != null ? { monthly_tokens: row.monthlyTokenLimit } : {}),
    ...(row.lifetimeTokenBudget != null ? { lifetime_token_budget: row.lifetimeTokenBudget } : {}),
    lifetime_tokens_consumed: row.lifetimeTokensConsumed ?? 0,
    ...(row.maxConcurrentRequests != null ? { max_concurrent: row.maxConcurrentRequests } : {}),
    scopes,
  });

  return {
    id: row.id,
    tenantId: row.tenantId,
    scopes,
    snapshot,
    ...(row.modelPrefix ? { modelPrefix: row.modelPrefix } : {}),
  };
}

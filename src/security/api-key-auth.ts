// API-key authentication and authorization snapshots: token extraction, hashing, lookup, and admission identity.

import type { CartethyiaDatabase } from "../persistence/postgres";
import { DrizzleApiKeyStore } from "../persistence/api-key-store";
import { GatewayError } from "../transport/gateway-error";
import { hashSecret } from "./crypto";
import type { AccessScope } from "./access-control";
import type { ApiKeyModelAccessMode } from "../persistence/schema";

// ── Authorization cache ──────────────────────────────────────────────────────
/**
 * TTL-based in-memory cache for `resolveApiKeyAuthorization`, keyed by the
 * token hash. The Postgres round-trips this avoids (1–3 SELECTs per request)
 * are the single largest latency contributor on the `/v1/*` hot path.
 *
 * Trade-off: `lifetime_tokens_consumed` in the cached snapshot may be up to
 * `AUTH_CACHE_TTL_MS` stale. The admission service's real-time in-flight and
 * estimated-token accounting is the actual enforcement mechanism; the
 * snapshot's consumed value is a reference point, so a brief stale window
 * cannot meaningfully over-consume a budget.
 *
 * Negative results (unknown/revoked tokens) are deliberately NOT cached, so
 * a newly minted key is usable immediately.
 */
const AUTH_CACHE_TTL_MS = 3_000;
const AUTH_CACHE_MAX_ENTRIES = 10_000;

interface AuthCacheEntry {
  readonly at: number;
  readonly value: ResolvedApiKey;
}

const authCache = new Map<string, AuthCacheEntry>();
/** Reverse index: keyId → set of token hashes that resolved to it. */
const authCacheByKeyId = new Map<string, Set<string>>();

function evictAuthCacheOldest(): void {
  while (authCache.size > AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authCache.keys().next().value;
    if (oldest === undefined) return;
    authCache.delete(oldest);
  }
}

/**
 * Invalidates every cached authorization entry for one API key (or the entire
 * cache when `keyId` is omitted). Called by the API-key domain after any
 * mutation that changes a key's scopes, limits, or revoked state.
 */
export function invalidateApiKeyCache(keyId?: string): void {
  if (keyId === undefined) {
    authCache.clear();
    authCacheByKeyId.clear();
    return;
  }
  const hashes = authCacheByKeyId.get(keyId);
  if (!hashes) return;
  for (const hash of hashes) authCache.delete(hash);
  authCacheByKeyId.delete(keyId);
}

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
  /** Empty or absent means unrestricted; values are normalized to frozen arrays. */
  readonly model_access_mode?: ApiKeyModelAccessMode | null | undefined;
  /** The one list `model_access_mode` interprets; see the schema for semantics. */
  readonly model_list?: readonly string[] | ReadonlySet<string> | null | undefined;
  /** Client-router ids this key refuses; see `client-router-fingerprint.ts`. */
  readonly client_router_denylist?: readonly unknown[] | ReadonlySet<unknown> | null | undefined;
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
  list: readonly unknown[] | ReadonlySet<unknown> | null | undefined,
): readonly string[] | null | undefined {
  if (list == null) return list as null | undefined;
  const values = list instanceof Set ? [...list] : Array.isArray(list) ? list : [];
  const arr = Object.freeze(values.filter((value): value is string => typeof value === "string"));
  return arr;
}

export function freezeSnapshot(s: ApiKeyAuthorizationSnapshot): ApiKeyAuthorizationSnapshot {
  const model_list = freezeList(s.model_list);
  const model_access_mode: ApiKeyModelAccessMode =
    s.model_access_mode === "blacklist" ? "blacklist" : "whitelist";
  const client_router_denylist = freezeList(s.client_router_denylist);

  const api_key_id = s.api_key_id ?? "";
  const tenant_id = s.tenant_id ?? "";
  const admission_identity = s.admission_identity ?? api_key_id;

  const frozen: ApiKeyAuthorizationSnapshot = {
    api_key_id,
    tenant_id,
    admission_identity,
    model_access_mode,
    model_list,
    client_router_denylist,
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
  readonly model_access_mode?: ApiKeyModelAccessMode | null;
  readonly model_list?: readonly string[] | ReadonlySet<string> | null;
  readonly client_router_denylist?: readonly unknown[] | ReadonlySet<unknown> | null;
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
    ...(input.admission_identity !== undefined
      ? { admission_identity: input.admission_identity }
      : {}),
    ...(input.model_access_mode !== undefined && input.model_access_mode !== null
      ? { model_access_mode: input.model_access_mode }
      : {}),
    ...(input.model_list !== undefined && input.model_list !== null
      ? { model_list: input.model_list as readonly string[] }
      : {}),
    ...(input.client_router_denylist !== undefined && input.client_router_denylist !== null
      ? { client_router_denylist: input.client_router_denylist }
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

/**
 * The model-access rule lives in `model-access-rule.ts`, a pure module the
 * dashboard can import too (this file pulls in Drizzle/Node). Re-exported here
 * so existing callers keep importing from `api-key-auth`.
 */
export {
  isModelAllowed,
  listIncludes,
  modelRejectionReason,
  type ModelRejectionReason,
} from "./model-access-rule";


export function getAdmissionIdentity(snapshot: ApiKeyAuthorizationSnapshot): string {
  return snapshot.admission_identity ?? snapshot.api_key_id;
}

export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly AccessScope[];
  readonly snapshot: ApiKeyAuthorizationSnapshot;
  readonly modelPrefix?: string;
  /** Share-template id whose remote CLI mappings are inherited by this child. */
  readonly cliMappingOwnerId?: string;
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
  if (hasAuthorization && hasApiKey) {
    // Both headers carrying the *same* credential is a compatibility idiom, not
    // an error: an Anthropic-compatible client sends `x-api-key` and
    // `Authorization: Bearer <same key>` together so a gateway reading either
    // one works, and rejecting the pair rejects the whole client. Two
    // *different* credentials stay a conflict — accepting whichever came first
    // would silently decide the request's identity.
    if (bearerMatch?.[1] === apiKey) return apiKey;
    throw new GatewayError("invalid_request", 400, "conflicting credential headers");
  }
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
  const cached = authCache.get(hash);
  if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) return cached.value;
  const store = new DrizzleApiKeyStore(db);
  const row = await store.findActiveByHash(hash);
  if (!row) return undefined;
  // A child (shared) key consumes against its parent's quota, not just its
  // own: the parent's budget is the operator's global cap across all
  // recipients. Without this the parent's lifetime budget never moves no
  // matter how much its children spend, so the limit silently never fires.
  // One extra SELECT on the auth path, only for keys that have a parent.
  const parent =
    row.parentKeyId !== null ? await store.findActiveById(row.parentKeyId) : undefined;
  // Share children authenticate as themselves but inherit the template's live
  if (row.parentKeyId !== null && parent === undefined) return undefined;
  // policy. Copy-on-issue alone went stale the moment an operator tightened a
  // limit or blocked a client router on the parent — existing recipients kept
  // the old row values forever. Reading the parent here makes denylist /
  // one-time / recurring edits apply on the next cache miss.
  const policy = parent ?? row;
  const consumed =
    (policy.id === row.id
      ? (row.lifetimeTokensConsumed ?? 0)
      : (policy.lifetimeTokensConsumed ?? 0)) +
    (await store.sumChildrenConsumed(policy.id));
  const scopes = Array.isArray(policy.scopes) ? (policy.scopes as AccessScope[]) : [];
  const snapshot = createAuthorizationSnapshot({
    api_key_id: row.id,
    tenant_id: row.tenantId,
    // Family quota / concurrency share one admission counter namespace so two
    // recipients cannot each burn a full lifetime/daily budget.
    ...(parent ? { admission_identity: parent.id } : {}),
    ...(policy.modelList ? { model_list: policy.modelList as string[] } : {}),
    model_access_mode: policy.modelAccessMode ?? "whitelist",
    ...(policy.clientRouterDenylist
      ? { client_router_denylist: policy.clientRouterDenylist as string[] }
      : {}),
    ...(policy.requestsPerMinute != null ? { rpm: policy.requestsPerMinute } : {}),
    ...(policy.dailyTokenLimit != null ? { daily_tokens: policy.dailyTokenLimit } : {}),
    ...(policy.monthlyTokenLimit != null ? { monthly_tokens: policy.monthlyTokenLimit } : {}),
    ...(policy.lifetimeTokenBudget != null ? { lifetime_token_budget: policy.lifetimeTokenBudget } : {}),
    lifetime_tokens_consumed: consumed,
    ...(policy.maxConcurrentRequests != null ? { max_concurrent: policy.maxConcurrentRequests } : {}),
    scopes,
  });

  const value: ResolvedApiKey = {
    id: row.id,
    tenantId: row.tenantId,
    scopes,
    snapshot,
    ...(policy.modelPrefix ? { modelPrefix: policy.modelPrefix } : {}),
    ...(parent?.keyMode === "share" ? { cliMappingOwnerId: parent.id } : {}),
  };
  authCache.set(hash, { at: Date.now(), value });
  const hashes = authCacheByKeyId.get(value.id) ?? new Set<string>();
  hashes.add(hash);
  authCacheByKeyId.set(value.id, hashes);
  evictAuthCacheOldest();
  return value;
}

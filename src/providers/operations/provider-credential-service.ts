// Provider credentials: decrypts stored account rows into dispatchable ResolvedCredentials.
import { eq } from "drizzle-orm";

import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providerAccounts, providerOauthStates } from "../../persistence/schema";
import { decryptCredentialToString } from "../../security/crypto";
import { GatewayError } from "../../transport/gateway-error";
import type { OAuthRefreshService, OAuthTokenRefresher } from "../authentication/oauth-refresh-service";
import { CredentialResolver, parseProviderId, type CredentialAlternative, type CredentialKind } from "../provider-registry";
import type { ResolvedCredential } from "../provider-registry";
import { record } from "../authentication/oauth-flow-store";
import { refreshLeadMs } from "./oauth-refresh-lead";

// ── Credential cache ─────────────────────────────────────────────────────────
/**
 * TTL-based cache for `resolveCredentialForAccount`, keyed by accountId.
 * Avoids a Postgres SELECT + AES-GCM decrypt on every attempt. The TTL is
 * short enough that credential rotation is picked up almost immediately;
 * `invalidateCredentialCache` provides explicit invalidation for the
 * credential-rotation mutation points.
 */
const CRED_CACHE_TTL_MS = 5_000;
const CRED_CACHE_MAX_ENTRIES = 2_000;

interface CredCacheEntry {
  readonly at: number;
  readonly value: ResolvedCredential;
}

const credCache = new Map<string, CredCacheEntry>();

function evictCredCacheOldest(): void {
  while (credCache.size > CRED_CACHE_MAX_ENTRIES) {
    const oldest = credCache.keys().next().value;
    if (oldest === undefined) return;
    credCache.delete(oldest);
  }
}

/**
 * Invalidates one account's cached credential (or the entire cache).
 * Call after credential rotation, account deletion, or account disable.
 */
export function invalidateCredentialCache(accountId?: string): void {
  if (accountId === undefined) {
    credCache.clear();
    return;
  }
  credCache.delete(accountId);
}

const resolver = new CredentialResolver();

/** Stored account fields needed by credential resolution and token refresh. */
export interface AccountWithFreshnessRow {
  readonly id: string;
  readonly providerId: string;
  readonly credentialKind: CredentialKind;
  readonly credentialCiphertext: Buffer | null;
  readonly refreshCiphertext: Buffer | null;
  /** Non-secret per-account auth config; `unknown` at the DB boundary, narrowed where read. */
  readonly authState: unknown;
  readonly clientSecretCiphertext: Buffer | null;
  readonly expiresAt: Date | null;
  /** The credential is a static bearer token that must never be refreshed. */
  readonly staticToken: boolean;
}

/** One account row together with its skew-adjusted OAuth due time. */
export interface AccountWithFreshness {
  readonly row: AccountWithFreshnessRow;
  readonly dueAt: number | undefined;
}

/**
 * Loads an account and its optional OAuth state in one query.
 *
 * `dueAt` is the OAuth expiry minus the provider's refresh lead
 * (`refreshLeadMs(providerId)`), so a token becomes due at the point that
 * provider re-mints its own (Claude ~4h, Codex ~5 days, Antigravity ~5 min).
 * Non-OAuth accounts and accounts without OAuth state have no due time.
 */
export async function loadAccountWithFreshness(
  db: CartethyiaDatabase,
  accountId: string,
  skewMs?: number,
): Promise<AccountWithFreshness | undefined> {
  const selectBuilder = db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      credentialKind: providerAccounts.credentialKind,
      credentialCiphertext: providerAccounts.credentialCiphertext,
      refreshCiphertext: providerOauthStates.refreshCiphertext,
      authState: providerAccounts.authState,
      clientSecretCiphertext: providerOauthStates.clientSecretCiphertext,
      expiresAt: providerOauthStates.expiresAt,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts);
  const query = "leftJoin" in selectBuilder
    ? selectBuilder.leftJoin(
        providerOauthStates,
        eq(providerOauthStates.providerAccountId, providerAccounts.id),
      )
    : selectBuilder;
  const rows = await query.where(eq(providerAccounts.id, accountId)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const lead = skewMs ?? refreshLeadMs(row.providerId);
  return {
    row,
    // A static token is never "due": it is used as issued and there is no
    // refresh to run, so the dispatch path must not treat it as stale.
    dueAt:
      row.staticToken || row.expiresAt == null
        ? undefined
        : row.expiresAt.getTime() - lead,
  };
}

/** OAuth refresh collaborators, injected by the composition root. */
export interface ResolveCredentialOAuth {
  /** Registry-backed refresher lookup; providers without a refresher are skipped. */
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
}

/** Resolves the credential for a specific provider-account id, decrypting at read time. */
export async function resolveCredentialForAccount(
  db: CartethyiaDatabase,
  providerId: string,
  accountId: string,
  oauth?: ResolveCredentialOAuth,
): Promise<ResolvedCredential> {
  // Cache hit: skip DB round-trip + AES-GCM decrypt.
  // Don't cache OAuth credentials whose token is due for refresh soon —
  // the cached value would contain a soon-to-expire secret.
  const now = Date.now();
  const cached = credCache.get(accountId);
  if (cached && now - cached.at < CRED_CACHE_TTL_MS) {
    const kind = (cached.value as { credential_kind?: string }).credential_kind;
    if (kind !== "oauth") return cached.value;
  }

  const parsedProviderId = parseProviderId(providerId);
  const account = await loadAccountWithFreshness(db, accountId);
  if (!account) {
    throw new GatewayError("admission_unavailable", 503, "provider account no longer exists", {
      provider_id: providerId,
      account_id: accountId,
    });
  }

  const { row, dueAt } = account;
  let secret: string | undefined;
  if (row.credentialCiphertext) {
    try {
      secret = decryptCredentialToString(row.credentialCiphertext);
    } catch {
      throw new GatewayError(
        "authentication_failed",
        401,
        "provider credential cannot be decrypted; re-save the account credential",
        {
          providerId: row.providerId,
          accountId: row.id,
          credentialEvidence: true,
          accountScope: true,
        },
      );
    }
  }
  if (row.credentialKind === "oauth" && oauth && dueAt !== undefined && dueAt <= Date.now()) {
    const refresher = await oauth.resolveRefresher(row.providerId);
    if (refresher) {
      secret = await oauth.refreshService.ensureFreshAccessToken(accountId, refresher) ?? undefined;
    }
  }

  const authState = record(row.authState);
  const alternative: CredentialAlternative = {
    provider_id: parseProviderId(row.providerId),
    account_id: row.id,
    credential_kind: row.credentialKind,
    ...(secret ? { secret } : {}),
    ...(authState === undefined ? {} : { auth_state: authState }),
  };
  const value = resolver.resolve(parsedProviderId, [alternative]).credential;
  // Cache non-OAuth credentials unconditionally; OAuth only when far from expiry.
  const isOAuth = row.credentialKind === "oauth";
  const safeToCache = !isOAuth || (dueAt !== undefined && dueAt > now + CRED_CACHE_TTL_MS);
  if (safeToCache) {
    credCache.set(accountId, { at: now, value });
    evictCredCacheOldest();
  }
  return value;
}

export async function resolveAccountSecretString(
  db: CartethyiaDatabase,
  providerId: string,
  accountId: string,
  oauth?: ResolveCredentialOAuth,
): Promise<string> {
  const credential = await resolveCredentialForAccount(db, providerId, accountId, oauth);
  return credential.secret ? new TextDecoder().decode(credential.secret) : "";
}

/** Decrypts the stored provider tokens after refreshing an expired OAuth access token. */
export async function resolveAccountCredentialsForExport(
  db: CartethyiaDatabase,
  providerId: string,
  accountId: string,
  oauth?: ResolveCredentialOAuth,
): Promise<{ readonly accessToken: string; readonly refreshToken?: string }> {
  let account = await loadAccountWithFreshness(db, accountId);
  if (!account) {
    throw new GatewayError("admission_unavailable", 503, "provider account no longer exists", {
      provider_id: providerId,
      account_id: accountId,
    });
  }

  if (
    account.row.credentialKind === "oauth" &&
    oauth &&
    account.dueAt !== undefined &&
    account.dueAt <= Date.now()
  ) {
    const refresher = await oauth.resolveRefresher(account.row.providerId);
    if (refresher) {
      await oauth.refreshService.ensureFreshAccessToken(accountId, refresher);
      account = await loadAccountWithFreshness(db, accountId);
      if (!account) {
        throw new GatewayError("admission_unavailable", 503, "provider account no longer exists", {
          provider_id: providerId,
          account_id: accountId,
        });
      }
    }
  }

  const accessToken = account.row.credentialCiphertext
    ? decryptCredentialToString(account.row.credentialCiphertext)
    : "";
  const refreshToken = account.row.refreshCiphertext
    ? decryptCredentialToString(account.row.refreshCiphertext)
    : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}

/** Binds token decryption and refresh behavior for the provider-account export route. */
export function createAccountExportCredentialsResolver(deps: {
  readonly db: CartethyiaDatabase;
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
}): (
  providerId: string,
  accountId: string,
) => Promise<{ readonly accessToken: string; readonly refreshToken?: string }> {
  return (providerId, accountId) =>
    resolveAccountCredentialsForExport(deps.db, providerId, accountId, {
      resolveRefresher: deps.resolveRefresher,
      refreshService: deps.refreshService,
    });
}

/**
 * Binds refresh-aware credential resolution for quota routes and the background
 * quota sweep, avoiding a stale-token fallback when OAuth refresh is due.
 */
export function createAccountSecretResolver(deps: {
  readonly db: CartethyiaDatabase;
  readonly resolveRefresher: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly refreshService: Pick<OAuthRefreshService, "ensureFreshAccessToken">;
}): (providerId: string, accountId: string) => Promise<string> {
  return (providerId, accountId) =>
    resolveAccountSecretString(deps.db, providerId, accountId, {
      resolveRefresher: deps.resolveRefresher,
      refreshService: deps.refreshService,
    });
}

/**
 * OAuth token refresh orchestration: in-process single-flight plus a
 * Postgres lease-fenced compare-and-swap.
 *
 * Two layers of coordination:
 *  1. In-process: a `Map<accountId, Promise>` so concurrent callers in the
 *     same process share one upstream refresh call instead of racing.
 *  2. Cross-process: a lease (`provider_oauth_states.lease_owner`/
 *     `lease_expires_at`) acquired via a conditional `UPDATE`, and every
 *     persisted mutation is fenced on `lease_owner = <this process's lease
 *     id>` so a process whose lease expired mid-refresh cannot clobber a
 *     peer that took over — its fenced write simply matches zero rows.
 *
 * Refresh token, expiry, and lease live in `provider_oauth_states`
 * (), a 1:0/1 table keyed by `provider_account_id` — split out
 * of `provider_accounts` because the lease is a sparse, cross-process
 * coordination concern that stayed null on every non-OAuth (`api_key`)
 * account row. Credential ciphertext and health-machine fields stay on
 * `provider_accounts`; `persistRefreshed`/`disableAccount` update both
 * tables inside one transaction, fenced first on the lease table so a
 * losing process's write touches zero rows in either table.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providerAccounts, providerOauthStates } from "../../persistence/schema";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import {
  loadAccountWithFreshness,
  OAUTH_REFRESH_SKEW_MS,
  type AccountWithFreshnessRow,
} from "../operations/provider-credential-service";
import { pushStructuredConsoleLog } from "../../observability/log-ring";

/**
 * Classifies an OAuth token-refresh failure as definitive (the credential is
 * permanently revoked/expired and must stop being retried) or transient
 * (network blip, upstream 5xx/429, temporary outage — safe to retry later).
 *
 * Uses a regex over the error's message/body, not a bare HTTP-status
 * allowlist, since the same status code (401) can mean either "token is
 * dead" or "clock skew, try again" depending on the error body's actual
 * wording.
 */

const DEFINITIVE_PATTERN =
  /invalid_grant|invalid_token|unauthorized_client|revoked|refresh_token.*expired/i;

interface OAuthRefreshFailure {
  readonly status?: number | undefined;
  readonly message: string;
}

type OAuthFailureClassification = "definitive" | "transient";

/**
 * A bare 401 with no body match for the definitive pattern is still treated
 * as definitive (an unrecognized-but-clearly-"unauthorized" response from a
 * refresh endpoint almost never self-heals); everything else — timeouts,
 * 5xx, 429, 403/"forbidden", "temporarily unavailable" — is transient.
 */
export function classifyOAuthRefreshFailure(
  failure: OAuthRefreshFailure,
): OAuthFailureClassification {
  if (DEFINITIVE_PATTERN.test(failure.message)) return "definitive";
  if (failure.status === 401) return "definitive";
  return "transient";
}

export { OAUTH_REFRESH_SKEW_MS };

/** How long a lease is valid for before another process may reclaim it. */
const LEASE_TTL_MS = 15_000;

/**
 * Bound on a single token-endpoint call. Neither the reactive path nor the
 * sweep passes a caller signal, and a hung endpoint must not block either
 * indefinitely — timeouts classify as transient failures.
 */
const REFRESH_HTTP_TIMEOUT_MS = 30_000;

export interface OAuthTokenRefreshResult {
  readonly access: string;
  /** Omitted when the provider keeps the existing refresh token valid. */
  readonly refresh?: string;
  readonly expiresAt: Date;
}

/** Provider-specific token-endpoint client. Implemented per provider in later phases. */
export interface OAuthTokenRefresher {
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult>;
}

type AccountRow = AccountWithFreshnessRow;

/** Acquires the refresh lease for `accountId`, or returns false if another live lease holds it. */
async function acquireLease(
  db: CartethyiaDatabase,
  accountId: string,
  owner: string,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const result = await db
    .update(providerOauthStates)
    .set({ leaseOwner: owner, leaseExpiresAt: expiresAt })
    .where(
      and(
        eq(providerOauthStates.providerAccountId, accountId),
        or(isNull(providerOauthStates.leaseOwner), lt(providerOauthStates.leaseExpiresAt, now)),
      ),
    )
    .returning({ id: providerOauthStates.providerAccountId });
  return result.length > 0;
}

/** Releases the lease without mutating credential state (used for transient failures). */
async function releaseLease(
  db: CartethyiaDatabase,
  accountId: string,
  owner: string,
): Promise<void> {
  await db
    .update(providerOauthStates)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(
      and(
        eq(providerOauthStates.providerAccountId, accountId),
        eq(providerOauthStates.leaseOwner, owner),
      ),
    );
}

/** Persists a successful refresh and releases the lease, fenced on still holding it. */
async function persistRefreshed(
  db: CartethyiaDatabase,
  accountId: string,
  owner: string,
  result: OAuthTokenRefreshResult,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const leaseRows = await tx
      .update(providerOauthStates)
      .set({
        ...(result.refresh === undefined
          ? {}
          : { refreshCiphertext: encryptCredential(result.refresh) }),
        expiresAt: result.expiresAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(providerOauthStates.providerAccountId, accountId),
          eq(providerOauthStates.leaseOwner, owner),
        ),
      )
      .returning({ id: providerOauthStates.providerAccountId });
    if (leaseRows.length === 0) return false;
    await tx
      .update(providerAccounts)
      .set({
        credentialCiphertext: encryptCredential(result.access),
      })
      .where(eq(providerAccounts.id, accountId));
    return true;
  });
}

/** Marks an account permanently unusable after a definitive refresh failure, fenced on the lease. */
async function disableAccount(
  db: CartethyiaDatabase,
  accountId: string,
  owner: string,
  message: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const leaseRows = await tx
      .update(providerOauthStates)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(
        and(
          eq(providerOauthStates.providerAccountId, accountId),
          eq(providerOauthStates.leaseOwner, owner),
        ),
      )
      .returning({ id: providerOauthStates.providerAccountId });
    if (leaseRows.length === 0) return;
    await tx
      .update(providerAccounts)
      .set({
        status: "disabled",
        lastError: message.slice(0, 500),
        lastErrorCategory: "oauth_revoked",
        lastErrorAt: new Date(),
      })
      .where(eq(providerAccounts.id, accountId));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Best-effort HTTP status extraction from an OAuth refresh error. Most
 *  providers surface `error.status` or embed the status in the message; we
 *  accept either so the classifier can honor "bare 401 -> definitive". */
function failureStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === "object" && "status" in error) {
    const raw = error.status;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  const msg = failureMessage(error);
  const match = /\b(\d{3})\b/.exec(msg);
  if (match) {
    const status = Number(match[1]);
    if (status >= 400 && status < 600) return status;
  }
  return undefined;
}

/** Rows whose OAuth token is due for proactive refresh (used by the sweep worker). */
export async function loadDueOAuthAccounts(
  db: CartethyiaDatabase,
  skewMs = OAUTH_REFRESH_SKEW_MS,
): Promise<readonly { readonly id: string; readonly providerId: string }[]> {
  const cutoff = new Date(Date.now() + skewMs);
  return db
    .select({ id: providerAccounts.id, providerId: providerAccounts.providerId })
    .from(providerAccounts)
    .innerJoin(providerOauthStates, eq(providerOauthStates.providerAccountId, providerAccounts.id))
    .where(
      and(
        eq(providerAccounts.credentialKind, "oauth"),
        eq(providerAccounts.status, "active"),
        or(
          isNull(providerOauthStates.expiresAt),
          lt(providerOauthStates.expiresAt, cutoff),
        ),
      ),
    );
}

export class OAuthRefreshService {
  /** Bound on concurrently tracked single-flight refreshes; keys are account ids, so the real bound is the account count. */
  private static readonly MAX_INFLIGHT = 1_000;

  readonly #db: CartethyiaDatabase;
  readonly #inFlight = new Map<string, Promise<string | null>>();

  constructor(db: CartethyiaDatabase) {
    this.#db = db;
  }

  /**
   * Ensures a fresh access token for an OAuth account, refreshing it first
   * if it's within `opts.skewMs` of expiry (or already expired). When
   * `opts.force` is `true`, the freshness check is bypassed and the
   * refresher is always invoked — used by the 401 dispatch retry so a peer
   * that just refreshed cannot cause the caller to reuse a dead cached
   * secret. Returns the current decrypted access token, or `null` when the
   * account isn't OAuth, has no stored refresh token, or refresh failed.
   */
  async ensureFreshAccessToken(
    accountId: string,
    refresher: OAuthTokenRefresher,
    opts: { force?: boolean; skewMs?: number } = {},
  ): Promise<string | null> {
    const force = opts.force === true;
    const skewMs = opts.skewMs ?? OAUTH_REFRESH_SKEW_MS;
    // Forced refreshes get their own in-flight slot so they don't merge with
    // a raced non-force call that would otherwise short-circuit.
    const key = force ? `${accountId}:force` : accountId;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    // Eviction guard: keys are account ids (bounded by the accounts table),
    // but a runaway caller could still fan out unique keys; drop the oldest
    // in-flight task rather than grow without bound. An evicted task's
    // `.finally` delete is a no-op for a key no longer present, and a racing
    // duplicate refresh is fenced cross-process by the lease below.
    if (this.#inFlight.size >= OAuthRefreshService.MAX_INFLIGHT) {
      const oldestKey = this.#inFlight.keys().next().value;
      if (oldestKey !== undefined) this.#inFlight.delete(oldestKey);
    }
    const task = this.#refreshIfDue(accountId, refresher, skewMs, force).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, task);
    return task;
  }

  async #refreshIfDue(
    accountId: string,
    refresher: OAuthTokenRefresher,
    skewMs: number,
    force: boolean,
  ): Promise<string | null> {
    const account = await loadAccountWithFreshness(this.#db, accountId, skewMs);
    if (!account || account.row.credentialKind !== "oauth") return null;
    const { row, dueAt } = account;
    if (!force && dueAt !== undefined && dueAt > Date.now()) {
      return row.credentialCiphertext
        ? decryptCredentialToString(row.credentialCiphertext)
        : null;
    }
    return this.#refreshNow(row, refresher, skewMs);
  }

  async #refreshNow(
    row: AccountRow,
    refresher: OAuthTokenRefresher,
    skewMs: number,
  ): Promise<string | null> {
    pushStructuredConsoleLog("info", "OAuth token refresh started", {
      event: "token_refresh",
      accountId: row.id,
      providerId: row.providerId,
    });
    const owner = randomUUID();
    const leased = await acquireLease(this.#db, row.id, owner);
    if (!leased) {
      // A peer holds the lease — briefly wait for it to finish, then read whatever it left.
      await sleep(500);
      const fresh = await loadAccountWithFreshness(this.#db, row.id, skewMs);
      return fresh?.row.credentialCiphertext && fresh.dueAt !== undefined && fresh.dueAt > Date.now()
        ? decryptCredentialToString(fresh.row.credentialCiphertext)
        : null;
    }
    if (!row.refreshCiphertext) {
      await releaseLease(this.#db, row.id, owner);
      pushStructuredConsoleLog("warn", "OAuth token refresh skipped: refresh token missing", {
        event: "token_refresh",
        accountId: row.id,
        providerId: row.providerId,
        errorCode: "refresh_token_missing",
      });
      return null;
    }
    const refreshToken = decryptCredentialToString(row.refreshCiphertext);
    try {
      const result = await refresher.refresh(
        refreshToken,
        AbortSignal.timeout(REFRESH_HTTP_TIMEOUT_MS),
      );
      const persisted = await persistRefreshed(this.#db, row.id, owner, result);
      pushStructuredConsoleLog(persisted ? "info" : "warn", persisted ? "OAuth token refresh completed" : "OAuth token refresh lost lease", {
        event: "token_refresh",
        accountId: row.id,
        providerId: row.providerId,
        ...(persisted ? {} : { errorCode: "refresh_lease_lost" }),
        details: { expiresAt: result.expiresAt.toISOString() },
      });
      return persisted ? result.access : null;
    } catch (error) {
      const classification = classifyOAuthRefreshFailure({
        message: failureMessage(error),
        status: failureStatus(error),
      });
      pushStructuredConsoleLog("error", "OAuth token refresh failed", {
        event: "token_refresh",
        accountId: row.id,
        providerId: row.providerId,
        errorCode: classification,
      });
      if (classification === "definitive") {
        await disableAccount(this.#db, row.id, owner, failureMessage(error));
      } else {
        await releaseLease(this.#db, row.id, owner);
      }
      return null;
    }
  }
}

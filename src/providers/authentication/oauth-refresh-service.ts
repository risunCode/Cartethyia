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
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { providerAccounts, providerOauthStates } from "../../persistence/schema";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import { invalidateCredentialCache } from "../operations/provider-credential-service";
import { record } from "./oauth-flow-store";
import {
  loadAccountWithFreshness,
  type AccountWithFreshnessRow,
} from "../operations/provider-credential-service";
import { refreshLeadMs } from "../operations/oauth-refresh-lead";
import { classifyAccessTokenUsability } from "./static-token-detection";
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
  /**
   * Auth configuration the refresh corrected or discovered — most often the
   * upstream profile the account resolves to, which some providers only report
   * beside a fresh access token. Omitted means the stored state stands.
   */
  readonly auth_state?: Readonly<Record<string, unknown>>;
  /**
   * Display identity the refresh learned (email/username from the fresh token
   * or token response). Omitted when the provider reports nothing new.
   */
  readonly accountLabel?: string;
}

/**
 * What a refresher is told about the account it is refreshing.
 *
 * A refresh is not authorized by the refresh token alone everywhere: one flow
 * replays the client credentials its login registered, another posts to a
 * per-account token endpoint. Both belong to the account rather than to the
 * token, so they are handed in here instead of being re-read from storage
 * inside every provider client.
 */
export interface OAuthRefreshContext {
  readonly account_id: string;
  readonly auth_state?: Readonly<Record<string, unknown>>;
  /** Current access token for endpoints that authenticate refresh requests with both tokens. */
  readonly access_token?: string;
  /** Decrypted companion secret for flows whose login registered a client secret. */
  readonly client_secret?: string;
}

/** Provider-specific token-endpoint client. Implemented per provider in later phases. */
export interface OAuthTokenRefresher {
  /** Requests the current access token in refresh context only when required by the endpoint. */
  readonly requiresAccessToken?: boolean;
  refresh(
    refreshToken: string,
    signal?: AbortSignal,
    context?: OAuthRefreshContext,
  ): Promise<OAuthTokenRefreshResult>;
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
        // Only what the refresh reported: a refresher that learned nothing new
        // leaves the stored configuration alone rather than blanking it.
        // A learned identity only replaces a default label — an operator's
        // custom rename is never overwritten. The CASE keeps the read and the
        // write in one statement, so a concurrent rename cannot lose to the
        // refresh's learned identity.
        ...(result.accountLabel === undefined
          ? {}
          : {
            label: sql`CASE WHEN lower(trim(${providerAccounts.label})) = lower(trim(${providerAccounts.providerId})) THEN ${result.accountLabel} ELSE ${providerAccounts.label} END`,
          }),
        ...(result.auth_state === undefined ? {} : { authState: result.auth_state }),
      })
      .where(eq(providerAccounts.id, accountId));
    invalidateCredentialCache(accountId);
    return true;
  });
}

/**
 * Packages the account-side facts a refresh needs but the refresh token does
 * not carry. The companion secret is decrypted here, once, so provider clients
 * never reach into the database.
 */
function buildRefreshContext(row: AccountRow, includeAccessToken: boolean): OAuthRefreshContext {
  const authState = record(row.authState);
  return {
    account_id: row.id,
    ...(authState === undefined ? {} : { auth_state: authState }),
    ...(includeAccessToken && row.credentialCiphertext
      ? { access_token: decryptCredentialToString(row.credentialCiphertext) }
      : {}),
    ...(row.clientSecretCiphertext
      ? { client_secret: decryptCredentialToString(row.clientSecretCiphertext) }
      : {}),
  };
}

/**
 * Marks an account permanently unusable after a definitive refresh failure,
 * fenced on the lease.
 */
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
        // `auth_invalidated` is the category the console reads to render the
        // "Re-login required" pill, and the one the quota sweep excludes so it
        // stops re-probing a credential that cannot repair itself. The refresh
        // grant was definitively rejected and the stored access token could not
        // be shown to still work, so this is exactly that state.
        lastErrorCategory: "auth_invalidated",
        lastErrorAt: new Date(),
      })
      .where(eq(providerAccounts.id, accountId));
    invalidateCredentialCache(accountId);
  });
}

/**
 * Marks an account as carrying a static bearer token: used exactly as issued,
 * never refreshed. Called when the refresh path finds no refresh token on
 * record, so the account converges to the same state the console's explicit
 * "static token" toggle sets — the sweep skips it and its status stops reading
 * as a broken/re-auth account. Not lease-fenced: a non-destructive annotation
 * that any process may write, and the credential is not touched.
 */
async function markStaticToken(db: CartethyiaDatabase, accountId: string): Promise<void> {
  await db
    .update(providerAccounts)
    .set({
      staticToken: true,
      // A static token is a normal, usable credential, not an error state: the
      // account is `active` and dispatchable, so any error left by the failed
      // refresh would otherwise keep the row reading "Re-login required" while
      // it is in fact serving. Mirrors the console's static-token toggle.
      status: "active",
      cooldownUntil: null,
      lastError: null,
      lastErrorCategory: null,
      lastErrorAt: null,
    })
    .where(eq(providerAccounts.id, accountId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Decrypts a stored credential, returning `undefined` when the ciphertext
 * cannot be decrypted. A corrupt row is not evidence about token expiry, so the
 * caller treats it the same as a missing token rather than throwing inside the
 * refresh failure path.
 */
function safeDecryptCredential(ciphertext: Buffer): string | undefined {
  try {
    return decryptCredentialToString(ciphertext);
  } catch {
    return undefined;
  }
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

/**
 * Boot-time convergence for OAuth accounts already parked by an earlier
 * refresh failure.
 *
 * Before automatic detection existed, a definitive refresh failure disabled the
 * account outright (`oauth_revoked`) even when the stored access token was
 * still perfectly usable. This pass re-reads those rows once at startup and
 * moves each to where it now belongs:
 *
 *  - access token still usable ⇒ static token, back to `active`;
 *  - otherwise ⇒ the `auth_invalidated` category the console renders as
 *    "Re-login required" and the quota sweep excludes.
 *
 * Idempotent and cheap: it only inspects OAuth rows that are `disabled` with a
 * credential-failure category, so a healthy deployment scans nothing. The
 * credential is decoded, never verified — the same structural-only trust the
 * dispatch path already places in the stored token.
 */
export async function reconcileStaticTokenAccounts(db: CartethyiaDatabase): Promise<number> {
  const candidates = await db
    .select({
      id: providerAccounts.id,
      credentialCiphertext: providerAccounts.credentialCiphertext,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.credentialKind, "oauth"),
        eq(providerAccounts.status, "disabled"),
        or(
          eq(providerAccounts.lastErrorCategory, "oauth_revoked"),
          eq(providerAccounts.lastErrorCategory, "auth_invalidated"),
        ),
      ),
    );
  let changed = 0;
  for (const row of candidates) {
    if (row.staticToken) continue;
    const usability = classifyAccessTokenUsability(
      row.credentialCiphertext ? safeDecryptCredential(row.credentialCiphertext) : undefined,
    );
    if (usability === "usable") {
      await markStaticToken(db, row.id);
      invalidateCredentialCache(row.id);
      pushStructuredConsoleLog("info", "OAuth account recovered as a static token at boot", {
        event: "token_refresh",
        accountId: row.id,
        errorCode: "static_token",
      });
      changed += 1;
      continue;
    }
    // Converge the legacy category name so the console and the quota sweep see
    // one spelling of "credential rejected, operator must re-login".
    await db
      .update(providerAccounts)
      .set({ lastErrorCategory: "auth_invalidated" })
      .where(eq(providerAccounts.id, row.id));
    changed += 1;
  }
  return changed;
}

/**
 * Rows whose OAuth token is due for proactive refresh (used by the sweep worker).
 *
 * The due test is applied in JS, not as one SQL `expires_at < cutoff`, because
 * the lead is per provider (`refreshLeadMs`): Claude re-mints ~4h ahead, Codex
 * ~5 days, Antigravity ~5 min, and a single global cutoff cannot express that.
 * Accounts with no recorded expiry are always due — an account the sweep cannot
 * see is one whose token dies silently, which is the failure this guards.
 */
export async function loadDueOAuthAccounts(
  db: CartethyiaDatabase,
  skewMs?: number,
): Promise<readonly { readonly id: string; readonly providerId: string }[]> {
  const rows = await db
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      expiresAt: providerOauthStates.expiresAt,
      staticToken: providerAccounts.staticToken,
    })
    .from(providerAccounts)
    .innerJoin(providerOauthStates, eq(providerOauthStates.providerAccountId, providerAccounts.id))
    .where(
      and(
        eq(providerAccounts.credentialKind, "oauth"),
        eq(providerAccounts.status, "active"),
      ),
    );
  const now = Date.now();
  return rows
    .filter((row) => {
      // A static token is used exactly as issued: there is no refresh grant to
      // run, so the sweep must not touch it. Refreshing it every pass only
      // floods the log with a guaranteed no-op. The operator clears the flag
      // when the account has a real refresh token again.
      if (row.staticToken) return false;
      if (row.expiresAt == null) return true;
      const lead = skewMs ?? refreshLeadMs(row.providerId);
      return row.expiresAt.getTime() - lead <= now;
    })
    .map((row) => ({ id: row.id, providerId: row.providerId }));
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
    // No explicit skew: the per-provider lead is applied at load time.
    const skewMs = opts.skewMs;
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
    skewMs: number | undefined,
    force: boolean,
  ): Promise<string | null> {
    const account = await loadAccountWithFreshness(this.#db, accountId, skewMs);
    if (!account || account.row.credentialKind !== "oauth") return null;
    const { row, dueAt } = account;
    // A static token is used exactly as issued and never refreshed. There is
    // nothing to re-mint, so return null — the same "cannot refresh" signal a
    // missing refresh token gives — rather than re-issuing the identical
    // credential to a forced (401) retry, which would only repeat the same
    // request against the same upstream. Dispatch still uses the stored token
    // directly (`dueAt` is undefined for a static token, so the caller's
    // refresh branch is skipped and the decrypted credential is used as-is).
    if (row.staticToken) return null;
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
    skewMs: number | undefined,
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
      // No refresh token on record: the access token is used exactly as issued
      // and cannot be re-minted, so every future refresh attempt is a
      // guaranteed no-op. Mark the account static — the same state the
      // console's toggle sets — so the sweep stops retrying it and the status
      // reads as an informational static token rather than a broken account.
      await markStaticToken(this.#db, row.id);
      pushStructuredConsoleLog("info", "OAuth token refresh skipped: static token", {
        event: "token_refresh",
        accountId: row.id,
        providerId: row.providerId,
        errorCode: "static_token",
      });
      return null;
    }
    const refreshToken = decryptCredentialToString(row.refreshCiphertext);
    try {
      const result = await refresher.refresh(
        refreshToken,
        AbortSignal.timeout(REFRESH_HTTP_TIMEOUT_MS),
        buildRefreshContext(row, refresher.requiresAccessToken === true),
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
        // A definitive refresh failure means the refresh grant is dead — but
        // the access token already on the row may still be usable as issued.
        // That is exactly the static-token case: stop refreshing, keep serving.
        // Only when the token cannot be shown to work (expired or opaque) does
        // the account need the operator, and it is parked for re-auth.
        const accessUsability = classifyAccessTokenUsability(
          row.credentialCiphertext
            ? safeDecryptCredential(row.credentialCiphertext)
            : undefined,
        );
        if (accessUsability === "usable") {
          await releaseLease(this.#db, row.id, owner);
          await markStaticToken(this.#db, row.id);
          pushStructuredConsoleLog("info", "OAuth refresh failed; access token still valid, marking static", {
            event: "token_refresh",
            accountId: row.id,
            providerId: row.providerId,
            errorCode: "static_token",
          });
        } else {
          await disableAccount(this.#db, row.id, owner, failureMessage(error));
        }
      } else {
        await releaseLease(this.#db, row.id, owner);
      }
      return null;
    }
  }
}

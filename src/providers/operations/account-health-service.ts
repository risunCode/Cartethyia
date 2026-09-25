// Account health: error classification, failure/success recording, recovery and cooldown sweeps.
import { and, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { isRecord } from "../../protocol/primitives";
import { BUDDY_PROVIDER_IDS } from "../provider-metadata";
import { healthEvents, providerAccounts } from "../../persistence/schema";

import { parseProviderResetDuration, parseUpstreamBackoff } from "../../transport/failure-policy";
import {
  resolveAccountModelCapacityCooldownMs,
  resolveAccountQuotaCooldownMs,
  resolveAccountRateLimitCooldownMs,
  resolveAccountTransientCooldownMs,
  resolveAccountUnclassifiedCooldownMs,
} from "../../config";
// ===== health/constants.ts =====
/**
 * Account status is authoritative for routing: degraded accounts remain
 * excluded until an explicit success/recovery transition clears the state.
 *
 * Every delay below is a *fallback*: an upstream `Retry-After`/reset header or
 * a duration stated in the provider message always wins. They are read through
 * `src/config.ts` so an operator can tune the health machine without a code
 * change (`CARTETHYIA_ACCOUNT_*_COOLDOWN_MS`).
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = resolveAccountRateLimitCooldownMs;
// Fallback when the error states no usable duration: deliberately short (1h,
// not 24h) — quota state is re-probed on the next failure, so an unknown
// reset cadence self-corrects instead of parking the account for a day.
const DEFAULT_QUOTA_COOLDOWN_MS = resolveAccountQuotaCooldownMs;
const MODEL_CAPACITY_COOLDOWN_MS = resolveAccountModelCapacityCooldownMs;
const TRANSIENT_ERROR_COOLDOWN_MS = resolveAccountTransientCooldownMs;
/**
 * Backoff for a failure no rule matched. Short on purpose: an unclassified
 * error is more likely a new upstream shape than a broken account, so the
 * account returns to rotation quickly instead of parking in `degraded`.
 */
const UNCLASSIFIED_COOLDOWN_MS = resolveAccountUnclassifiedCooldownMs;
/**
 * xAI Grok Build's free tier resets on a rolling 24-hour window, so its
 * exhaustion is a full-day quota cooldown — never the generic 1h fallback and
 * never `degraded` (a degraded row is a transport-shaped fault, and treating a
 * free-tier wall as one let the account re-enter rotation inside the window).
 */
const GROK_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/**
 * The buddy family (CodeBuddy `cb`/`cbcn`, WorkBuddy) answers a content-policy
 * rejection with HTTP 403 code `11140` ("request illegal" / "did not pass the
 * safety review"). Unlike a normal one-off content filter, the account stays
 * blocked for *every* subsequent invocation until the upstream cools off, so
 * the account is parked for a long cooldown instead of being left in rotation
 * to fail every request. It is a cooldown, not `disabled`: the credential is
 * valid and the block clears on its own, so an operator does not have to
 * re-enable it by hand.
 */
const POLICY_BLOCK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Providers whose `11140` policy block parks the account for a long cooldown. */

// ===== health/account-recorder.ts =====
export interface AccountHealthEventRecord {
  readonly id: string;
  readonly accountId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly errorCategory: string | null;
  readonly createdAt: string;
}

export type AccountErrorCategory =
  | "quota_exhausted"
  | "rate_limit_transient"
  | "model_capacity"
  | "auth_invalidated"
  | "policy_blocked"
  | "server_error"
  | "timeout"
  | "unknown";
export type AccountFailureOrigin = "cartethyia" | "upstream" | "network";
export type AccountFailureScope =
  | "account"
  | "provider"
  | "model"
  | "pool"
  | "tenant"
  | "request"
  | "network"
  | "unknown";

export interface AccountFailureEvidence {
  readonly origin?: AccountFailureOrigin;
  readonly scope?: AccountFailureScope;
  readonly credentialKind?: string;
  readonly providerCode?: string;
  readonly credentialEvidence?: boolean;
  readonly retryAfterMs?: number;
  readonly statusCode?: number | null;
  readonly headers?: Headers | Record<string, string> | null;
  readonly modelId?: string;
  /**
   * Provider that produced the failure. Used only for the one
   * provider-family-specific policy rule (the buddy family's `11140`
   * content-policy block), never to broaden what disables an account.
   */
  readonly providerId?: string;
}

export interface AccountErrorClassification {
  readonly category: AccountErrorCategory;
  readonly status: "cooldown" | "disabled" | "degraded";
  readonly cooldownMs: number;
  readonly reason: string;
  readonly retryAt: Date | null;
  readonly mutatesAccount: boolean;
}


export function classifyAccountError(
  error: unknown,
  options?: AccountFailureEvidence,
): AccountErrorClassification {
  const errorRecord = isRecord(error) ? error : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof errorRecord?.message === "string"
          ? errorRecord.message
          : String(error ?? "Unknown error");
  const lower = message.toLowerCase();
  const statusCode =
    options?.statusCode ??
    (typeof errorRecord?.status === "number" ? errorRecord.status : null);
  const origin = options?.origin ?? "cartethyia";
  const scope = options?.scope ?? "unknown";
  const accountEvidence =
    options?.credentialEvidence === true ||
    (options?.origin === "upstream" && options.scope === "account");
  const canMutate = origin === "upstream" && scope === "account" && accountEvidence;
  const providerCode = options?.providerCode?.toLowerCase() ?? "";

  const getHeader = (name: string): string | null => {
    const headers = options?.headers;
    if (!headers) return null;
    if ("get" in headers && typeof headers.get === "function") return headers.get(name);
    const wanted = name.toLowerCase();
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
    return entry?.[1] ?? null;
  };

  const headerCooldown =
    options?.retryAfterMs ??
    parseUpstreamBackoff({ get: getHeader });
  const messageCooldown = parseProviderResetDuration(message);
  const reason = (prefix: string): string => `${prefix}: ${message.slice(0, 160)}`;
  const result = (
    category: AccountErrorCategory,
    status: AccountErrorClassification["status"],
    cooldownMs: number,
    retryAt: Date | null,
    explanation: string,
    mutatesAccount = canMutate,
  ): AccountErrorClassification => ({
    category,
    status,
    cooldownMs,
    reason: explanation,
    retryAt,
    mutatesAccount,
  });

  // Quota-shaped provider codes/messages (e.g. xAI's
  // `subscription:free-usage-exhausted`) must win over the 401/403 auth
  // branch below: an exhausted free tier is quota exhaustion with a
  // cooldown, never a dead credential.
  const quotaSignal =
    statusCode === 402 ||
    providerCode === "insufficient_quota" ||
    providerCode === "quota_exceeded" ||
    providerCode === "subscription:free-usage-exhausted" ||
    lower.includes("insufficient_quota") ||
    lower.includes("quota_exceeded") ||
    lower.includes("usage_limit_reached") ||
    lower.includes("usage-exhausted") ||
    lower.includes("usage_exhausted") ||
    lower.includes("usage exhausted") ||
    lower.includes("free-usage") ||
    lower.includes("free usage") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("balance exhausted") ||
    lower.includes("insufficient balance") ||
    lower.includes("out of credits") ||
    lower.includes("spending limit");
  // A deterministic content-policy rejection is NOT credential invalidation.
  // CodeBuddy returns HTTP 403 with provider code 11140 ("request illegal",
  // "did not pass the safety review") — refreshing the token cannot change
  // that outcome and the account itself is healthy, so it must never flip the
  // account to auth_invalidated/disabled. Only real auth signals do.
  const policyRejection =
    providerCode === "11140" ||
    lower.includes("safety review") ||
    lower.includes("content did not pass") ||
    lower.includes("request illegal") ||
    lower.includes("content blocked");
  // ...but on the buddy family a policy block is not a one-off rejection: the
  // account keeps failing every invocation until the upstream lifts it. Park
  // the account for a long cooldown (never `disabled`) so routing stops
  // selecting it instead of retrying into the same wall.
  const policyBlock =
    policyRejection &&
    options?.providerId !== undefined &&
    BUDDY_PROVIDER_IDS.has(options.providerId.toLowerCase());
  if (policyBlock) {
    return result(
      "policy_blocked",
      "cooldown",
      POLICY_BLOCK_COOLDOWN_MS,
      new Date(Date.now() + POLICY_BLOCK_COOLDOWN_MS),
      reason("Provider content-policy block"),
      origin === "upstream",
    );
  }
  // A hosted-tool failure is a per-request outcome of the provider's own
  // server-side tool (web search, x search, web fetch), not evidence about the
  // credential or the account's quota. Some providers surface it as 403, which
  // would otherwise look like an auth signal — refreshing the token cannot fix
  // a search backend, so it must never disable the account.
  const hostedToolFailure =
    lower.includes("web_search") ||
    lower.includes("web search") ||
    lower.includes("web_search_preview") ||
    lower.includes("x_search") ||
    lower.includes("web_fetch") ||
    lower.includes("tool invocation") ||
    lower.includes("tool call failed") ||
    lower.includes("search backend");
  const authSignal =
    !quotaSignal &&
    !policyRejection &&
    !hostedToolFailure &&
    (providerCode === "authentication_failed" ||
      lower.includes("invalid_api_key") ||
      lower.includes("incorrect api key") ||
      lower.includes("invalid token") ||
      lower.includes("token revoked") ||
      lower.includes("reauthorization required") ||
      lower.includes("account deactivated") ||
      ((statusCode === 401 || statusCode === 403) && accountEvidence));
  if (authSignal) {
    const oauthRecovery =
      options?.credentialKind === "oauth" &&
      (lower.includes("expired") || lower.includes("refresh"));
    const cooldownMs = oauthRecovery ? 5 * 60 * 1000 : 0;
    return result(
      "auth_invalidated",
      oauthRecovery ? "cooldown" : "disabled",
      cooldownMs,
      oauthRecovery ? new Date(Date.now() + cooldownMs) : null,
      reason(oauthRecovery ? "OAuth credential requires refresh" : "Provider credential rejected"),
      canMutate,
    );
  }

  if (quotaSignal) {
    // xAI Grok Build's free tier resets on a rolling 24-hour window. Its
    // exhaustion is a full-day cooldown even when the provider states no
    // duration (the live 429 carries only the provider code), so it must not
    // fall back to the generic 1h default — and never `degraded`, which would
    // let the account back into rotation inside the window.
    const grokFreeTier =
      providerCode === "subscription:free-usage-exhausted" ||
      providerCode.startsWith("subscription:") ||
      lower.includes("free-usage") ||
      lower.includes("free usage") ||
      lower.includes("included free usage") ||
      lower.includes("rolling 24-hour") ||
      lower.includes("rolling 24 hour");
    const statedCooldown = messageCooldown ?? headerCooldown;
    const cooldownMs = grokFreeTier
      ? Math.max(statedCooldown ?? 0, GROK_QUOTA_COOLDOWN_MS)
      : (statedCooldown ?? DEFAULT_QUOTA_COOLDOWN_MS());
    // The caller records against the concrete account that just failed
    // upstream, so a provider-scoped quota error still cools THAT account
    // down (enables fallback to the next account). Local-origin quota must
    // never mutate an upstream account.
    return result(
      "quota_exhausted",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      reason("Provider quota exhausted"),
      origin === "upstream",
    );
  }

  const rateSignal =
    statusCode === 429 ||
    providerCode === "rate_limit_exceeded" ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("requests per minute") ||
    lower.includes("tokens per minute") ||
    lower.includes("tpm limit") ||
    lower.includes("rpm limit");
  if (rateSignal) {
    const cooldownMs = headerCooldown ?? messageCooldown ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS();
    // Same per-account reasoning as quota above: the failing account (or
    // its model, when modelId is present) backs off so routing tries the
    // next candidate instead of hammering the same key.
    return result(
      "rate_limit_transient",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      reason("Provider rate limit"),
      origin === "upstream",
    );
  }

  const capacitySignal =
    statusCode === 503 ||
    statusCode === 529 ||
    providerCode === "model_capacity" ||
    lower.includes("model overloaded") ||
    lower.includes("capacity exceeded") ||
    lower.includes("temporarily unavailable");
  if (capacitySignal) {
    const cooldownMs = headerCooldown ?? messageCooldown ?? MODEL_CAPACITY_COOLDOWN_MS();
    const modelScopedMutation =
      origin === "upstream" && scope === "account" && options?.modelId !== undefined;
    return result(
      "model_capacity",
      "cooldown",
      cooldownMs,
      new Date(Date.now() + cooldownMs),
      reason("Provider model capacity"),
      modelScopedMutation,
    );
  }

  const serverSignal =
    (statusCode !== null && statusCode >= 500 && statusCode <= 504) ||
    lower.includes("timeout") ||
    lower.includes("abort") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed");
  if (serverSignal) {
    // `degraded` still needs a `retryAt`: `sweepExpiredCooldowns` selects on
    // `cooldownUntil IS NOT NULL`, so a degraded row with a null deadline is
    // never swept back to `active` and stays visibly unhealthy until an
    // operator restores it by hand.
    return result(
      lower.includes("timeout") ? "timeout" : "server_error",
      "degraded",
      TRANSIENT_ERROR_COOLDOWN_MS(),
      new Date(Date.now() + TRANSIENT_ERROR_COOLDOWN_MS()),
      reason(`Provider ${statusCode ?? "network"} failure`),
      false,
    );
  }

  // Same reasoning as above, with the shortest backoff: an unmapped failure
  // must still be retried automatically rather than parked forever.
  return result(
    "unknown",
    "degraded",
    UNCLASSIFIED_COOLDOWN_MS(),
    new Date(Date.now() + UNCLASSIFIED_COOLDOWN_MS()),
    reason("Unclassified provider failure"),
    false,
  );
}


/** Persists one classified failure to the account row and appends a health event. */
async function persistAccountFailure(
  db: CartethyiaDatabase,
  accountId: string,
  error: unknown,
  options?: AccountFailureEvidence,
): Promise<AccountErrorClassification | null> {
  const classification = classifyAccountError(error, options);
  if (!classification.mutatesAccount) return classification;

  const persist = async (client: CartethyiaDatabase): Promise<AccountErrorClassification | null> => {
    const accountRows = await client
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account || account.status === "disabled") return null;

    const fromStatus = account.status;
    const now = new Date();

    const modelId = options?.modelId;
    const isThrottle =
      classification.category === "rate_limit_transient" ||
      classification.category === "model_capacity";
    const shouldModelCooldown = modelId !== undefined && isThrottle;

    if (shouldModelCooldown) {
      const existing = (account.modelCooldowns as Record<string, string> | null) ?? {};
      // `status`/`cooldownUntil` stay untouched: only this (account, model)
      // pair backs off, and the account remains routable for every other model.
      // The error fields ARE written, because they are what provider detail and
      // the health dialog read to explain *why* a model is cooling — without
      // them the row showed "1 model cooling" with no reason at all.
      await client
        .update(providerAccounts)
        .set({
          modelCooldowns: {
            ...existing,
            [modelId]: classification.retryAt?.toISOString() ?? new Date(Date.now() + classification.cooldownMs).toISOString(),
          },
          lastError: classification.reason,
          lastErrorCategory: classification.category,
          lastErrorAt: now,
        })
        .where(eq(providerAccounts.id, accountId));
    } else {
      await client
        .update(providerAccounts)
        .set({
          status: classification.status,
          consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1`,
          lastError: classification.reason,
          lastErrorCategory: classification.category,
          lastErrorAt: now,
          cooldownUntil: classification.retryAt,
        })
        .where(eq(providerAccounts.id, accountId));
    }

    if (typeof client.insert === "function") {
      await client.insert(healthEvents).values({
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "degraded" | "cooldown" | "disabled",
        toStatus: classification.status,
        reason: classification.reason,
        errorCategory: classification.category,
        createdAt: now,
      });
    }
    return classification;
  };

  try {
    // Kept as a capability probe, not a correctness guard: this function is
    // reachable with a partially-implemented database handle (the dispatch
    // tests pass a narrow double), and a transaction is an optimization here,
    // not a requirement — the same writes are correct without one.
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => persist(tx as CartethyiaDatabase));
    }
    return await persist(db);
  } catch {
    return null;
  }
}

/** Clears failure state after a successful dispatch; true when the account changed. */
async function persistAccountSuccess(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<boolean> {
  const mutate = async (client: CartethyiaDatabase): Promise<boolean> => {
    const rows = await client
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = rows[0];
    if (!account || account.status === "disabled") return false;
    const fromStatus = account.status;
    const hadFailures = (account.consecutiveFailures ?? 0) > 0 || account.status !== "active";
    const now = new Date();
    await client
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastSuccessAt: now,
        ...(hadFailures ? { lastRecoveredAt: now } : {}),
      })
      .where(eq(providerAccounts.id, accountId));
    if (hadFailures && typeof client.insert === "function") {
      await client.insert(healthEvents).values({
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "degraded" | "cooldown" | "disabled",
        toStatus: "active",
        reason: "Request dispatched successfully",
        errorCategory: null,
        createdAt: now,
      });
    }
    return hadFailures;
  };
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => mutate(tx as CartethyiaDatabase));
    }
    return await mutate(db);
  } catch {
    return false;
  }
}

/** Operator-initiated recovery: forces the account back to active and logs the transition. */
async function persistAccountRecovery(
  db: CartethyiaDatabase,
  accountId: string,
  reason: string,
): Promise<boolean> {
  const recover = async (client: CartethyiaDatabase): Promise<boolean> => {
    const accountRows = await client
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId))
      .limit(1);
    const account = accountRows[0];
    if (!account) return false;
    const fromStatus = account.status;
    const now = new Date();
    await client
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastRecoveredAt: now,
        // Recovery is the operator asserting the account works now, so it must
        // clear EVERY routing exclusion, not just the account-wide ones. A
        // per-model cooldown entry excludes the (account, model) pair in
        // `route-catalog.ts`, so leaving it behind kept the account blocked for
        // that model through `/v1` even though the account read `active` and a
        // direct probe (which addresses the account by id, bypassing routing
        // eligibility) succeeded. Clearing the error fields for the same reason:
        // a stale reason on a recovered row misreports the current state.
        modelCooldowns: {},
        lastError: null,
        lastErrorCategory: null,
        lastErrorAt: null,
      })
      .where(eq(providerAccounts.id, accountId));
    if (typeof client.insert === "function") {
      await client.insert(healthEvents).values({
        entityKind: "account",
        accountId,
        fromStatus: fromStatus as "active" | "degraded" | "cooldown" | "disabled",
        toStatus: "active",
        reason,
        errorCategory: null,
        createdAt: now,
      });
    }
    return true;
  };
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => recover(tx as CartethyiaDatabase));
    }
    return await recover(db);
  } catch {
    return false;
  }
}

/** Recovers accounts whose cooldown elapsed and prunes expired per-model keys. */
async function sweepExpiredCooldownsFor(db: CartethyiaDatabase): Promise<number> {
  const recover = async (client: CartethyiaDatabase): Promise<number> => {
    const now = new Date();
    const nowIso = now.toISOString();
    const expired = await client
      .select({
        id: providerAccounts.id,
        status: providerAccounts.status,
      })
      .from(providerAccounts)
      .where(
        and(
          or(
            eq(providerAccounts.status, "cooldown"),
            eq(providerAccounts.status, "degraded"),
          ),
          isNotNull(providerAccounts.cooldownUntil),
          lte(providerAccounts.cooldownUntil, now),
        ),
      );
    if (expired.length > 0) {
      await client
        .update(providerAccounts)
        .set({
          status: "active",
          consecutiveFailures: 0,
          cooldownUntil: null,
          lastRecoveredAt: now,
        })
        .where(inArray(providerAccounts.id, expired.map((account) => account.id)));
      if (typeof client.insert === "function") {
        for (let offset = 0; offset < expired.length; offset += 500) {
          await client.insert(healthEvents).values(
            expired.slice(offset, offset + 500).map((account) => ({
              entityKind: "account" as const,
              accountId: account.id,
              fromStatus: account.status,
              toStatus: "active" as const,
              reason: "Cooldown period elapsed — auto-recovered",
              errorCategory: null,
              createdAt: now,
            })),
          );
        }
      }
    }

    // Prune per-model cooldowns: remove entries whose ISO timestamp has passed.
    //
    // One set-based UPDATE rather than a SELECT followed by an UPDATE per row.
    // The per-row form issued one statement per account holding any cooldown —
    // on a deployment where many accounts are throttled at once that is the
    // sweep's dominant cost, and it all runs inside this transaction, holding
    // its locks for the whole pass. Recomputing the object in SQL does the same
    // work in one statement.
    //
    // `jsonb_typeof(...) = 'object'` guards the shape the same way the old
    // `typeof raw !== "object"` check did: a malformed value must not abort the
    // whole sweep. `IS DISTINCT FROM` keeps the update from rewriting rows it
    // did not change, so the returned row count is the number of accounts whose
    // cooldown set actually shrank — the same thing the loop counted.
    const pruned = await client
      .update(providerAccounts)
      .set({
        modelCooldowns: sql`COALESCE(
          (SELECT jsonb_object_agg(entry.key, entry.value)
           FROM jsonb_each_text(${providerAccounts.modelCooldowns}) AS entry
           WHERE entry.value > ${nowIso}),
          '{}'::jsonb
        )`,
      })
      .where(
        sql`jsonb_typeof(${providerAccounts.modelCooldowns}) = 'object'
          AND ${providerAccounts.modelCooldowns} IS DISTINCT FROM COALESCE(
            (SELECT jsonb_object_agg(entry.key, entry.value)
             FROM jsonb_each_text(${providerAccounts.modelCooldowns}) AS entry
             WHERE entry.value > ${nowIso}),
            '{}'::jsonb
          )`,
      );
    return expired.length + (pruned.rowCount ?? 0);
  };
  try {
    if (typeof db.transaction === "function") {
      return await db.transaction((tx) => recover(tx as CartethyiaDatabase));
    }
    return await recover(db);
  } catch {
    return 0;
  }
}

export async function recordAccountFailure(
  db: CartethyiaDatabase,
  accountId: string,
  error: unknown,
  options?: AccountFailureEvidence,
): Promise<AccountErrorClassification | null> {
  return persistAccountFailure(db, accountId, error, options);
}

export async function recordAccountSuccess(
  db: CartethyiaDatabase,
  accountId: string,
): Promise<boolean> {
  return persistAccountSuccess(db, accountId);
}

/**
 * Single attempt health reporter: one home for the success/failure writes
 * every dispatch attempt ends with. Success records recovery; failure
 * records with caller-supplied evidence (origin/scope classification plus
 * model id). A mutating write invalidates the route snapshot so the next
 * plan sees fresh health. Never throws — health must not fail requests.
 */
export interface AttemptHealthReport {
  readonly accountId: string | undefined;
  readonly modelId?: string;
  readonly error?: unknown;
  readonly evidence?: AccountFailureEvidence;
  readonly snapshotService?: { invalidate(): unknown };
}

export async function reportAttemptOutcome(
  db: CartethyiaDatabase,
  report: AttemptHealthReport,
): Promise<void> {
  if (!report.accountId) return;
  if (report.error === undefined) {
    const recovered = await recordAccountSuccess(db, report.accountId).catch(() => false);
    if (recovered) await report.snapshotService?.invalidate();
    return;
  }
  const classification = await recordAccountFailure(db, report.accountId, report.error, {
    ...report.evidence,
    ...(report.modelId === undefined ? {} : { modelId: report.modelId }),
  }).catch(() => null);
  if (classification?.mutatesAccount) await report.snapshotService?.invalidate();
}

export async function recoverAccount(
  db: CartethyiaDatabase,
  accountId: string,
  reason = "manual_operator_recovery",
): Promise<boolean> {
  return persistAccountRecovery(db, accountId, reason);
}

export async function sweepExpiredCooldowns(db: CartethyiaDatabase): Promise<number> {
  return sweepExpiredCooldownsFor(db);
}
export async function listAccountHealthEvents(
  db: CartethyiaDatabase,
  accountId: string,
  limit = 50,
): Promise<readonly AccountHealthEventRecord[]> {
  try {
    const rows = await db
      .select()
      .from(healthEvents)
      .where(and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)))
      .orderBy(desc(healthEvents.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId as string,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      reason: r.reason,
      errorCategory: r.errorCategory,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

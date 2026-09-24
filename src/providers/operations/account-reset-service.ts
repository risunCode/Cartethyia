/**
 * Codex and Claude saved rate-limit reset operations.
 *
 * The reverse-engineered wire contract for both families:
 *
 * - Codex: `GET/POST /wham/rate-limit-reset-credits[/consume]` on the ChatGPT
 *   backend. The consume body is `{ credit_id, redeem_request_id, account_id }`;
 *   `redeem_request_id` is the idempotency key, so a retry with the same id
 *   cannot double-spend.
 * - Claude: `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` discovers the
 *   Cedar grant (falling back to `?at_wall=1&skip_spend=1` for the Juniper
 *   session reset), then `POST /api/organizations/:orgId/reset_rate_limits`
 *   spends it with `{ program, grant_id, request_id }` (Cedar) or
 *   `{ program: "juniper_tide" }` (Juniper). The organization id comes from the
 *   credential when present, else from `/profile`.
 *
 * A successful redemption also repairs the account in place (status `active`,
 * `consecutiveFailures` cleared, `cooldownUntil` released) and writes a
 * `health_events` row either way, so the outcome lands in the account's
 * existing Health & Error Log modal.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { healthEvents, providerAccounts } from "../../persistence/schema";
import { CLAUDE_CODE_USER_AGENT } from "../integrations/claude-code/claude-fingerprint";
import { authCredential, codexJwtAccountId, text } from "../quota/quota-contracts";
import { getCodexVersion } from "./client-versions";

/** One redeemable (or already-spent) saved reset. */
export interface ResetCredit {
  readonly id: string;
  /** `available`, `redeemed`, `expired`, `paused`, `unavailable`, … */
  readonly status?: string | undefined;
  /** Human-facing card title. */
  readonly title?: string | undefined;
  /** When the provider granted this credit. */
  readonly grantedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
}

export interface ResetCreditList {
  readonly credits: readonly ResetCredit[];
  /** Credits redeemable right now, per the provider's own accounting. */
  readonly availableCount: number;
}

export interface ResetConsumeResult {
  /** True only when a reset was actually applied (`code === "reset"`). */
  readonly ok: boolean;
  readonly code: string;
  /** HTTP status of the consume call; `0` when the call was never made. */
  readonly status: number;
  readonly message?: string | undefined;
  readonly creditId?: string | undefined;
}

const CLAUDE_BETA = "oauth-2025-04-20";
const CEDAR_PROGRAM = "cedar_ember";
const JUNIPER_PROGRAM = "juniper_tide";
const ORG_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Cedar grant ids are short slugs; anything else never reaches the provider. */
const CEDAR_GRANT_ID = /^[a-z0-9_-]{1,40}$/;

export function supportsAccountReset(providerId: string): boolean {
  const norm = providerId.trim().toLowerCase();
  return norm === "codex" || norm === "claude" || norm === "anthropic";
}

function isClaude(providerId: string): boolean {
  const norm = providerId.trim().toLowerCase();
  return norm === "claude" || norm === "anthropic";
}

function claudeHeaders(access: string, json: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    "anthropic-beta": CLAUDE_BETA,
    "anthropic-version": "2023-06-01",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function codexHeaders(
  access: string,
  accountId: string | null,
  version: string,
  json: boolean,
): Record<string, string> {
  return {
    Authorization: `Bearer ${access}`,
    "User-Agent": `codex_cli_rs/${version}`,
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function codexAccess(credentialRaw: string): { access: string; accountId: string | null } {
  const fields = authCredential(credentialRaw);
  const access = text(fields.accessToken) ?? credentialRaw;
  const accountId =
    text(fields.providerAccountId) ??
    text(fields.accountId) ??
    text(fields.account_id) ??
    codexJwtAccountId(access);
  return { access, accountId };
}

function claudeAccess(credentialRaw: string): { access: string; orgId: string | null } {
  const fields = authCredential(credentialRaw);
  const access = text(fields.accessToken) ?? credentialRaw;
  const candidate = text(fields.orgId) ?? text(fields.organization_id);
  return { access, orgId: candidate && ORG_ID.test(candidate) ? candidate : null };
}

function parseCodexCredit(value: unknown): ResetCredit | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const credit: ResetCredit = { id };
  if (typeof raw.status === "string") Object.assign(credit, { status: raw.status });
  if (typeof raw.title === "string") Object.assign(credit, { title: raw.title });
  if (typeof raw.granted_at === "string") Object.assign(credit, { grantedAt: raw.granted_at });
  if (typeof raw.expires_at === "string") Object.assign(credit, { expiresAt: raw.expires_at });
  return credit;
}

/**
 * Pick the credit to spend: the available one that expires soonest. Credits are
 * perishable, so expiry order maximizes the bank's lifetime value. Available
 * credits without a parseable expiry rank after dated ones.
 */
export function pickSoonestExpiringCredit(
  credits: readonly ResetCredit[],
): ResetCredit | undefined {
  let best: ResetCredit | undefined;
  let bestExpiry = Number.POSITIVE_INFINITY;
  let undated: ResetCredit | undefined;
  for (const credit of credits) {
    if ((credit.status ?? "available") !== "available") continue;
    const expiry = credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN;
    if (Number.isNaN(expiry)) {
      undated ??= credit;
      continue;
    }
    if (expiry < bestExpiry) {
      best = credit;
      bestExpiry = expiry;
    }
  }
  return best ?? undated ?? credits[0];
}

/**
 * Lists saved rate-limit reset credits. `null` means discovery failed (non-2xx
 * or thrown); a zero-count list is an authoritative "nothing available".
 */
export async function listAccountResetCredits(
  providerId: string,
  credentialRaw: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ResetCreditList | null> {
  if (providerId.trim().toLowerCase() === "codex") {
    const { access, accountId } = codexAccess(credentialRaw);
    // Reuse the version already resolved for dispatch (`getCodexVersion`), never
    // a fresh probe: the reset path must not race an npm lookup against the
    // adapter's own warming, and the pinned fallback covers a cold cache.
    const version = getCodexVersion();
    try {
      const res = await fetcher(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        { headers: codexHeaders(access, accountId, version, false) },
      );
      if (!res.ok) return null;
      const payload = (await res.json()) as unknown;
      if (typeof payload !== "object" || payload === null) return null;
      const raw = payload as Record<string, unknown>;
      const credits: ResetCredit[] = Array.isArray(raw.credits)
        ? raw.credits
            .map(parseCodexCredit)
            .filter((credit): credit is ResetCredit => credit !== null)
        : [];
      const reported = typeof raw.available_count === "number" ? raw.available_count : null;
      const availableCount =
        reported !== null
          ? Math.max(0, Math.trunc(reported))
          : credits.filter((credit) => (credit.status ?? "available") === "available").length;
      return { credits, availableCount };
    } catch {
      return null;
    }
  }

  if (isClaude(providerId)) {
    const { access } = claudeAccess(credentialRaw);
    const cedar = await discoverCedar(access, fetcher);
    if (cedar === "failed") return null;
    if (cedar !== null) {
      const list = normalizeCedar(cedar);
      if (list.availableCount > 0 || list.credits.length > 0) return list;
    }
    const juniper = await discoverJuniper(access, fetcher);
    if (juniper !== null) return normalizeJuniper(juniper);
    // Cedar answered authoritatively with nothing to spend.
    if (cedar !== null) return normalizeCedar(cedar);
    return null;
  }

  return null;
}

interface CedarGrant {
  readonly id: string;
  readonly title?: string | undefined;
  readonly grantedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly remainingCount: number;
  readonly usable: boolean;
}

interface CedarStatus {
  readonly eligible: boolean;
  readonly grants: readonly CedarGrant[];
  readonly nextGrantId?: string | undefined;
  readonly cooldownUntil?: string | undefined;
}

/** `"failed"` = discovery error; `null` = endpoint answered "no Cedar block". */
async function discoverCedar(
  access: string,
  fetcher: typeof fetch,
): Promise<CedarStatus | "failed" | null> {
  let res: Response;
  try {
    res = await fetcher("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", {
      headers: claudeHeaders(access, false),
    });
  } catch {
    return "failed";
  }
  if (!res.ok) return "failed";
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return "failed";
  }
  if (typeof payload !== "object" || payload === null) return "failed";
  const block = (payload as Record<string, unknown>)[CEDAR_PROGRAM];
  if (block === undefined || block === null) return null;
  if (typeof block !== "object") return "failed";
  const raw = block as Record<string, unknown>;
  if (typeof raw.eligible !== "boolean") return "failed";
  const grants: CedarGrant[] = [];
  for (const candidate of Array.isArray(raw.grants) ? raw.grants : []) {
    const grant = parseCedarGrant(candidate);
    if (grant === null) return "failed";
    grants.push(grant);
  }
  const nextGrantId =
    typeof raw.next_grant_id === "string" && grants.some((g) => g.id === raw.next_grant_id)
      ? raw.next_grant_id
      : undefined;
  return {
    eligible: raw.eligible,
    grants,
    ...(nextGrantId !== undefined ? { nextGrantId } : {}),
    ...(typeof raw.cooldown_until === "string" ? { cooldownUntil: raw.cooldown_until } : {}),
  };
}

function parseCedarGrant(value: unknown): CedarGrant | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  if (typeof raw.resets_left !== "number" || !Number.isInteger(raw.resets_left) || raw.resets_left < 0) {
    return null;
  }
  const grant: CedarGrant = {
    id,
    remainingCount: raw.resets_left,
    usable: raw.usable_now === true,
  };
  if (typeof raw.label === "string" && raw.label.trim()) {
    Object.assign(grant, { title: raw.label.trim() });
  }
  if (typeof raw.starts_at === "string") Object.assign(grant, { grantedAt: raw.starts_at });
  if (typeof raw.ends_at === "string") Object.assign(grant, { expiresAt: raw.ends_at });
  return grant;
}

function normalizeCedar(status: CedarStatus): ResetCreditList {
  const now = Date.now();
  const cooldownActive =
    status.cooldownUntil !== undefined && Date.parse(status.cooldownUntil) > now;
  let availableCount = 0;
  const credits: ResetCredit[] = status.grants.map((grant) => {
    const expired = grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now;
    const selected = grant.id === status.nextGrantId;
    const usable =
      status.eligible &&
      selected &&
      grant.usable &&
      !expired &&
      !cooldownActive &&
      grant.remainingCount > 0;
    if (!expired && grant.remainingCount > 0) availableCount += grant.remainingCount;
    const credit: ResetCredit = {
      id: grant.id,
      title: grant.title ?? "Claude limit reset",
      status: expired
        ? "expired"
        : grant.remainingCount === 0
          ? "redeemed"
          : usable
            ? "available"
            : "unavailable",
    };
    if (grant.grantedAt !== undefined) Object.assign(credit, { grantedAt: grant.grantedAt });
    if (grant.expiresAt !== undefined) Object.assign(credit, { expiresAt: grant.expiresAt });
    return credit;
  });
  return { credits, availableCount };
}

interface JuniperStatus {
  readonly eligible: boolean;
  readonly arm?: "control" | "reset" | undefined;
  readonly available: boolean;
  readonly weeklyResetsAt?: string | undefined;
}

/** `null` = endpoint answered with no Juniper block; `"failed"` is folded to `null`. */
async function discoverJuniper(
  access: string,
  fetcher: typeof fetch,
): Promise<JuniperStatus | null> {
  let res: Response;
  try {
    res = await fetcher("https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1", {
      headers: claudeHeaders(access, false),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const block = (payload as Record<string, unknown>)[JUNIPER_PROGRAM];
  if (typeof block !== "object" || block === null) return null;
  const raw = block as Record<string, unknown>;
  if (typeof raw.eligible !== "boolean") return null;
  const arm = raw.arm === "control" || raw.arm === "reset" ? raw.arm : undefined;
  return {
    eligible: raw.eligible,
    ...(arm !== undefined ? { arm } : {}),
    available: raw.available === true,
    ...(typeof raw.weekly_resets_at === "string" ? { weeklyResetsAt: raw.weekly_resets_at } : {}),
  };
}

function normalizeJuniper(status: JuniperStatus): ResetCreditList {
  const usable = status.eligible && status.arm === "reset" && status.available;
  if (status.arm !== "reset") return { credits: [], availableCount: 0 };
  const credit: ResetCredit = {
    id: JUNIPER_PROGRAM,
    title: "Claude session limit reset",
    status: usable ? "available" : "unavailable",
  };
  if (status.weeklyResetsAt !== undefined) Object.assign(credit, { expiresAt: status.weeklyResetsAt });
  return { credits: [credit], availableCount: usable ? 1 : 0 };
}

/** Resolves the Claude org id from `/profile`; `null` when it cannot be read. */
async function resolveClaudeOrg(access: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const res = await fetcher("https://api.anthropic.com/api/oauth/profile", {
      headers: claudeHeaders(access, false),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const raw = payload as Record<string, unknown>;
    const organization =
      typeof raw.organization === "object" && raw.organization !== null
        ? (raw.organization as Record<string, unknown>)
        : null;
    const candidate =
      (typeof organization?.uuid === "string" ? organization.uuid : null) ??
      (typeof raw.organization_uuid === "string" ? raw.organization_uuid : null);
    const trimmed = candidate?.trim();
    return trimmed && ORG_ID.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Consumes (redeems) one saved rate-limit reset for the target account. When
 * `creditId` is omitted, the soonest-expiring available credit is selected.
 */
export async function consumeAccountResetCredit(args: {
  readonly db: CartethyiaDatabase;
  readonly accountId: string;
  readonly providerId: string;
  readonly credentialRaw: string;
  readonly creditId?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> } | undefined;
}): Promise<ResetConsumeResult> {
  const { db, accountId, providerId, credentialRaw, fetcher = globalThis.fetch } = args;
  const norm = providerId.trim().toLowerCase();

  let result: ResetConsumeResult;

  if (norm === "codex") {
    const { access, accountId: codexAccountId } = codexAccess(credentialRaw);
    const version = getCodexVersion();
    let creditId = args.creditId;
    if (!creditId) {
      const list = await listAccountResetCredits(providerId, credentialRaw, fetcher);
      creditId = pickSoonestExpiringCredit(list?.credits ?? [])?.id;
    }
    if (!creditId) {
      result = {
        ok: false,
        code: "no_credit",
        status: 0,
        message: "No available reset credits found",
      };
    } else {
      try {
        const res = await fetcher(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          {
            method: "POST",
            headers: codexHeaders(access, codexAccountId, version, true),
            body: JSON.stringify({
              credit_id: creditId,
              redeem_request_id: randomUUID(),
              ...(codexAccountId ? { account_id: codexAccountId } : {}),
            }),
          },
        );
        const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
        const code =
          body && typeof body.code === "string"
            ? body.code
            : res.ok
              ? "reset"
              : `http_${res.status}`;
        result = {
          ok: code === "reset",
          code,
          status: res.status,
          message: describeResetCode(code),
          ...(creditId !== undefined ? { creditId } : {}),
        };
      } catch (error) {
        result = {
          ok: false,
          code: "network_error",
          status: 0,
          message: error instanceof Error ? error.message : "Reset request failed",
          ...(creditId !== undefined ? { creditId } : {}),
        };
      }
    }
  } else if (isClaude(providerId)) {
    const { access, orgId: configuredOrg } = claudeAccess(credentialRaw);
    let creditId = args.creditId;
    let program: typeof CEDAR_PROGRAM | typeof JUNIPER_PROGRAM | null = null;
    if (creditId) {
      program = creditId === JUNIPER_PROGRAM ? JUNIPER_PROGRAM : CEDAR_PROGRAM;
    } else {
      const list = await listAccountResetCredits(providerId, credentialRaw, fetcher);
      const selected = pickSoonestExpiringCredit(list?.credits ?? []);
      if (selected) {
        creditId = selected.id;
        program = selected.id === JUNIPER_PROGRAM ? JUNIPER_PROGRAM : CEDAR_PROGRAM;
      }
    }
    if (!creditId || program === null) {
      result = {
        ok: false,
        code: "no_credit",
        status: 0,
        message: "No available reset credits found",
      };
    } else if (program === CEDAR_PROGRAM && !CEDAR_GRANT_ID.test(creditId)) {
      // Fail closed on a malformed grant id before contacting the provider: the
      // caller supplied it, so there is no provider outcome to log.
      return {
        ok: false,
        code: "invalid_credit",
        status: 400,
        message: "The reset credit id is not valid for Claude",
        creditId,
      };
    } else {
      const orgId = configuredOrg ?? (await resolveClaudeOrg(access, fetcher));
      if (!orgId) {
        result = {
          ok: false,
          code: "organization_unavailable",
          status: 0,
          message: "Claude organization could not be resolved",
          ...(creditId !== undefined ? { creditId } : {}),
        };
      } else {
        const body =
          program === CEDAR_PROGRAM
            ? { program: CEDAR_PROGRAM, grant_id: creditId, request_id: randomUUID() }
            : { program: JUNIPER_PROGRAM };
        try {
          const res = await fetcher(
            `https://api.anthropic.com/api/organizations/${encodeURIComponent(orgId)}/reset_rate_limits`,
            {
              method: "POST",
              headers: claudeHeaders(access, true),
              body: JSON.stringify(body),
            },
          );
          const payload = (await res.json().catch(() => undefined)) as
            | Record<string, unknown>
            | undefined;
          const rawResult = typeof payload?.result === "string" ? payload.result.trim() : null;
          const code = !res.ok
            ? res.status === 401 || res.status === 403
              ? "auth_error"
              : res.status === 429
                ? "rate_limited"
                : `http_${res.status}`
            : rawResult === null
              ? "malformed_response"
              : normalizeClaudeCode(rawResult);
          result = {
            ok: res.ok && rawResult === "reset",
            code,
            status: res.status,
            message: describeResetCode(code),
            ...(creditId !== undefined ? { creditId } : {}),
          };
        } catch (error) {
          result = {
            ok: false,
            code: "network_error",
            status: 0,
            message: error instanceof Error ? error.message : "Reset request failed",
            ...(creditId !== undefined ? { creditId } : {}),
          };
        }
      }
    }
  } else {
    return {
      ok: false,
      code: "unsupported_provider",
      status: 400,
      message: `Reset is not supported for provider ${providerId}`,
    };
  }

  await recordResetActivity(db, accountId, result, args.snapshotInvalidator);
  return result;
}

function normalizeClaudeCode(result: string): string {
  if (result === "already_used") return "already_redeemed";
  if (result === "not_limited") return "nothing_to_reset";
  return result;
}

function describeResetCode(code: string): string {
  switch (code) {
    case "reset":
      return "Rate limit reset applied";
    case "already_redeemed":
      return "That reset was already redeemed";
    case "nothing_to_reset":
      return "No window is currently limited";
    case "no_credit":
      return "No saved reset credit is available";
    case "auth_error":
      return "Provider rejected the credential";
    case "rate_limited":
      return "Provider rate-limited the reset request";
    case "organization_unavailable":
      return "Claude organization could not be resolved";
    case "invalid_credit":
      return "The reset credit id is not valid";
    case "network_error":
      return "The reset request could not reach the provider";
    default:
      return `Reset returned: ${code}`;
  }
}

/**
 * Writes the outcome to `health_events` and, on success, restores the account to
 * `active` so it rejoins dispatch rotation immediately rather than waiting out a
 * cooldown that no longer reflects reality.
 */
async function recordResetActivity(
  db: CartethyiaDatabase,
  accountId: string,
  result: ResetConsumeResult,
  snapshotInvalidator?: { invalidate(): Promise<number> },
): Promise<void> {
  const now = new Date();
  const rows = await db
    .select({ status: providerAccounts.status })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId))
    .limit(1);
  const currentStatus = rows[0]?.status ?? "active";

  if (result.ok) {
    await db
      .update(providerAccounts)
      .set({
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastRecoveredAt: now,
        // Same rule as operator recovery: a consumed reset restores routing, so
        // it clears every exclusion the routing catalog reads — including the
        // per-model cooldown entries — and the stale error fields with them.
        modelCooldowns: {},
        lastError: null,
        lastErrorCategory: null,
        lastErrorAt: null,
      })
      .where(eq(providerAccounts.id, accountId));
    await db.insert(healthEvents).values({
      entityKind: "account",
      accountId,
      fromStatus: currentStatus,
      toStatus: "active",
      reason: `Rate limit reset consumed${result.creditId ? ` (${result.creditId})` : ""}: ${result.message ?? result.code}`,
      errorCategory: null,
      createdAt: now,
    });
    await snapshotInvalidator?.invalidate();
    return;
  }

  await db.insert(healthEvents).values({
    entityKind: "account",
    accountId,
    fromStatus: currentStatus,
    toStatus: currentStatus,
    reason: `Rate limit reset failed: [${result.code}] ${result.message ?? "unknown error"}`,
    errorCategory: result.code,
    createdAt: now,
  });
}

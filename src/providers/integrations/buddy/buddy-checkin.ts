// Buddy-family daily check-in (daily login credit claim), shared by all three
// variants (`cb`, `cbcn`, `workbuddy`): same Tencent billing facade, same
// status/claim contract — only the endpoint base and identity headers differ
// per variant, and those already live in each provider's own modules.
//
// The desktop client claims a free daily credit grant once per calendar day.
// The gateway mirrors that for every stored account so an operator can see,
// per account, whether today's grant was claimed — without opening the app.
//
// Contract (from the reverse-engineered desktop bundle, vendor/research):
//   Status : POST {base}/v2/billing/meter/checkin-activity-status  body {}
//   Claim  : POST {base}/v2/billing/meter/daily-checkin            body {}
//   Envelope: { code: 0, data: { today_checked_in, streak_days, ... } }
//   "already claimed" business code is 1001 (NOT 10001 — that belongs to the
//   artifact-release API).
//
// One request per account per day: the sweep asks the status endpoint first and
// only POSTs the claim when the account has not claimed today. A successful
// claim short-circuits the day, so a restart cannot double-post.

import { providerBaseUrl } from "../../provider-metadata";
import { WORKBUDDY_DOMAIN } from "./workbuddy-shared";
import { buildWorkBuddyUserAgent, resolveWorkBuddyVersion } from "../../operations/client-versions";
import {
  buildCodeBuddyUserAgent,
  resolveCodeBuddyVersion,
} from "../../operations/client-versions";
import { codebuddyDomain, type CodeBuddyVariant } from "./codebuddy-shared";
/** Providers whose billing facade exposes the daily check-in routes. */
export const DAILY_CHECKIN_PROVIDER_IDS = ["workbuddy", "cb", "cbcn"] as const;

/** Abort budget for one upstream check-in request. */
const TIMEOUT_MS = 15_000;

export const CHECKIN_STATUS_PATH = "/billing/meter/checkin-activity-status";
export const CHECKIN_CLAIM_PATH = "/billing/meter/daily-checkin";

export type DailyCheckinState =
  | "claimed"
  | "already_claimed"
  | "not_eligible"
  | "event_ended"
  | "unavailable"
  | "error";

export interface DailyCheckinResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly state: DailyCheckinState;
  /** Credits granted by this claim; `null` when nothing was granted. */
  readonly credit: number | null;
  readonly streakDays: number | null;
  /** Provider-facing detail for the audit log; `null` on success. */
  readonly error: string | null;
}

/**
 * One `chat_request_send` growth event for `POST {base}/v2/report`.
 *
 * The growth backend scores conversation activity, not credit grants: one
 * report lights the login streak and unlocks the `first_buddy` task. The full
 * client shape is sent (not a minimal subset) because the upstream may tighten
 * validation later. `userId` is mandatory — the server answers 200 but silently
 * drops events without it.
 */
export interface BuddyActivityReportEvent {
  readonly eventCode: "chat_request_send";
  readonly timestamp: number;
  readonly reportDelay: number;
  readonly mode: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly inputLength: number;
  readonly requestModelId: string;
  readonly requestModelName: string;
  readonly isPlan: boolean;
  readonly isAutoExecuteTerminal: boolean;
  readonly isAutoModify: boolean;
  readonly codebaseEnable: boolean;
  readonly maxToken: number;
  readonly maxSteps: number;
  readonly temperature: number;
  readonly maxRetries: number;
  readonly mentionContexts: readonly unknown[];
  readonly knowledgeId: readonly unknown[];
  readonly knowledgeName: readonly unknown[];
  readonly codebaseId: string;
  readonly mentionContextCount: number;
  readonly command: string;
  readonly recommendId: string;
  readonly skillId: string;
  readonly skillCount: number;
  readonly totalCount: number;
  readonly presentAt: number;
  readonly rootRequestId: string;
  readonly parentConversationId: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly product: string;
  readonly userId: string;
}

export const ACTIVITY_REPORT_PATH = "/report";
export type BuddyActivityReportState = "reported" | "unavailable" | "error";

export interface BuddyActivityReportResult {
  readonly providerId: string;
  readonly accountId: string;
  readonly state: BuddyActivityReportState;
  /** Provider-facing detail for the audit log; `null` on success. */
  readonly error: string | null;
}

/**
 * Builds one growth-activity event. `conversationId` is caller-generated (a
 * synthetic `activity-<millis>` id is fine — the server does not validate it
 * against a real conversation); `requestId` defaults to it. The model fields
 * mirror the desktop client's own report so the event reads as a normal chat
 * send, and `userId` carries the account uid the streak is scored against.
 */
export function buildActivityReportEvent(args: {
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId?: string;
  readonly now?: number;
}): BuddyActivityReportEvent {
  const now = args.now ?? Date.now();
  const requestId = args.requestId ?? args.conversationId;
  return {
    eventCode: "chat_request_send",
    timestamp: now,
    reportDelay: 0,
    mode: "unknown",
    conversationId: args.conversationId,
    requestId,
    inputLength: 0,
    requestModelId: "default-model",
    requestModelName: "Auto",
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    presentAt: now,
    rootRequestId: args.conversationId,
    parentConversationId: args.conversationId,
    agentName: "default",
    agentType: "main",
    product: "SaaS",
    userId: args.userId,
  };
}

/**
 * Sends one growth-activity report (`POST {base}/v2/report`, i.e. the
 * versioned billing-meter path joined the same way as the status/claim
 * routes: `VERSION_SEGMENT` supplies `/v2` for the bare `workbuddy` base and
 * nothing for `cb`/`cbcn`, which already end in it).
 *
 * One report per account per day lights the login streak; more is rate-limit
 * bait, so callers enforce the daily budget (ledger + UI gating) and this
 * stays a single-shot sender.
 */
export async function fetchBuddyActivityReport(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly userId: string;
  readonly fetcher: typeof fetch;
  readonly conversationId?: string;
}): Promise<BuddyActivityReportResult> {
  const { providerId, accountId, credential, userId, fetcher } = args;
  const base = { providerId, accountId, error: null };
  if (!credential) {
    return { ...base, state: "error", error: "Account has no stored credential." };
  }
  if (!userId) {
    return { ...base, state: "error", error: "Account uid is unavailable; cannot report activity." };
  }
  const headers = {
    ...(await checkinHeaders(providerId)),
    Authorization: `Bearer ${credential}`,
    "X-User-Id": userId,
  };
  const url = `${providerBaseUrl(providerId)}${VERSION_SEGMENT[providerId] ?? ""}${ACTIVITY_REPORT_PATH}`;
  const event = buildActivityReportEvent({
    conversationId: args.conversationId ?? `activity-${Date.now()}`,
    userId,
  });
  let payload: unknown;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ...base, state: "error", error: "Credential invalid or expired." };
    }
    if (!response.ok) {
      return { ...base, state: "error", error: `Activity report API error (${response.status}).` };
    }
    payload = await response.text().then((text) => (text ? JSON.parse(text) : null));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ...base, state: "error", error: "Activity report response returned invalid JSON." };
    }
    return {
      ...base,
      state: "error",
      error: error instanceof Error ? error.message : "Activity report request failed.",
    };
  }
  const code = envelopeCode(payload);
  if (code !== null && code !== 0) {
    return { ...base, state: "error", error: `Activity report error (code ${code}).` };
  }
  return { ...base, state: "reported" };
}

/**
 * Check-in business codes, per the desktop bundle's `mapCheckinStatus()`.
 * `1001` is "already claimed" — NOT `10001`, which belongs to the
 * artifact-release API and never appears in this path.
 */
const ALREADY_CLAIMED_CODE = 1001;
const NOT_ELIGIBLE_CODE = 1002;
const EVENT_ENDED_CODE = 1003;
/** Delays between 5xx/network retries on the claim POST, mirroring the buddy gateway's own backoff. */
const CLAIM_RETRY_DELAYS_MS = [1_000, 2_000] as const;
/**
 * Check-in paths are joined onto the provider's manifest base URL, which does
 * NOT carry a consistent version segment: `cb`/`cbcn` already end in `/v2`,
 * while `workbuddy` is bare and needs `/v2` prepended. This map keeps that
 * join aligned with each provider's own quota collector, so the three
 * gateways cannot drift apart.
 */
const VERSION_SEGMENT: Readonly<Record<string, string>> = {
  workbuddy: "/v2",
  cb: "",
  cbcn: "",
};

function statusUrl(providerId: string): string {
  return `${providerBaseUrl(providerId)}${VERSION_SEGMENT[providerId] ?? ""}${CHECKIN_STATUS_PATH}`;
}

function claimUrl(providerId: string): string {
  return `${providerBaseUrl(providerId)}${VERSION_SEGMENT[providerId] ?? ""}${CHECKIN_CLAIM_PATH}`;
}

/**
 * Per-provider billing headers. The three gateways share the Tencent billing
 * facade but each risk-gates on its own client identity: WorkBuddy wants the
 * desktop brand, CodeBuddy intl wants the `IDE` identity, and CN wants `CLI`
 * (plus its own `X-Domain`). Sending the wrong one trips a 403 the same way
 * the chat surface does.
 */
async function checkinHeaders(providerId: string): Promise<Record<string, string>> {
  const common = {
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
    "X-CodeBuddy-Request": "1",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (providerId === "cb" || providerId === "cbcn") {
    const variant: CodeBuddyVariant = providerId === "cb" ? "IDE" : "CLI";
    await resolveCodeBuddyVersion();
    return {
      ...common,
      "User-Agent": buildCodeBuddyUserAgent(variant),
      "X-IDE-Type": variant,
      "X-IDE-Name": variant,
      "X-Domain": codebuddyDomain(variant),
    };
  }
  await resolveWorkBuddyVersion();
  return {
    ...common,
    "User-Agent": buildWorkBuddyUserAgent(),
    "X-Domain": WORKBUDDY_DOMAIN,
    "Accept-Language": "en-US",
  };
}

/**
 * Textual "already checked in" fingerprints. The claim POST answers `1001`
 * when the envelope is well-formed, but a locale or gateway variant can answer
 * the same state as prose (the reference gateway matches `已签到` and
 * `already…check…` case-insensitively across the message or raw body), so both
 * shapes resolve to `already_claimed` instead of a spurious error.
 */
function alreadyClaimedMessage(payload: unknown, rawBody: string): string | null {
  const message = asTextField(payload) || rawBody.trim();
  if (!message) return null;
  if (message.includes("已签到")) return message;
  const lower = message.toLowerCase();
  if (lower.includes("already") && lower.includes("check")) return message;
  return null;
}

function asTextField(payload: unknown): string | null {
  const data = asRecord(payload);
  if (!data) return null;
  const direct = data["msg"] ?? data["message"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return null;
}

/** True when the claim attempt is worth retrying: 5xx or a network throw, never a business code. */
function isRetryableClaim(error: unknown, status: number | null): boolean {
  if (status !== null) return status >= 500;
  return !(error instanceof DOMException && error.name === "AbortError");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Reads the envelope's business code; `0` means success. */
function envelopeCode(payload: unknown): number | null {
  const envelope = asRecord(payload);
  if (!envelope || !("code" in envelope)) return null;
  return asNumber(envelope["code"]);
}

/**
 * Unwraps the check-in payload. WorkBuddy returns a flat `{ code, data }`,
 * while the CodeBuddy billing facade nests Tencent's `data.Response.Data`
 * (the same double wrap its quota endpoint uses), so both shapes resolve.
 */
function envelopeData(payload: unknown): Record<string, unknown> | null {
  const data = asRecord(asRecord(payload)?.["data"]);
  if (!data) return null;
  if ("today_checked_in" in data || "active" in data || "streak_days" in data) return data;
  return asRecord(asRecord(data["Response"])?.["Data"]);
}

/**
 * Performs one account's daily check-in.
 *
 * Status first, claim only when `today_checked_in` is false — so the daily
 * budget is one request for an already-claimed account and two on claim day.
 */
export async function fetchDailyCheckin(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly credential: string;
  readonly fetcher: typeof fetch;
  /** Overrides the status probe when the caller already knows the state. */
  readonly forceClaim?: boolean;
}): Promise<DailyCheckinResult> {
  const { providerId, accountId, credential, fetcher } = args;
  const base = { providerId, accountId, credit: null, streakDays: null, error: null };

  if (!credential) {
    return { ...base, state: "error", error: "Account has no stored credential." };
  }

  // `checkinHeaders()` already carries Content-Type/Accept; only auth is
  // layered on here so the per-provider identity stays in one place.
  const headers = {
    ...(await checkinHeaders(providerId)),
    Authorization: `Bearer ${credential}`,
  };

  let status: unknown;
  try {
    const response = await fetcher(statusUrl(providerId), {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ...base, state: "error", error: "Credential invalid or expired." };
    }
    if (!response.ok) {
      return { ...base, state: "error", error: `Check-in status API error (${response.status}).` };
    }
    status = await response.json().catch(() => null);
  } catch (error) {
    return {
      ...base,
      state: "error",
      error: error instanceof Error ? error.message : "Check-in status request failed.",
    };
  }

  const statusCode = envelopeCode(status);
  if (statusCode !== null && statusCode !== 0) {
    return { ...base, state: "error", error: `Check-in status error (code ${statusCode}).` };
  }

  const data = envelopeData(status);
  if (!data) return { ...base, state: "unavailable", error: "Check-in activity unavailable." };
  if (data["active"] === false) {
    return { ...base, state: "unavailable", error: "No check-in activity running." };
  }
  const streak = asNumber(data["streak_days"]);
  if (!args.forceClaim && data["today_checked_in"] === true) {
    return { ...base, state: "already_claimed", streakDays: streak };
  }

  let claim: unknown;
  let claimRaw = "";
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetcher(claimUrl(providerId), {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        return { ...base, state: "error", error: "Credential invalid or expired." };
      }
      if (response.status >= 500 && attempt < CLAIM_RETRY_DELAYS_MS.length) {
        await sleep(CLAIM_RETRY_DELAYS_MS[attempt] as number);
        attempt += 1;
        continue;
      }
      if (!response.ok) {
        return { ...base, state: "error", error: `Daily check-in API error (${response.status}).` };
      }
      claimRaw = await response.text().catch(() => "");
      claim = claimRaw ? JSON.parse(claimRaw) : null;
      break;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ...base, state: "error", error: "Daily check-in response returned invalid JSON." };
      }
      if (isRetryableClaim(error, null) && attempt < CLAIM_RETRY_DELAYS_MS.length) {
        await sleep(CLAIM_RETRY_DELAYS_MS[attempt] as number);
        attempt += 1;
        continue;
      }
      return {
        ...base,
        state: "error",
        error: error instanceof Error ? error.message : "Daily check-in request failed.",
      };
    }
  }

  const claimCode = envelopeCode(claim);
  if (claimCode !== null && claimCode !== 0) {
    const alreadyText = alreadyClaimedMessage(claim, claimRaw);
    if (claimCode === ALREADY_CLAIMED_CODE || alreadyText) {
      return { ...base, state: "already_claimed", streakDays: streak };
    }
    if (claimCode === NOT_ELIGIBLE_CODE) return { ...base, state: "not_eligible" };
    if (claimCode === EVENT_ENDED_CODE) return { ...base, state: "event_ended" };
    return { ...base, state: "error", error: `Daily check-in error (code ${claimCode}).` };
  }
  // Some gateway variants answer the duplicate-claim state as prose with a
  // success envelope; catch that before reporting a fresh claim.
  if (claimCode === 0) {
    const alreadyText = alreadyClaimedMessage(claim, claimRaw);
    if (alreadyText) return { ...base, state: "already_claimed", streakDays: streak };
  }

  const claimData = envelopeData(claim);
  return {
    ...base,
    state: "claimed",
    credit: asNumber(claimData?.["credit"]) ?? asNumber(claimData?.["today_credit"]) ?? null,
    streakDays: asNumber(claimData?.["streak_days"]) ?? streak,
  };
}

/** Calendar-day key in UTC, matching the provider's own day boundary. */
export function checkinDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

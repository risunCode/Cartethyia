// Family-wide activity rollup for a public share link.
//
// The share page is the *recipient's* view, but the figures it needs are the
// template's: the quota is shared, so "how much has this link used" only means
// something as a total across every key the link has issued. This port answers
// that from telemetry, in one pass per shape, and never returns a raw client
// IP — the recipient is outside the tenant, so IPs leave masked regardless of
// the tenant's console privacy preference.
//
// Everything here is read-only and payload-free: token counts, model slugs,
// masked addresses. No request or response bodies cross this boundary.

import { maskClientIp } from "../../observability/redaction";
import { queryTelemetryEvents, type TelemetryEventRecord } from "../../observability/event-log";
import { isGatewayError } from "../../observability/telemetry-status";
import { utcDayStart } from "./day";

/** Totals for the whole share family, all-time plus the windows the UI draws. */
export interface ShareFamilyTotals {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Requests in the last 60 minutes. */
  readonly lastHourRequests: number;
  /** Tokens spent since 00:00 UTC — what the daily limit is compared against. */
  readonly todayTokens: number;
  /** Tokens spent since the 1st of the month UTC — the monthly limit's figure. */
  readonly monthTokens: number;
}

/** One hour bucket of the last 24 hours, oldest first. */
export interface ShareHourlyBucket {
  /** ISO instant at the top of the hour. */
  readonly hour: string;
  readonly requests: number;
  /** Input plus output tokens recorded in the hour. */
  readonly tokens: number;
}

export interface ShareTopModel {
  readonly modelId: string;
  readonly requests: number;
  readonly tokens: number;
  /** Mean tokens/sec across requests that reported a rate; null when none did. */
  readonly avgTokensPerSec: number | null;
  /** Mean time-to-first-byte in ms across requests that reported it; null when none did. */
  readonly avgTtfbMs: number | null;
}

export interface ShareTopClientIp {
  /** Always masked: this payload is served to the recipient, not the tenant. */
  readonly ip: string;
  readonly requests: number;
  readonly tokens: number;
  readonly lastSeenAt: string | null;
  /**
   * Client identity as the User-Agent named it (`claude-cli`, `node`, ...),
   * or null when no request from this address carried one. Shown instead of the
   * raw header: the full string is long, varies per patch release, and names
   * the tool rather than the machine.
   */
  readonly clientType: string | null;
}

export interface ShareFamilyStats {
  readonly totals: ShareFamilyTotals;
  readonly recipients: { readonly total: number; readonly active: number };
  /** 24 buckets, oldest first, gaps filled with zero. */
  readonly hourly: readonly ShareHourlyBucket[];
  readonly models: readonly ShareTopModel[];
  readonly clientIps: readonly ShareTopClientIp[];
}

/** Read-only family rollup for one share link. */
export interface ShareStatsPort {
  /**
   * `allowedModels`, when supplied, restricts the top-models table to the names
   * the link actually grants. A rejected request still writes a telemetry row
   * (with the requested name), so without this the table would rank models the
   * recipient can never use — every invalid name an abuser tries would show up
   * as if it were traffic. `undefined` means "no restriction" (an unrestricted
   * link); an empty array means "nothing allowed" and yields no rows.
   */
  getFamilyStats(
    tenantId: string,
    keyIds: readonly string[],
    recipients: { readonly total: number; readonly active: number },
    allowedModels?: readonly string[],
  ): Promise<ShareFamilyStats>;
}

const HOUR_MS = 3_600_000;

/**
 * Names the client behind a request from its User-Agent.
 *
 * The share page shows one label per client address, and the raw header is the
 * wrong thing to show: it runs to hundreds of characters, embeds a version that
 * changes every release, and identifies the tool rather than anything the
 * recipient can act on. The first token of the header is what clients actually
 * use as their name (`claude-cli/2.1.280`, `node`, `curl/8.7.1`), so take that,
 * drop the version, and normalise to lower case so one client's releases do not
 * read as separate clients.
 *
 * Returns null when there is nothing to name, so callers render a blank rather
 * than an empty chip.
 */
export function clientTypeFromUserAgent(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string") return null;
  const token = userAgent.trim().split(/[\s/]+/)[0]?.trim();
  if (!token) return null;
  return token.toLowerCase().slice(0, 32);
}

/**
 * Whether a requested model name is covered by one grant entry, mirroring
 * `modelRejectionReason`: a bare entry covers itself and any provider-qualified
 * spelling of it, while a qualified entry covers only itself.
 */
function modelAllowed(requested: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(requested)) return true;
  const slash = requested.lastIndexOf("/");
  return slash > 0 && allowed.has(requested.slice(slash + 1));
}

/** Start of the current UTC month. */
function utcMonthStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Top of the hour containing `now`, in UTC. */
function utcHourStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

interface FamilyRollup {
  totals: ShareFamilyTotals;
  byHour: Map<string, { requests: number; tokens: number }>;
  models: Map<string, { modelId: string; requests: number; tokens: number; rateSum: number; rateCount: number; ttfbSum: number; ttfbCount: number }>;
  ips: Map<string, { ip: string; requests: number; tokens: number; lastSeenAt: string | null; userAgent: string | null }>;
}

/**
 * One pass over a share family's events. Model ranking excludes names the grant
 * does not authorize; everything else counts every event.
 */
function rollupFamily(
  events: readonly TelemetryEventRecord[],
  bounds: { dayStart: number; monthStart: number; lastHourStart: number; windowStart: number; allowed: ReadonlySet<string> | null },
): FamilyRollup {
  const totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, lastHourRequests: 0, todayTokens: 0, monthTokens: 0 };
  const byHour = new Map<string, { requests: number; tokens: number }>();
  const models: FamilyRollup["models"] = new Map();
  const ips: FamilyRollup["ips"] = new Map();
  for (const event of events) {
    const at = new Date(event.createdAt).getTime();
    const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    totals.requests += 1;
    if (isGatewayError(event.status, event.httpStatus)) totals.errors += 1;
    totals.inputTokens += event.inputTokens ?? 0;
    totals.outputTokens += event.outputTokens ?? 0;
    totals.totalTokens += tokens;
    if (at >= bounds.lastHourStart) totals.lastHourRequests += 1;
    if (at >= bounds.dayStart) totals.todayTokens += tokens;
    if (at >= bounds.monthStart) totals.monthTokens += tokens;
    if (at >= bounds.windowStart) {
      const hour = new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString();
      const bucket = byHour.get(hour) ?? { requests: 0, tokens: 0 };
      bucket.requests += 1;
      bucket.tokens += tokens;
      byHour.set(hour, bucket);
    }
    if (event.requestedModel !== null && (bounds.allowed === null || modelAllowed(event.requestedModel, bounds.allowed))) {
      const model = models.get(event.requestedModel) ?? { modelId: event.requestedModel, requests: 0, tokens: 0, rateSum: 0, rateCount: 0, ttfbSum: 0, ttfbCount: 0 };
      model.requests += 1;
      model.tokens += tokens;
      if (event.tokensPerSec !== null) { model.rateSum += event.tokensPerSec; model.rateCount += 1; }
      if (event.ttfbMs !== null) { model.ttfbSum += event.ttfbMs; model.ttfbCount += 1; }
      models.set(event.requestedModel, model);
    }
    if (event.clientIp !== null) {
      const ip = ips.get(event.clientIp) ?? { ip: event.clientIp, requests: 0, tokens: 0, lastSeenAt: null, userAgent: null };
      ip.requests += 1;
      ip.tokens += tokens;
      // Events arrive newest first, so the first one seen is the most recent.
      if (ip.lastSeenAt === null) {
        ip.lastSeenAt = event.createdAt;
        ip.userAgent = event.userAgent;
      }
      ips.set(event.clientIp, ip);
    }
  }
  return { totals, byHour, models, ips };
}

function emptyStats(
  recipients: { readonly total: number; readonly active: number },
): ShareFamilyStats {
  return {
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastHourRequests: 0,
      todayTokens: 0,
      monthTokens: 0,
    },
    recipients,
    hourly: [],
    models: [],
    clientIps: [],
  };
}

/**
 * Row ceilings for the two ranked tables. The share page shows a fixed window
 * of rows and scrolls the rest, so the cap is a payload bound, not a display
 * one: high enough that an ordinary link shows everything, low enough that a
 * link with thousands of client addresses cannot return an unbounded payload.
 */
const TOP_MODELS_LIMIT = 50;
const TOP_IPS_LIMIT = 50;
const HOURS_WINDOW = 24;

export function createShareStatsPort(): ShareStatsPort {
  return {
    async getFamilyStats(tenantId, keyIds, recipients, allowedModels) {
      if (keyIds.length === 0) return emptyStats(recipients);
      // A share that grants a fixed set ranks only that set. Telemetry keeps the
      // requested name even when the request was refused for naming a model the
      // key may not use, so an unfiltered table would list exactly the invalid
      // names an abuser probed. `null` means the link is unrestricted.
      const allowedSet =
        allowedModels === undefined ? null : new Set(allowedModels);

      const now = new Date();
      const dayStart = utcDayStart(now);
      const monthStart = utcMonthStart(now);
      const hourStart = utcHourStart(now);
      const lastHourStart = new Date(now.getTime() - HOUR_MS);
      const windowStart = new Date(hourStart.getTime() - (HOURS_WINDOW - 1) * HOUR_MS);

      // Rank only names the grant actually authorizes. Telemetry keeps the
      // requested name even when the request was refused, so an unfiltered table
      // would list exactly the invalid names an abuser probed. Filtering before
      // the top-50 cut means refused names cannot hide a model the recipient may
      // use.
      const events = await queryTelemetryEvents({ tenantId, apiKeyIds: [...keyIds] });
      const rollup = rollupFamily(events, {
        dayStart: dayStart.getTime(),
        monthStart: monthStart.getTime(),
        lastHourStart: lastHourStart.getTime(),
        windowStart: windowStart.getTime(),
        allowed: allowedSet,
      });

      // Fill the 24 buckets in JS: only hours that saw traffic are present, and
      // a chart drawn from sparse rows would silently compress the axis.
      const byHour = rollup.byHour;
      const hourly: ShareHourlyBucket[] = [];
      for (let index = 0; index < HOURS_WINDOW; index += 1) {
        const hour = new Date(windowStart.getTime() + index * HOUR_MS).toISOString();
        const bucket = byHour.get(hour);
        hourly.push({ hour, requests: bucket?.requests ?? 0, tokens: bucket?.tokens ?? 0 });
      }

      return {
        totals: rollup.totals,
        recipients,
        hourly,
        models: [...rollup.models.values()]
          .sort((a, b) => b.requests - a.requests)
          .slice(0, TOP_MODELS_LIMIT)
          .map((row) => ({
            modelId: row.modelId,
            requests: row.requests,
            tokens: row.tokens,
            avgTokensPerSec: row.rateCount > 0 ? row.rateSum / row.rateCount : null,
            avgTtfbMs: row.ttfbCount > 0 ? Math.round(row.ttfbSum / row.ttfbCount) : null,
          })),
        clientIps: [...rollup.ips.values()]
          .sort((a, b) => b.requests - a.requests)
          .slice(0, TOP_IPS_LIMIT)
          .map((row) => ({
            ip: maskClientIp(row.ip),
            requests: row.requests,
            tokens: row.tokens,
            lastSeenAt: row.lastSeenAt,
            clientType: clientTypeFromUserAgent(row.userAgent),
          })),
      };
    },
  };
}

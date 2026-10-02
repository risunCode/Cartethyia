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

import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { maskClientIp } from "../../observability/redaction";
import { gatewayErrorSql } from "../../observability/telemetry-status";
import { telemetryEvents } from "../../persistence/schema";

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

/** Escape LIKE metacharacters so a model id matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

/** Start of the current UTC day. */
function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
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

export function createShareStatsPort(db: CartethyiaDatabase): ShareStatsPort {
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

      const familyScope = and(
        eq(telemetryEvents.tenantId, tenantId),
        inArray(telemetryEvents.apiKeyId, [...keyIds]),
      );
      // Rank only names the grant actually authorizes, mirroring
      // `modelRejectionReason`: a bare entry (`deepseek-v4.1-flash`) covers
      // itself and any provider-qualified spelling of it, while a qualified
      // entry (`opencode-go/deepseek-v4.1-flash`) covers only itself — the bare
      // name it ends with is a *different*, refused request. So a refused probe
      // never ranks. Pushed into SQL (not applied after the query) so refused
      // names cannot fill the top-50 window and hide a model the recipient may
      // use.
      const modelMatch =
        allowedSet === null
          ? null
          : [...allowedSet].flatMap((name) =>
              name.lastIndexOf("/") < 0
                ? [
                    sql`${telemetryEvents.requestedModel} = ${name}`,
                    sql`${telemetryEvents.requestedModel} like ${`%/${escapeLike(name)}`} escape '\\'`,
                  ]
                : [sql`${telemetryEvents.requestedModel} = ${name}`],
            );
      const tokenSum = sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`;
      const tokenSumFiltered = (condition: ReturnType<typeof sql> | boolean) =>
        sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)) filter (where ${condition}), 0)`;

      const [totalsRows, hourlyRows, modelRows, ipRows] = await Promise.all([
        db
          .select({
            requests: sql<number>`count(*)`,
            errors: sql<number>`count(*) filter (where ${gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus)})`,
            inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
            lastHourRequests: sql<number>`count(*) filter (where ${telemetryEvents.createdAt} >= ${lastHourStart})`,
            todayTokens: tokenSumFiltered(sql`${telemetryEvents.createdAt} >= ${dayStart}`),
            monthTokens: tokenSumFiltered(sql`${telemetryEvents.createdAt} >= ${monthStart}`),
          })
          .from(telemetryEvents)
          .where(familyScope),
        db
          .select({
            hour: sql<string>`date_trunc('hour', ${telemetryEvents.createdAt})`,
            requests: sql<number>`count(*)`,
          })
          .from(telemetryEvents)
          .where(and(familyScope, gte(telemetryEvents.createdAt, windowStart)))
          .groupBy(sql`date_trunc('hour', ${telemetryEvents.createdAt})`),
        db
          .select({
            modelId: telemetryEvents.requestedModel,
            requests: sql<number>`count(*)`,
            tokens: tokenSum,
            // Averages over the rows that actually reported each metric, not
            // over every request: a non-streaming request has no rate, and a
            // failed one no first byte, so dividing by `count(*)` would drag a
            // healthy model's averages down with unrelated rows.
            avgTokensPerSec: sql<number | null>`avg(${telemetryEvents.tokensPerSec})`,
            avgTtfbMs: sql<number | null>`avg(${telemetryEvents.ttfbMs})`,
          })
          .from(telemetryEvents)
          .where(
            and(
              familyScope,
              sql`${telemetryEvents.requestedModel} is not null`,
              ...(modelMatch === null
                ? []
                : [modelMatch.length === 0 ? sql`false` : or(...modelMatch)]),
            ),
          )
          .groupBy(telemetryEvents.requestedModel)
          .orderBy(desc(sql`count(*)`))
          .limit(TOP_MODELS_LIMIT),
        db
          .select({
            clientIp: telemetryEvents.clientIp,
            requests: sql<number>`count(*)`,
            tokens: tokenSum,
            lastSeenAt: sql<string | null>`max(${telemetryEvents.createdAt})`,
            // The header from the most recent request from this address: the
            // client's current identity, not whichever one it happened to send
            // first. `array_agg` skips nulls, so an address that never sent one
            // still yields a row.
            userAgent: sql<
              string | null
            >`(array_agg(${telemetryEvents.userAgent} order by ${telemetryEvents.createdAt} desc))[1]`,
          })
          .from(telemetryEvents)
          .where(and(familyScope, sql`${telemetryEvents.clientIp} is not null`))
          .groupBy(telemetryEvents.clientIp)
          .orderBy(desc(sql`count(*)`))
          .limit(TOP_IPS_LIMIT),
      ]);

      const totals = totalsRows[0];      // Fill the 24 buckets in JS: SQL only returns hours that saw traffic, and
      // a chart drawn from sparse rows would silently compress the axis.
      const byHour = new Map<string, number>();
      for (const row of hourlyRows) {
        byHour.set(new Date(row.hour).toISOString(), Number(row.requests ?? 0));
      }
      const hourly: ShareHourlyBucket[] = [];
      for (let index = 0; index < HOURS_WINDOW; index += 1) {
        const hour = new Date(windowStart.getTime() + index * HOUR_MS).toISOString();
        hourly.push({ hour, requests: byHour.get(hour) ?? 0 });
      }

      return {
        totals: {
          requests: Number(totals?.requests ?? 0),
          errors: Number(totals?.errors ?? 0),
          inputTokens: Number(totals?.inputTokens ?? 0),
          outputTokens: Number(totals?.outputTokens ?? 0),
          totalTokens: Number(totals?.inputTokens ?? 0) + Number(totals?.outputTokens ?? 0),
          lastHourRequests: Number(totals?.lastHourRequests ?? 0),
          todayTokens: Number(totals?.todayTokens ?? 0),
          monthTokens: Number(totals?.monthTokens ?? 0),
        },
        recipients,
        hourly,
        models: modelRows.flatMap((row) =>
          typeof row.modelId !== "string"
            ? []
            : [
                {
                  modelId: row.modelId,
                  requests: Number(row.requests ?? 0),
                  tokens: Number(row.tokens ?? 0),
                  avgTokensPerSec: row.avgTokensPerSec === null ? null : Number(row.avgTokensPerSec),
                  avgTtfbMs: row.avgTtfbMs === null ? null : Math.round(Number(row.avgTtfbMs)),
                },
              ],
        ),
        clientIps: ipRows.flatMap((row) =>
          typeof row.clientIp !== "string"
            ? []
            : [
                {
                  ip: maskClientIp(row.clientIp),
                  requests: Number(row.requests ?? 0),
                  tokens: Number(row.tokens ?? 0),
                  lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt).toISOString(),
                  clientType: clientTypeFromUserAgent(row.userAgent),
                },
              ],
        ),
      };
    },
  };
}

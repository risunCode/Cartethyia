import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { ApiKeyRecord } from "../../persistence/api-key-store";
import { CachedPreferencesReader, DrizzlePreferencesReader } from "../../persistence/tenant-preferences";
import { maskClientIp } from "../../observability/redaction";
import { telemetryEvents, telemetryUsageTotals } from "../../persistence/schema";
import { shouldMaskClientIp } from "../shared/ip-privacy";

export interface SharedKeyTokenUsage {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SharedKeySummary {
  readonly id: string;
  readonly label: string;
  readonly keyPrefix: string | null;
  readonly issuedClientIp: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly allTime: SharedKeyTokenUsage;
  readonly today: SharedKeyTokenUsage;
  readonly lastUsedAt: string | null;
}

export interface SharedKeyModelUsage {
  readonly providerId: string | null;
  readonly modelId: string;
  readonly retainedRequests: number;
  readonly retainedErrors: number;
  readonly retainedTokens: number;
  readonly todayRequests: number;
  readonly todayErrors: number;
  readonly todayTokens: number;
}

export interface SharedKeyRequestEvent {
  readonly requestId: string;
  readonly startedAt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: string;
  readonly httpStatus?: number;
  readonly errorCategory?: string;
  readonly errorOrigin?: string;
  readonly clientIp?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SharedKeyActivityDetail {
  readonly models: readonly SharedKeyModelUsage[];
  readonly requests: readonly SharedKeyRequestEvent[];
}

/** Read-only share-recipient telemetry; payloads and credential material never cross this boundary. */
export interface ShareActivityPort {
  getSharedKeySummaries(
    tenantId: string,
    children: readonly ApiKeyRecord[],
  ): Promise<readonly SharedKeySummary[]>;
  getSharedKeyDetail(tenantId: string, childKeyId: string): Promise<SharedKeyActivityDetail>;
}

function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function tokenUsage(row: {
  readonly requests: number | string | null;
  readonly errors: number | string | null;
  readonly inputTokens: number | string | null;
  readonly outputTokens: number | string | null;
} | undefined): SharedKeyTokenUsage {
  const inputTokens = Number(row?.inputTokens ?? 0);
  const outputTokens = Number(row?.outputTokens ?? 0);
  return {
    requests: Number(row?.requests ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function createShareUsagePort(db: CartethyiaDatabase): ShareActivityPort {
  const preferences = new CachedPreferencesReader(new DrizzlePreferencesReader(db));
  return {
    async getSharedKeySummaries(tenantId, children) {
      if (children.length === 0) return [];
      const childIds = children.map((child) => child.id);
      const todayStart = utcDayStart(new Date());
      const [todayRows, lifetimeRows, hideClientIp] = await Promise.all([
        db
          .select({
            apiKeyId: telemetryEvents.apiKeyId,
            requests: sql<number>`count(*)`,
            errors: sql<number>`count(*) filter (where ${telemetryEvents.status} in ('failed', 'truncated'))`,
            inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
          })
          .from(telemetryEvents)
          .where(
            and(
              eq(telemetryEvents.tenantId, tenantId),
              inArray(telemetryEvents.apiKeyId, childIds),
              gte(telemetryEvents.createdAt, todayStart),
            ),
          )
          .groupBy(telemetryEvents.apiKeyId),
        db
          .select({
            apiKeyId: telemetryUsageTotals.entityId,
            requests: telemetryUsageTotals.requests,
            errors: telemetryUsageTotals.errors,
            inputTokens: telemetryUsageTotals.inputTokens,
            outputTokens: telemetryUsageTotals.outputTokens,
            lastUsedAt: telemetryUsageTotals.lastUsedAt,
          })
          .from(telemetryUsageTotals)
          .where(
            and(
              eq(telemetryUsageTotals.tenantId, tenantId),
              eq(telemetryUsageTotals.identityType, "api_key"),
              inArray(telemetryUsageTotals.entityId, childIds),
            ),
          ),
        shouldMaskClientIp(preferences, tenantId),
      ]);
      const todayByKey = new Map<string, (typeof todayRows)[number]>();
      for (const row of todayRows) {
        if (row.apiKeyId !== null) todayByKey.set(row.apiKeyId, row);
      }
      const lifetimeByKey = new Map(lifetimeRows.map((row) => [row.apiKeyId, row]));
      return children.map((child) => {
        const allTime = tokenUsage(lifetimeByKey.get(child.id));
        const today = tokenUsage(todayByKey.get(child.id));
        const issuedClientIp = child.issuedClientIp;
        const lastUsedAt = lifetimeByKey.get(child.id)?.lastUsedAt;
        return {
          id: child.id,
          label: child.label,
          keyPrefix: child.keyPrefix ?? null,
          issuedClientIp:
            issuedClientIp === undefined
              ? null
              : hideClientIp
                ? maskClientIp(issuedClientIp)
                : issuedClientIp,
          createdAt: child.createdAt.toISOString(),
          revokedAt: child.revokedAt?.toISOString() ?? null,
          allTime,
          today,
          lastUsedAt: lastUsedAt?.toISOString() ?? null,
        };
      });
    },

    async getSharedKeyDetail(tenantId, childKeyId) {
      const todayStart = utcDayStart(new Date());
      const modelScope = and(
        eq(telemetryEvents.tenantId, tenantId),
        eq(telemetryEvents.apiKeyId, childKeyId),
        isNotNull(telemetryEvents.requestedModel),
      );
      const requestScope = and(
        eq(telemetryEvents.tenantId, tenantId),
        eq(telemetryEvents.apiKeyId, childKeyId),
      );
      const [models, requests, hideClientIp] = await Promise.all([
        db
          .select({
            providerId: telemetryEvents.providerId,
            modelId: telemetryEvents.requestedModel,
            retainedRequests: sql<number>`count(*)`,
            retainedErrors: sql<number>`count(*) filter (where ${telemetryEvents.status} in ('failed', 'truncated'))`,
            retainedTokens: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`,
            todayRequests: sql<number>`count(*) filter (where ${telemetryEvents.createdAt} >= ${todayStart})`,
            todayErrors: sql<number>`count(*) filter (where ${telemetryEvents.createdAt} >= ${todayStart} and ${telemetryEvents.status} in ('failed', 'truncated'))`,
            todayTokens: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)) filter (where ${telemetryEvents.createdAt} >= ${todayStart}), 0)`,
          })
          .from(telemetryEvents)
          .where(modelScope)
          .groupBy(telemetryEvents.providerId, telemetryEvents.requestedModel)
          .orderBy(desc(sql`count(*)`))
          .limit(10),
        db
          .select({
            requestId: telemetryEvents.requestId,
            startedAt: telemetryEvents.createdAt,
            providerId: telemetryEvents.providerId,
            modelId: telemetryEvents.requestedModel,
            status: telemetryEvents.status,
            httpStatus: telemetryEvents.httpStatus,
            errorCategory: telemetryEvents.errorCategory,
            errorOrigin: telemetryEvents.errorOrigin,
            clientIp: telemetryEvents.clientIp,
            inputTokens: telemetryEvents.inputTokens,
            outputTokens: telemetryEvents.outputTokens,
          })
          .from(telemetryEvents)
          .where(requestScope)
          .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
          .limit(20),
        shouldMaskClientIp(preferences, tenantId),
      ]);
      return {
        models: models.flatMap((row) =>
          typeof row.modelId !== "string"
            ? []
            : [{
                providerId: row.providerId,
                modelId: row.modelId,
                retainedRequests: Number(row.retainedRequests ?? 0),
                retainedErrors: Number(row.retainedErrors ?? 0),
                retainedTokens: Number(row.retainedTokens ?? 0),
                todayRequests: Number(row.todayRequests ?? 0),
                todayErrors: Number(row.todayErrors ?? 0),
                todayTokens: Number(row.todayTokens ?? 0),
              }],
        ),
        requests: requests.map((row) => {
          const inputTokens = row.inputTokens ?? 0;
          const outputTokens = row.outputTokens ?? 0;
          return {
            requestId: row.requestId,
            startedAt: row.startedAt.toISOString(),
            ...(row.providerId ? { providerId: row.providerId } : {}),
            ...(row.modelId ? { modelId: row.modelId } : {}),
            status: row.status ?? "unknown",
            ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
            ...(row.errorCategory ? { errorCategory: row.errorCategory } : {}),
            ...(row.errorOrigin ? { errorOrigin: row.errorOrigin } : {}),
            ...(row.clientIp
              ? { clientIp: hideClientIp ? maskClientIp(row.clientIp) : row.clientIp }
              : {}),
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
        }),
      };
    },
  };
}

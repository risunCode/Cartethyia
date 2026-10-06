import { and, eq, inArray } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { ApiKeyRecord } from "../../persistence/stores/api-key-store";
import { CachedPreferencesReader, DrizzlePreferencesReader } from "../../persistence/tenant-preferences";
import { maskClientIp } from "../../observability/redaction";
import { queryTelemetryEvents, type TelemetryEventRecord } from "../../observability/event-log";
import { isGatewayError } from "../../observability/telemetry-status";
import { telemetryUsageTotals } from "../../persistence/schema";
import { shouldMaskClientIp } from "../shared/ip-privacy";
import { utcDayStart } from "./day";

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

/** Folds one event into a per-key usage bucket. */
function addEventUsage(bucket: SharedKeyTokenUsage, event: TelemetryEventRecord): SharedKeyTokenUsage {
  const inputTokens = bucket.inputTokens + (event.inputTokens ?? 0);
  const outputTokens = bucket.outputTokens + (event.outputTokens ?? 0);
  return {
    requests: bucket.requests + 1,
    errors: bucket.errors + (isGatewayError(event.status, event.httpStatus) ? 1 : 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
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
      const [todayEvents, lifetimeRows, hideClientIp] = await Promise.all([
        queryTelemetryEvents({ tenantId, apiKeyIds: childIds, since: todayStart }),
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
      const todayByKey = new Map<string, SharedKeyTokenUsage>();
      for (const event of todayEvents) {
        if (event.apiKeyId === null) continue;
        const bucket = todayByKey.get(event.apiKeyId) ?? tokenUsage(undefined);
        todayByKey.set(event.apiKeyId, addEventUsage(bucket, event));
      }
      const lifetimeByKey = new Map(lifetimeRows.map((row) => [row.apiKeyId, row]));
      return children.map((child) => {
        const allTime = tokenUsage(lifetimeByKey.get(child.id));
        const today = todayByKey.get(child.id) ?? tokenUsage(undefined);
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
      const todayStart = utcDayStart(new Date()).getTime();
      const [events, hideClientIp] = await Promise.all([
        queryTelemetryEvents({ tenantId, apiKeyIds: [childKeyId] }),
        shouldMaskClientIp(preferences, tenantId),
      ]);
      const models = new Map<string, {
        providerId: string | null;
        modelId: string;
        retainedRequests: number;
        retainedErrors: number;
        retainedTokens: number;
        todayRequests: number;
        todayErrors: number;
        todayTokens: number;
      }>();
      for (const event of events) {
        if (event.requestedModel === null) continue;
        const key = `${event.providerId ?? ""}\u0000${event.requestedModel}`;
        const bucket = models.get(key) ?? {
          providerId: event.providerId,
          modelId: event.requestedModel,
          retainedRequests: 0,
          retainedErrors: 0,
          retainedTokens: 0,
          todayRequests: 0,
          todayErrors: 0,
          todayTokens: 0,
        };
        const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
        const error = isGatewayError(event.status, event.httpStatus);
        bucket.retainedRequests += 1;
        if (error) bucket.retainedErrors += 1;
        bucket.retainedTokens += tokens;
        if (new Date(event.createdAt).getTime() >= todayStart) {
          bucket.todayRequests += 1;
          if (error) bucket.todayErrors += 1;
          bucket.todayTokens += tokens;
        }
        models.set(key, bucket);
      }
      return {
        models: [...models.values()]
          .sort((a, b) => b.retainedRequests - a.retainedRequests)
          .slice(0, 10),
        requests: events.slice(0, 20).map((event) => {
          const inputTokens = event.inputTokens ?? 0;
          const outputTokens = event.outputTokens ?? 0;
          return {
            requestId: event.requestId,
            startedAt: event.createdAt,
            ...(event.providerId ? { providerId: event.providerId } : {}),
            ...(event.requestedModel ? { modelId: event.requestedModel } : {}),
            status: event.status ?? "unknown",
            ...(event.httpStatus === null ? {} : { httpStatus: event.httpStatus }),
            ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}),
            ...(event.errorOrigin ? { errorOrigin: event.errorOrigin } : {}),
            ...(event.clientIp
              ? { clientIp: hideClientIp ? maskClientIp(event.clientIp) : event.clientIp }
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

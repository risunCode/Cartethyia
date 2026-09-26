import { consoleRequest, fetchSessionUser } from "../api";
import type { ApiErrorShape } from "../api";
import { queryKeys } from "../query-keys";
import type { SessionUser, UsageDimension } from "../contracts";
import { QUERY_OPTIONS, assertAuditListPage, assertSystemHealth, assertUsageBy, assertUsageChart, assertUsageRequestDetail, assertUsageRequests, assertUsageSummary, querySignal } from "./common";
import { useQuery } from "@tanstack/react-query";


/** Loads the current signed-in console user, including `isPlatformAdmin`,
 * so pages can hide (never solely rely on hiding — the server remains the
 * real enforcement) controls the user's scope cannot use. */
export function useSessionUser() {
  return useQuery<SessionUser | null>({
    queryKey: queryKeys.session.current,
    queryFn: () => fetchSessionUser(),
    staleTime: 60_000,
    gcTime: 300_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Loads current system health and refreshes it on the dashboard cadence. */
export function useSystemHealth() {
  return useQuery({
    queryKey: queryKeys.system.health,
    queryFn: (context) =>
      consoleRequest<unknown>("/system/health", { signal: querySignal(context) }).then(
        assertSystemHealth,
      ),
    ...QUERY_OPTIONS,
    refetchInterval: 15_000,
  });
}

/** Loads the 20-beta-style usage summary for a period. */
export function useUsageSummary(period: string) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.summary(period),
    queryFn: (context) =>
      consoleRequest<unknown>(`/system/usage/summary?period=${encodeURIComponent(period)}`, {
        signal: querySignal(context),
      }).then(assertUsageSummary),
    ...QUERY_OPTIONS,
    refetchInterval: 10_000,
  });
}

/** Loads time-series buckets for the traffic chart. */
export function useUsageChart(period: string) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.chart(period),
    queryFn: (context) =>
      consoleRequest<unknown>(`/system/usage/chart?period=${encodeURIComponent(period)}`, {
        signal: querySignal(context),
      }).then(assertUsageChart),
    ...QUERY_OPTIONS,
    refetchInterval: 10_000,
  });
}

/** Loads one usage breakdown dimension (see `USAGE_DIMENSIONS`). */
export function useUsageBy(period: string, dimension: UsageDimension) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.by(period, dimension),
    queryFn: (context) =>
      consoleRequest<unknown>(
        `/system/usage/by-${dimension}?period=${encodeURIComponent(period)}`,
        { signal: querySignal(context) },
      ).then(assertUsageBy),
    ...QUERY_OPTIONS,
    refetchInterval: 10_000,
  });
}

/** Loads the most recent requests for the live table. */
export function useUsageRequests(
  period: string,
  limit = 50,
  httpStatus?: number | null,
) {
  const statusParam = httpStatus === null || httpStatus === undefined
    ? ""
    : `&httpStatus=${encodeURIComponent(String(httpStatus))}`;
  return useQuery({
    queryKey: queryKeys.usageAnalytics.requests(period, limit, httpStatus),
    queryFn: (context) =>
      consoleRequest<unknown>(
        `/system/usage/requests?period=${encodeURIComponent(period)}&limit=${encodeURIComponent(String(limit))}${statusParam}`,
        { signal: querySignal(context) },
      ).then(assertUsageRequests),
    ...QUERY_OPTIONS,
    refetchInterval: 5_000,
  });
}

/** Loads one request's detail for the inspector dialog. */
export function useUsageRequestDetail(requestId: string | null) {
  return useQuery({
    queryKey: queryKeys.usageAnalytics.requestDetail(requestId ?? "_"),
    queryFn: (context) => {
      if (!requestId) throw { status: 400, code: "invalid_request", message: "Request is required" } satisfies ApiErrorShape;
      return consoleRequest<unknown>(`/system/usage/requests/${encodeURIComponent(requestId)}`, {
        signal: querySignal(context),
      }).then(assertUsageRequestDetail);
    },
    enabled: requestId !== null,
    ...QUERY_OPTIONS,
  });
}

export function useAuditTrail(filters?: {
  action?: string;
  actor?: string;
  cursor?: string;
  limit?: number;
}) {
  return useQuery({
    queryKey: queryKeys.audit.list(filters ?? {}),
    queryFn: (context) => {
      const search = new URLSearchParams();
      if (filters?.action) search.set("action", filters.action);
      if (filters?.actor) search.set("actor", filters.actor);
      if (filters?.cursor) search.set("cursor", filters.cursor);
      if (filters?.limit) search.set("limit", String(filters.limit));
      const suffix = search.toString() ? `?${search.toString()}` : "";
      return consoleRequest<unknown>(`/audit${suffix}`, { signal: querySignal(context) }).then(
        assertAuditListPage,
      );
    },
    ...QUERY_OPTIONS,
  });
}

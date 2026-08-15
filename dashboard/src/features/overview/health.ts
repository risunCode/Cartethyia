import { useQuery } from "@tanstack/solid-query";

import { ApiError } from "../../lib/api";
import { consoleApi, ConsoleContractError } from "../../lib/console-api";
import { qk } from "../../lib/query-keys";

export type DashboardHealthState = "ready" | "degraded" | "offline" | "unknown";

export interface DashboardSummaryView {
  version: string | null;
  environment: string | null;
  uptime: string | null;
  accountCount: number | null;
  proxyCount: number | null;
  apiKeyCount: number | null;
  health: {
    status: DashboardHealthState;
    dependencies: Readonly<Record<string, DashboardHealthState>>;
  };
}

export type DashboardViewState =
  | "loading"
  | "ready"
  | "degraded"
  | "forbidden"
  | "offline"
  | "unknown"
  | "unavailable"
  | "malformed"
  | "empty";

export interface DashboardHealthResult {
  data: DashboardSummaryView | undefined;
  state: DashboardViewState;
  isLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHealthState(value: unknown): DashboardHealthState {
  if (value === "ready" || value === "degraded" || value === "offline") return value;
  return "unknown";
}

/** Parse only the closed dashboard summary shape, preserving missing facts as unknown. */
export function parseDashboardSummaryView(value: unknown): DashboardSummaryView {
  if (value === null || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0)) {
    throw new ConsoleContractError("empty_response", "dashboard summary is empty", 204);
  }
  if (!isRecord(value)) {
    throw new ConsoleContractError("invalid_contract", "dashboard summary is invalid", 502);
  }

  const rawHealth = isRecord(value.health) ? value.health : {};
  const dependencies: Record<string, DashboardHealthState> = {};
  if (isRecord(rawHealth.dependencies)) {
    for (const [name, state] of Object.entries(rawHealth.dependencies)) dependencies[name] = parseHealthState(state);
  }

  return {
    version: typeof value.version === "string" && value.version.length > 0 ? value.version : null,
    environment: typeof value.environment === "string" && value.environment.length > 0 ? value.environment : null,
    uptime: typeof value.uptime === "string" && value.uptime.length > 0 ? value.uptime : null,
    accountCount: parseFinite(value.accountCount),
    proxyCount: parseFinite(value.proxyCount),
    apiKeyCount: parseFinite(value.apiKeyCount),
    health: { status: parseHealthState(rawHealth.status), dependencies },
  };
}

/** Convert a transport or contract failure into a truthful dashboard state. */
export function dashboardErrorState(error: unknown): Exclude<DashboardViewState, "loading" | "ready" | "unknown"> {
  if (error instanceof ConsoleContractError) return error.code === "empty_response" ? "empty" : "malformed";
  if (error instanceof ApiError) {
    if (error.status === 403) return "forbidden";
    if (error.status === 404) return "unavailable";
    if (error.status >= 500 || error.code === "unavailable") return "degraded";
    return "malformed";
  }
  return "offline";
}

/** Read dashboard health while retaining the last accepted response through refresh failures. */
export function useDashboardHealth(): DashboardHealthResult {
  const query = useQuery<DashboardSummaryView>(() => ({
    queryKey: qk.health.status,
    queryFn: async ({ signal }): Promise<DashboardSummaryView> => parseDashboardSummaryView(await consoleApi<unknown>("/dashboard", { signal })),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  }));

  let state: DashboardViewState = "loading";
  if (query.data) state = query.error ? dashboardErrorState(query.error) : query.data.health.status;
  else if (query.error) state = dashboardErrorState(query.error);
  else if (!query.isPending) state = "unknown";

  return {
    data: query.data,
    state,
    isLoading: query.isPending && !query.data,
    isRefreshing: query.isFetching,
    isStale: query.isStale || Boolean(query.error && query.data),
    error: query.error,
    refetch: query.refetch,
  };
}

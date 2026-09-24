import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  CreateNetworkPoolRequest,
  HealthCheckResult,
  NetworkPoolResponse,
  PoolHealthEvent,
  PoolStrategySetting,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, assertNetworkPools, assertPoolStrategy, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Loads the list of network pools for the tenant. */
export function useNetworkPools() {
  return useQuery<NetworkPoolResponse[], ApiErrorShape>({
    queryKey: queryKeys.network.pools,
    queryFn: (context) =>
      consoleRequest<unknown>("/network/pools", { signal: querySignal(context) }).then(
        assertNetworkPools,
      ),
    staleTime: QUERY_OPTIONS.staleTime,
    gcTime: QUERY_OPTIONS.gcTime,
  });
}

/** Creates a network pool and refreshes the pools list. */
export function useCreateNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<NetworkPoolResponse, ApiErrorShape, CreateNetworkPoolRequest>({
    mutationFn: (request) =>
      consoleRequest<NetworkPoolResponse>("/network/pools", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}

/** Ad-hoc probe of a network pool endpoint without saving. */
export function useProbeAdHocNetworkPool() {
  return useMutation<HealthCheckResult, ApiErrorShape, CreateNetworkPoolRequest>({
    mutationFn: (request) =>
      consoleRequest<HealthCheckResult>("/network/pools/test", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}
/** Updates a network pool through the existing partial-update contract. */
export function useUpdateNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<
    NetworkPoolResponse,
    ApiErrorShape,
    { poolId: string; request: Partial<CreateNetworkPoolRequest> }
  >({
    mutationFn: ({ poolId, request }) =>
      consoleRequest<NetworkPoolResponse>(`/network/pools/${encodeURIComponent(poolId)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}

/** Loads recent health and recovery activity for a pool. */
export function useNetworkPoolHealthEvents(poolId: string | undefined) {
  return useQuery<readonly PoolHealthEvent[], ApiErrorShape>({
    queryKey: [...queryKeys.network.pools, poolId, "health-events"],
    queryFn: (context) =>
      consoleRequest<readonly PoolHealthEvent[]>(
        `/network/pools/${encodeURIComponent(poolId ?? "")}/health-events`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(poolId),
    ...QUERY_OPTIONS,
    refetchInterval: 10_000,
  });
}

/** Recovers an automatically flagged proxy pool. */
export function useRecoverNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<{ success: true }, ApiErrorShape, string>({
    mutationFn: (poolId) =>
      consoleRequest<{ success: true }>(`/network/pools/${encodeURIComponent(poolId)}/recover`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: async (_result, poolId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.network.pools }),
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.network.pools, poolId, "health-events"],
        }),
      ]);
    },
  });
}

/** Deletes a network pool and refreshes the pools list. */
export function useDeleteNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (poolId) =>
      consoleRequest<{ success: boolean }>(`/network/pools/${encodeURIComponent(poolId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}



/** Triggers a health check for a network pool. */
export function useHealthCheckNetworkPool() {
  const queryClient = useQueryClient();
  return useMutation<HealthCheckResult, ApiErrorShape, string>({
    mutationFn: (poolId) =>
      consoleRequest<HealthCheckResult>(
        `/network/pools/${encodeURIComponent(poolId)}/health-check`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}

/** Clears provider cooldowns for a network pool (optionally a single provider). */
export function useClearNetworkPoolCooldown() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { poolId: string; providerId?: string }
  >({
    mutationFn: ({ poolId, providerId }) =>
      consoleRequest<{ success: boolean }>(
        `/network/pools/${encodeURIComponent(poolId)}/cooldowns/clear`,
        {
          method: "POST",
          body: JSON.stringify(providerId ? { providerId } : {}),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}

/** Loads the tenant's pool-group selection strategy (least_loaded / round_robin). */
export function usePoolStrategy() {
  return useQuery<PoolStrategySetting, ApiErrorShape>({
    queryKey: queryKeys.network.poolStrategy,
    queryFn: (context) =>
      consoleRequest<unknown>("/network/pools/strategy", {
        signal: querySignal(context),
      }).then(assertPoolStrategy),
    staleTime: QUERY_OPTIONS.staleTime,
    gcTime: QUERY_OPTIONS.gcTime,
  });
}

/** Updates the pool-group selection strategy and refreshes it. */
export function useUpdatePoolStrategy() {
  const queryClient = useQueryClient();
  return useMutation<PoolStrategySetting, ApiErrorShape, Partial<PoolStrategySetting>>({
    mutationFn: (request) =>
      consoleRequest<PoolStrategySetting>("/network/pools/strategy", {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.poolStrategy });
    },
  });
}

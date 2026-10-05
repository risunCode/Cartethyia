import { consoleRequest } from "../data/api";
import { getErrorMessage } from "../shared/helpers";
import { toast } from "../shared/toast";
import type { ApiErrorShape } from "../data/api";
import type {
  CreateNetworkPoolRequest,
  HealthCheckResult,
  NetworkPoolResponse,
  PoolBatchProbeResult,
  PoolHealthEvent,
  PoolSpeedTestResult,
  PoolStrategySetting,
  RelayDeployRequest,
  RelayDeployResult,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { assertNetworkPools, assertPoolStrategy, querySignal } from "./common";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Loads the list of network pools for the tenant. */
export function useNetworkPools() {
  return useQuery<NetworkPoolResponse[], ApiErrorShape>({
    queryKey: queryKeys.network.pools,
    queryFn: (context) =>
      consoleRequest<unknown>("/network/pools", { signal: querySignal(context) }).then(
        assertNetworkPools,
      ),
    staleTime: DASHBOARD_QUERY_OPTIONS.staleTime,
    gcTime: DASHBOARD_QUERY_OPTIONS.gcTime,
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
      toast.success("Proxy pool created");
    },
    onError: (error) => {
      toast.error("Could not create the proxy pool.", getErrorMessage(error));
    },
  });
}

/**
 * Deploys a hosted relay (Cloudflare/Vercel/Deno) and registers its URL as a
 * network pool. The provider API token is sent once and never persisted.
 */
export function useDeployRelay() {
  const queryClient = useQueryClient();
  return useMutation<RelayDeployResult, ApiErrorShape, RelayDeployRequest>({
    mutationFn: (request) =>
      consoleRequest<RelayDeployResult>("/network/pools/relay/deploy", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.network.pools });
    },
  });
}
export function useProbeAdHocNetworkPool() {  return useMutation<HealthCheckResult, ApiErrorShape, CreateNetworkPoolRequest>({
    mutationFn: (request) =>
      consoleRequest<HealthCheckResult>("/network/pools/test", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}
/**
 * Probes many unsaved pool definitions in one request.
 *
 * The dashboard tests a pasted list before saving it; one request per proxy
 * made a long paste take minutes. Dialing still happens per target, server-side
 * with bounded concurrency — only the round-trips are batched.
 */
export function useProbeNetworkPoolBatch() {
  return useMutation<
    PoolBatchProbeResult[],
    ApiErrorShape,
    CreateNetworkPoolRequest[]
  >({
    mutationFn: (targets) =>
      consoleRequest<PoolBatchProbeResult[]>("/network/pools/test-batch", {
        method: "POST",
        body: JSON.stringify({ targets }),
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
      toast.success("Proxy updated");
    },
    onError: (error) => {
      toast.error("Could not update the proxy pool.", getErrorMessage(error));
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
    ...DASHBOARD_QUERY_OPTIONS,
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
      toast.success("Proxy pool recovered");
    },
    onError: (error) => {
      toast.error("Could not recover the proxy pool.", getErrorMessage(error));
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
      toast.success("Proxy pool deleted");
    },
    onError: (error) => {
      toast.error("Could not delete the proxy pool.", getErrorMessage(error));
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
      toast.success("Health check complete");
    },
    onError: (error) => {
      toast.error("Health check failed.", getErrorMessage(error));
    },
  });
}

/** Measures download throughput through a network pool. */
export function useSpeedTestNetworkPool() {
  return useMutation<
    PoolSpeedTestResult,
    ApiErrorShape,
    { poolId: string; bytes: number }
  >({
    mutationFn: ({ poolId, bytes }) =>
      consoleRequest<PoolSpeedTestResult>(
        `/network/pools/${encodeURIComponent(poolId)}/speed-test`,
        { method: "POST", body: JSON.stringify({ bytes }) },
      ),
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
      toast.success("Provider cooldowns cleared");
    },
    onError: (error) => {
      toast.error("Could not clear provider cooldowns.", getErrorMessage(error));
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
    staleTime: DASHBOARD_QUERY_OPTIONS.staleTime,
    gcTime: DASHBOARD_QUERY_OPTIONS.gcTime,
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

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "../../../lib/api";

interface UsageResourceOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/** Centralizes authenticated usage reads while keeping each feature query typed. */
export function useUsageResource<T>(queryKey: readonly unknown[], path: string, options: UsageResourceOptions = {}): UseQueryResult<T> {
  return useQuery({
    queryKey,
    queryFn: () => apiGet<T>(path),
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
  });
}

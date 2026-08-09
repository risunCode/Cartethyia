import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { apiGet, apiPost } from "../lib/api";
import { qk } from "../lib/query-keys";

export interface RuntimeSettingsResponse {
  settings: {
    runtime: Record<string, unknown>;
  };
}

/** Reads the shared console settings bundle without duplicating query wiring. */
export function useRuntimeSettings<TResponse extends RuntimeSettingsResponse = RuntimeSettingsResponse>(): UseQueryResult<TResponse> {
  return useQuery({
    queryKey: qk.settings.all,
    queryFn: () => apiGet<TResponse>("/settings"),
  });
}

/** Patches runtime settings and invalidates every settings consumer. */
export function usePatchRuntimeSettings<TPatch extends Record<string, unknown> = Record<string, unknown>>(): UseMutationResult<{ ok: boolean }, unknown, TPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: TPatch) => apiPost<{ ok: boolean }>("/settings", patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
    },
  });
}

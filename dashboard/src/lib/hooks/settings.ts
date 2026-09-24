import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  RuntimeSettingsResponse,
  UpdateRuntimeSettingsRequest,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Loads per-tenant runtime preferences used by the proxy and dashboard. */
export function useRuntimeSettings() {
  return useQuery<RuntimeSettingsResponse, ApiErrorShape>({
    queryKey: queryKeys.settings.runtime,
    queryFn: (context) =>
      consoleRequest<RuntimeSettingsResponse>("/settings/runtime", {
        signal: querySignal(context),
      }),
    ...QUERY_OPTIONS,
  });
}

/** Updates per-tenant runtime preferences and invalidates the settings query. */
export function useUpdateRuntimeSettings() {
  const queryClient = useQueryClient();
  return useMutation<RuntimeSettingsResponse, ApiErrorShape, UpdateRuntimeSettingsRequest>({
    mutationFn: (request) =>
      consoleRequest<RuntimeSettingsResponse>("/settings/runtime", {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.runtime });
    },
  });
}


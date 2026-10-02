import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { ModelAbuseBan } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { assertModelBans, querySignal } from "./common";
import { DASHBOARD_MUTATION_OPTIONS, DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Platform-admin view of the model-abuse ban list.
 *
 * A ban is a security decision keyed on a client address, not a tenant
 * resource, so this surface is cross-tenant and gated by the server
 * (`platform:admin`); the dashboard only mirrors that gate to hide the control.
 * The list is small and short-lived (a ban lapses on its own after its TTL), so
 * it is read on demand when the dialog opens.
 */
export function useModelBans(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.modelBans.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/model-bans", { signal: querySignal(context) }).then(assertModelBans),
    enabled,
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/**
 * Lifts one ban by its client address.
 *
 * The list is refetched rather than patched: the server is the authority on
 * which bans are still active, and a ban may have lapsed between the read and
 * the unban, which the response's `ban_not_found` surfaces honestly.
 */
export function useUnbanModel() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, ModelAbuseBan["ip"]>({
    mutationFn: (identity) =>
      consoleRequest<{ success: boolean }>("/model-bans", {
        method: "DELETE",
        body: JSON.stringify({ identity }),
      }),
    ...DASHBOARD_MUTATION_OPTIONS,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelBans.all });
    },
  });
}

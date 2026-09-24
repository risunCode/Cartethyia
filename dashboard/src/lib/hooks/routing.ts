import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type { ModelAliasCreateInput, ModelAliasPatchInput, ModelAliasRow, ModelComboCreateInput, ModelComboPatchInput, ModelComboRow, ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, assertModelAliases, assertModelCombos, assertProviderRouting, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Loads model aliases for the current tenant. */
export function useModelAliases() {
  return useQuery({
    queryKey: queryKeys.modelRouting.aliases,
    queryFn: (context) =>
      consoleRequest<unknown>("/routing/aliases", { signal: querySignal(context) }).then(
        assertModelAliases,
      ),
    ...QUERY_OPTIONS,
  });
}

/** Loads model combos for the current tenant. */
export function useModelCombos() {
  return useQuery({
    queryKey: queryKeys.modelRouting.combos,
    queryFn: (context) =>
      consoleRequest<unknown>("/routing/combos", { signal: querySignal(context) }).then(
        assertModelCombos,
      ),
    ...QUERY_OPTIONS,
  });
}

/** Loads per-provider routing settings. */
export function useProviderRouting(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.routing(providerId),
    queryFn: (context) =>
      consoleRequest<unknown>(`/providers/${encodeURIComponent(providerId ?? "")}/routing`, {
        signal: querySignal(context),
      }).then(assertProviderRouting),
    enabled: providerId !== undefined && providerId.length > 0,
    ...QUERY_OPTIONS,
  });
}

/** Creates a model alias and invalidates the alias list. */
export function useCreateModelAlias() {
  const queryClient = useQueryClient();
  return useMutation<ModelAliasRow, ApiErrorShape, ModelAliasCreateInput>({
    mutationFn: (request) =>
      consoleRequest<ModelAliasRow>("/routing/aliases", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.aliases });
    },
  });
}

/** Updates a model alias's target model. */
export function useUpdateModelAlias() {
  const queryClient = useQueryClient();
  return useMutation<ModelAliasRow, ApiErrorShape, { id: string; request: ModelAliasPatchInput }>({
    mutationFn: ({ id, request }) =>
      consoleRequest<ModelAliasRow>(`/routing/aliases/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.aliases });
    },
  });
}

/** Deletes a model alias. */
export function useDeleteModelAlias() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (id) =>
      consoleRequest<{ success: boolean }>(`/routing/aliases/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.aliases });
    },
  });
}

/** Creates a model combo and invalidates the combo list. */
export function useCreateModelCombo() {
  const queryClient = useQueryClient();
  return useMutation<ModelComboRow, ApiErrorShape, ModelComboCreateInput>({
    mutationFn: (request) =>
      consoleRequest<ModelComboRow>("/routing/combos", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.combos });
    },
  });
}

/** Updates a model combo's members and/or strategy. */
export function useUpdateModelCombo() {
  const queryClient = useQueryClient();
  return useMutation<ModelComboRow, ApiErrorShape, { id: string; request: ModelComboPatchInput }>({
    mutationFn: ({ id, request }) =>
      consoleRequest<ModelComboRow>(`/routing/combos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.combos });
    },
  });
}

/** Deletes a model combo. */
export function useDeleteModelCombo() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (id) =>
      consoleRequest<{ success: boolean }>(`/routing/combos/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.combos });
    },
  });
}

/** Updates per-provider routing strategy. */
export function useUpdateProviderRouting() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderRoutingResponse,
    ApiErrorShape,
    { providerId: string; request: UpdateProviderRoutingRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProviderRoutingResponse>(
        `/providers/${encodeURIComponent(providerId)}/routing`,
        {
          method: "PATCH",
          body: JSON.stringify(request),
        },
      ),
    onSuccess: async (_res, vars) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.routing(vars.providerId),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
    },
  });
}


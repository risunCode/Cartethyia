import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { AccountInflightReading, ModelAliasCreateInput, ModelAliasPatchInput, ModelAliasRow, ModelComboCloneResult, ModelComboCreateInput, ModelComboPatchInput, ModelComboRow, ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { assertModelAliases, assertModelCombos, assertProviderRouting, querySignal } from "./common";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


/** Loads model aliases for the current tenant. */
export function useModelAliases() {
  return useQuery({
    queryKey: queryKeys.modelRouting.aliases,
    queryFn: (context) =>
      consoleRequest<unknown>("/routing/aliases", { signal: querySignal(context) }).then(
        assertModelAliases,
      ),
    ...DASHBOARD_QUERY_OPTIONS,
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
    ...DASHBOARD_QUERY_OPTIONS,
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
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/** Loads live per-account admission counts for one provider; absent means zero. */
export function useProviderAccountInflight(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.accountInflight(providerId),
    queryFn: async (context) => {
      const response = await consoleRequest<unknown>(
        `/providers/${encodeURIComponent(providerId ?? "")}/account-inflight`,
        { signal: querySignal(context) },
      );
      if (!Array.isArray(response)) throw { status: 500, code: "invalid_response", message: "Invalid account inflight response" } satisfies ApiErrorShape;
      const byAccount = new Map<string, number>();
      for (const row of response as readonly AccountInflightReading[]) {
        if (typeof row !== "object" || row === null) continue;
        const reading = row as { accountId?: unknown; inflight?: unknown };
        if (typeof reading.accountId !== "string" || typeof reading.inflight !== "number") continue;
        byAccount.set(reading.accountId, Math.max(0, Math.floor(reading.inflight)));
      }
      return byAccount;
    },
    enabled: providerId !== undefined && providerId.length > 0,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
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

/** Persists a new alias order. `ids` must list every alias exactly once. */
export function useReorderModelAliases() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string[]>({
    mutationFn: (ids) =>
      consoleRequest<{ success: boolean }>("/routing/aliases/reorder", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.aliases });
    },
  });
}

/** Persists a new combo order. `ids` must list every combo exactly once. */
export function useReorderModelCombos() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string[]>({
    mutationFn: (ids) =>
      consoleRequest<{ success: boolean }>("/routing/combos/reorder", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.combos });
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

/**
 * Clones a model combo server-side. The server names the copy (`-clone`, `-2`,
 * …) so two concurrent clones cannot collide, and reports any members it had to
 * drop because they no longer resolve.
 */
export function useCloneModelCombo() {
  const queryClient = useQueryClient();
  return useMutation<ModelComboCloneResult, ApiErrorShape, string>({
    mutationFn: (id) =>
      consoleRequest<ModelComboCloneResult>(`/routing/combos/${encodeURIComponent(id)}/clone`, {
        method: "POST",
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


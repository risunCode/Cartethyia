import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { ApplyConfigResult, ApplyInput, CliMappingInput, CliMappingSettings, DownloadResult, ToolRegistryEntry, ToolStatus } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "../lib/api/validators";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


export function useToolRegistry() {
  return useQuery({
    queryKey: queryKeys.cliTools.registry,
    queryFn: (context) =>
      consoleRequest<ToolRegistryEntry[]>("/cli-tools/registry", { signal: querySignal(context) }),
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

export function useToolStatuses() {
  return useQuery({
    queryKey: queryKeys.cliTools.statuses,
    queryFn: (context) =>
      consoleRequest<Record<string, ToolStatus>>("/cli-tools/all-statuses", {
        signal: querySignal(context),
      }),
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/** Loads the mapping settings for one (tool, key) pair. */
export function useToolMappings(toolId: string, keyId: string) {
  return useQuery({
    queryKey: queryKeys.cliTools.mappings(toolId, keyId),
    queryFn: (context) =>
      consoleRequest<CliMappingSettings>(
        `/cli-tools/${encodeURIComponent(toolId)}/mappings?keyId=${encodeURIComponent(keyId)}`,
        { signal: querySignal(context) },
      ),
    enabled: toolId.length > 0 && keyId.length > 0,
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/** Persists mapping settings for one (tool, key) pair. */
export function useSaveToolMappings() {
  const qc = useQueryClient();
  return useMutation<CliMappingSettings, ApiErrorShape, { toolId: string; keyId: string; input: CliMappingInput }>(
    {
      mutationFn: ({ toolId, keyId, input }) =>
        consoleRequest<CliMappingSettings>(`/cli-tools/${encodeURIComponent(toolId)}/mappings`, {
          method: "POST",
          body: JSON.stringify({ ...input, keyId }),
        }),
      onSuccess: async (_result, { toolId, keyId }) => {
        await qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(toolId, keyId) });
      },
    },
  );
}

/**
 * Clears every remote route and switches Remote Routing off for one
 * (tool, key). This is the fast deactivate: the gateway stops resolving the
 * key's CLI mappings on the next request.
 */
export function useResetToolMappings() {
  const qc = useQueryClient();
  return useMutation<CliMappingSettings, ApiErrorShape, { toolId: string; keyId: string }>({
    mutationFn: ({ toolId, keyId }) =>
      consoleRequest<CliMappingSettings>(`/cli-tools/${encodeURIComponent(toolId)}/mappings/reset`, {
        method: "POST",
        body: JSON.stringify({ keyId }),
      }),
    onSuccess: async (_result, { toolId, keyId }) => {
      await qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(toolId, keyId) });
    },
  });
}

export function useDownloadTool() {
  const qc = useQueryClient();
  return useMutation<DownloadResult, ApiErrorShape, { toolId: string; keyId: string; input: ApplyInput }>({
    mutationFn: ({ toolId, keyId, input }) =>
      consoleRequest<DownloadResult>(`/cli-tools/${encodeURIComponent(toolId)}/download`, {
        method: "POST",
        // The wire schema names this `models`; the shared interface calls it
        // `modelIds`. Sending only the interface name is rejected as
        // `invalid_request: must have required properties models`.
        body: JSON.stringify({ ...input, models: input.modelIds, keyId }),
      }),
    onSuccess: async (_result, { toolId, keyId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.statuses }),
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(toolId, keyId) }),
      ]);
    },
  });
}

/**
 * Applies config to a tool: writes the file on the gateway host, records the
 * remote route, or both. The response reports which paths actually ran.
 */
export function useApplyTool() {
  const qc = useQueryClient();
  return useMutation<
    ApplyConfigResult,
    ApiErrorShape,
    { toolId: string; keyId: string; input: ApplyInput & { mode?: "file" | "remote" | "both" } }
  >({
    mutationFn: ({ toolId, keyId, input }) =>
      consoleRequest<ApplyConfigResult>(`/cli-tools/${encodeURIComponent(toolId)}/apply`, {
        method: "POST",
        body: JSON.stringify({ ...input, models: input.modelIds, keyId }),
      }),
    onSuccess: async (_result, { toolId, keyId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.statuses }),
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(toolId, keyId) }),
      ]);
    },
  });
}

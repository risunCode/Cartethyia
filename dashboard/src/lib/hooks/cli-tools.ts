import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type { ApplyConfigResult, ApplyInput, CliMappingInput, CliMappingSettings, DownloadResult, ToolRegistryEntry, ToolStatus } from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


export function useToolRegistry() {
  return useQuery({
    queryKey: queryKeys.cliTools.registry,
    queryFn: (context) =>
      consoleRequest<ToolRegistryEntry[]>("/cli-tools/registry", { signal: querySignal(context) }),
    ...QUERY_OPTIONS,
  });
}

export function useToolStatuses() {
  return useQuery({
    queryKey: queryKeys.cliTools.statuses,
    queryFn: (context) =>
      consoleRequest<Record<string, ToolStatus>>("/cli-tools/all-statuses", {
        signal: querySignal(context),
      }),
    ...QUERY_OPTIONS,
  });
}

export function useToolMappings(toolId: string) {
  return useQuery({
    queryKey: queryKeys.cliTools.mappings(toolId),
    queryFn: (context) =>
      consoleRequest<CliMappingSettings>(`/cli-tools/${encodeURIComponent(toolId)}/mappings`, {
        signal: querySignal(context),
      }),
    enabled: toolId.length > 0,
    ...QUERY_OPTIONS,
  });
}

export function useSaveToolMappings() {
  const qc = useQueryClient();
  return useMutation<CliMappingSettings, ApiErrorShape, { toolId: string; input: CliMappingInput }>(
    {
      mutationFn: ({ toolId, input }) =>
        consoleRequest<CliMappingSettings>(`/cli-tools/${encodeURIComponent(toolId)}/mappings`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      onSuccess: async (_r, vars) => {
        await qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(vars.toolId) });
      },
    },
  );
}

export function useDownloadTool() {
  const qc = useQueryClient();
  return useMutation<DownloadResult, ApiErrorShape, { toolId: string; input: ApplyInput }>({
    mutationFn: ({ toolId, input }) =>
      consoleRequest<DownloadResult>(`/cli-tools/${encodeURIComponent(toolId)}/download`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async (_result, { toolId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.statuses }),
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(toolId) }),
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
    { toolId: string; input: ApplyInput & { mode?: "file" | "remote" | "both" } }
  >({
    mutationFn: ({ toolId, input }) =>
      consoleRequest<ApplyConfigResult>(`/cli-tools/${encodeURIComponent(toolId)}/apply`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async (_result, { toolId }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.statuses }),
        qc.invalidateQueries({ queryKey: queryKeys.cliTools.mappings(toolId) }),
      ]);
    },
  });
}


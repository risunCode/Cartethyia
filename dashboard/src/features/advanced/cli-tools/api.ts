/** API hooks for CLI tools — fetch registry, statuses, apply/reset/download. */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiDelete, ApiError } from "../../../lib/api";
import { toast } from "../../../lib/toast";
import { qk } from "../../../lib/query-keys";
import type { ApplyInput, ApplyResult, CliMappingInput, CliMappingSettings, DownloadResult, ToolRegistryEntry, ToolStatus } from "./types";

/** Fetch the tool registry (static metadata for all tools). */
export function useToolRegistry() {
  return useQuery({
    queryKey: qk.cliTools.registry,
    queryFn: () => apiGet<readonly ToolRegistryEntry[]>("/cli-tools/registry"),
    staleTime: Infinity,
  });
}

/** Fetch batch status for all tools. */
export function useToolStatuses() {
  return useQuery({
    queryKey: qk.cliTools.statuses,
    queryFn: () => apiGet<Readonly<Record<string, ToolStatus>>>("/cli-tools/all-statuses"),
    refetchInterval: 15000,
  });
}

/** Fetch persisted harness-specific mappings for one CLI tool. */
export function useToolMappings(toolId: string | undefined) {
  return useQuery({
    queryKey: qk.cliTools.mappings(toolId),
    queryFn: () => apiGet<CliMappingSettings>(`/cli-tools/${toolId}/mappings`),
    enabled: Boolean(toolId),
    staleTime: 30_000,
  });
}

/** Persist harness-specific mappings without writing the native CLI config. */
export function useSaveToolMappings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ toolId, input }: { toolId: string; input: CliMappingInput }) =>
      apiPost<CliMappingSettings>(`/cli-tools/${toolId}/mappings`, input),
    onSuccess: (data, vars) => {
      qc.setQueryData(qk.cliTools.mappings(vars.toolId), data);
      toast.success(`${vars.toolId}: mapping saved`);
    },
    onError: (err: ApiError, vars) => {
      toast.error(`${vars.toolId}: mapping save failed — ${err.message}`);
    },
  });
}

/** Fetch API keys list (for the key selector). */
export function useApiKeys() {
  return useQuery({
    queryKey: qk.cliTools.apiKeys,
    queryFn: () => apiGet<{ items: readonly { id: string; name: string; keyPrefix: string; active: boolean }[] }>("/keys"),
  });
}

/** Fetch the full credential for a specific API key. */
export async function fetchApiKeyCredential(id: string): Promise<string | null> {
  try {
    const result = await apiGet<{ key: string }>(`/keys/${id}/credential`);
    return result.key;
  } catch {
    return null;
  }
}

/** Apply config to a tool. */
export function useApplyTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ toolId, input }: { toolId: string; input: ApplyInput }) =>
      apiPost<ApplyResult>(`/cli-tools/${toolId}`, input),
    onSuccess: (_data, vars) => {
      toast.success(`${vars.toolId}: config applied`);
      qc.invalidateQueries({ queryKey: qk.cliTools.statuses });
    },
    onError: (err: ApiError, vars) => {
      toast.error(`${vars.toolId}: ${err.message}`);
    },
  });
}

/** Reset a tool's config. */
export function useResetTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toolId: string) => apiDelete<ApplyResult>(`/cli-tools/${toolId}`),
    onSuccess: (_data, toolId) => {
      toast.success(`${toolId}: config reset`);
      qc.invalidateQueries({ queryKey: qk.cliTools.statuses });
    },
    onError: (err: ApiError, toolId) => {
      toast.error(`${toolId}: ${err.message}`);
    },
  });
}

/** Download a tool's config as text. */
export function useDownloadTool() {
  return useMutation({
    mutationFn: ({ toolId, input }: { toolId: string; input: ApplyInput }) =>
      apiPost<DownloadResult>(`/cli-tools/${toolId}/download`, input),
    onSuccess: (data) => {
      const blob = new Blob([data.content], { type: data.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Config downloaded");
    },
    onError: (err: ApiError) => {
      toast.error(`Download failed: ${err.message}`);
    },
  });
}

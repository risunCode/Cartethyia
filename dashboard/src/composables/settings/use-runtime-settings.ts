import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/solid-query";
import { consoleGet, consolePatch, ConsoleContractError } from "../../lib/console-api";
import { qk } from "../../lib/query-keys";

export interface RuntimeSettings {
  environment: string;
  logLevel: string;
  listenAddr: string;
  flags: Record<string, boolean>;
  sidebarIconDataUrl: string | null;
}

export interface RuntimeSettingsResponse {
  settings: {
    runtime: RuntimeSettings;
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Keeps only the documented runtime settings resource fields. */
export function normalizeRuntimeSettings(value: unknown): RuntimeSettingsResponse {
  const root = recordValue(value);
  const settings = recordValue(root?.settings);
  const runtime = recordValue(settings?.runtime);
  if (!settings || !runtime) throw new ConsoleContractError("invalid_contract", "runtime settings are invalid", 502);
  const flags: Record<string, boolean> = {};
  const rawFlags = recordValue(runtime.flags);
  if (rawFlags) {
    for (const [key, flag] of Object.entries(rawFlags).slice(0, 64)) {
      if (typeof flag === "boolean") flags[key] = flag;
    }
  }
  const sidebarIconDataUrl = typeof runtime.sidebarIconDataUrl === "string" && runtime.sidebarIconDataUrl.length <= 512
    ? runtime.sidebarIconDataUrl
    : null;
  return {
    settings: {
      runtime: {
        environment: typeof runtime.environment === "string" ? runtime.environment.slice(0, 128) : "unknown",
        logLevel: typeof runtime.logLevel === "string" ? runtime.logLevel.slice(0, 32) : "info",
        listenAddr: typeof runtime.listenAddr === "string" ? runtime.listenAddr.slice(0, 128) : "",
        flags,
        sidebarIconDataUrl,
      },
    },
  };
}

/** Reads the shared console settings bundle without duplicating query wiring. */
export function useRuntimeSettings<TResponse extends RuntimeSettingsResponse = RuntimeSettingsResponse>(): UseQueryResult<TResponse> {
  return useQuery(() => ({
    queryKey: qk.settings.all,
    queryFn: async () => normalizeRuntimeSettings(await consoleGet<unknown>("/settings")) as TResponse,
  }));
}

/** Patches runtime settings and invalidates every settings consumer. */
export function usePatchRuntimeSettings<TPatch extends Record<string, unknown> = Record<string, unknown>>(): UseMutationResult<{ ok: boolean }, unknown, TPatch> {
  const queryClient = useQueryClient();
  return useMutation(() => ({
    mutationFn: (patch: TPatch) => consolePatch<{ ok: boolean }>("/settings", patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
    },
  }));
}

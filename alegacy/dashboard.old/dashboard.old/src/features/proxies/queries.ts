import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { daemonFailure } from "../../lib/daemon-api";
import { qk } from "../../lib/query-keys";
import {
  createProxy,
  deleteProxy,
  getProxySettings,
  importProxies,
  listProxies,
  listProxyCountries,
  listProxyScrapeSources,
  patchProxySettings,
  scrapeProxies,
  searchProxies,
  testProxy,
  updateProxy,
} from "./api";
import type { ProxyInput, ProxyRecord, ProxySettings, ProxyTestResult } from "./contracts";

export type ProxyMutationStatus = "idle" | "pending" | "success" | "error" | "stale" | "unavailable";
export type ProxyMutationState = {
  status: ProxyMutationStatus;
  message: string | null;
};

/** Converts a mutation result into an explicit operator state; failures and stale responses never look successful. */
export function proxyMutationState(
  status: "idle" | "pending" | "success" | "error",
  error?: unknown,
  stale = false,
): ProxyMutationState {
  if (status === "error") {
    const failure = daemonFailure(error);
    return { status: failure.degraded || failure.code === "unavailable" ? "unavailable" : "error", message: failure.message };
  }
  if (status === "success" && stale) return { status: "stale", message: "daemon state refresh pending" };
  return { status, message: null };
}

/** Reads the bounded proxy list from the V2 daemon route. */
export function useProxies(limit = 100) {
  return useQuery({ queryKey: qk.proxies.list(limit), queryFn: () => listProxies(limit) });
}

/** Reads the outbound proxy policy from the V2 daemon route. */
export function useProxySettings() {
  return useQuery({ queryKey: qk.proxies.settings, queryFn: getProxySettings });
}

/** Reads daemon-advertised scrape sources without contacting external sources. */
export function useProxyScrapeSources() {
  return useQuery({ queryKey: qk.proxies.catalog, queryFn: listProxyScrapeSources });
}

/** Reads daemon-advertised countries for bounded proxy search/scrape filters. */
export function useProxyCountries() {
  return useQuery({ queryKey: qk.proxies.countries, queryFn: listProxyCountries });
}

/** Performs a daemon-backed search only when explicitly submitted. */
export function useProxySearch() {
  return useMutation({ mutationFn: searchProxies });
}

/** Provides proxy mutations with exact resource invalidation after a confirmed write. */
export function useProxyMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.proxies.all });
  const create = useMutation({ mutationFn: createProxy, onSuccess: invalidate });
  const update = useMutation({ mutationFn: ({ id, input }: { id: string; input: ProxyInput }) => updateProxy(id, input), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: ({ id, confirmed }: { id: string; confirmed: boolean }) => deleteProxy(id, { confirmed }), onSuccess: invalidate });
  const test = useMutation<ProxyTestResult, Error, string>({ mutationFn: testProxy });
  const importBatch = useMutation({ mutationFn: ({ inputs, confirmed }: { inputs: readonly ProxyInput[]; confirmed: boolean }) => importProxies(inputs, { confirmed }), onSuccess: invalidate });
  const scrape = useMutation({ mutationFn: scrapeProxies, onSuccess: invalidate });
  const patchSettings = useMutation({ mutationFn: (input: Partial<ProxySettings>) => patchProxySettings(input), onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.proxies.settings }) });
  return { create, update, remove, test, importBatch, scrape, patchSettings };
}

/** Returns one public record's state without retaining password or response metadata. */
export function proxyDisplayRecord(record: ProxyRecord): Pick<ProxyRecord, "id" | "label" | "protocol" | "host" | "port" | "country" | "enabled"> {
  return {
    id: record.id,
    label: record.label,
    protocol: record.protocol,
    host: record.host,
    port: record.port,
    country: record.country,
    enabled: record.enabled,
  };
}

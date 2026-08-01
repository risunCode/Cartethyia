/** Overview API — totals + per-provider status. */

import { Elysia } from "elysia";
import { networkInterfaces } from "node:os";
import { ensureSettings } from "../db/repos/settings";
import { queryUsageSummary, queryUsageCost, queryProviderToday, queryLastProviderError } from "../db/repos/usage";
import { providerRegistry } from "../../upstream/providers";
import { ADDED_PROVIDER_IDS, type AddedProviderId } from "../../routing/types";
import { prefixOf } from "../../routing/providerMeta";
import { getInFlightCount } from "../tracking/in-flight";

export interface ProviderOverview {
  id: AddedProviderId;
  prefix: string;
  status: "ok" | "warn";
  requestsToday: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  lastError: string | null;
}

export function buildProviderOverview(): ProviderOverview[] {
  const today = queryProviderToday();
  const byId = new Map(today.map((row) => [row.provider, row]));
  return ADDED_PROVIDER_IDS.map((id) => {
    const stats = byId.get(id);
    return {
      id,
      prefix: prefixOf(id) ?? id,
      status: stats && stats.errors > 0 ? "warn" : "ok",
      requestsToday: stats?.requests ?? 0,
      input: stats?.input ?? 0,
      cached: stats?.cached ?? 0,
      output: stats?.output ?? 0,
      errors: stats?.errors ?? 0,
      lastError: stats && stats.errors > 0 ? queryLastProviderError(id) : null,
    };
  });
}

function getLocalIps(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (!net.internal && net.family === "IPv4") ips.push(net.address);
    }
  }
  return ips;
}

export const ipRoute = new Elysia()
  .get("/console/api/ip", () => ({ ips: getLocalIps() }));

export const overviewRoutes = new Elysia({ prefix: "/console/api" })
  .get("/overview", async () => {
    const settings = await ensureSettings();
    const totals = queryUsageSummary("24h");
    return {
      totals: {
        ...totals,
        ...queryUsageCost("24h"),
      },
      inFlight: getInFlightCount(),
      providers: buildProviderOverview(),
      proxyAuthMode: settings.runtime.proxyAuthMode,
      registry: ADDED_PROVIDER_IDS.filter((id) => providerRegistry.get(id) !== undefined),
    };
  });

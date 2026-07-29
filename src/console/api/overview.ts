/** Overview API — totals + per-provider status + RTK runtime toggle. */

import { Elysia } from "elysia";
import { networkInterfaces } from "node:os";
import { consoleError } from "../errors";
import { ensureSettings, patchRuntimeSettings } from "../db/repos/settings";
import { invalidateRuntimeSettings } from "../runtime";
import { queryUsageSummary, queryProviderToday, queryLastProviderError } from "../db/repos/usage";
import { providerRegistry } from "../../upstream/providers";
import { ADDED_PROVIDER_IDS, type AddedProviderId } from "../../routing/types";
import { prefixOf } from "../../routing/providerMeta";
import { addAuditEvent } from "../db/repos/audit";
import { getRuntimeSettings } from "../runtime";
import { estimateCostUsd } from "../tracking/cost";
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
    const runtime = getRuntimeSettings();
    return {
      totals: {
        ...totals,
        estimatedCostUsd: estimateCostUsd(totals.inputTokens, totals.outputTokens, runtime.costPerMillionInputTokens, runtime.costPerMillionOutputTokens),
      },
      inFlight: getInFlightCount(),
      providers: buildProviderOverview(),
      rtk: settings.runtime.rtk,
      proxyAuthMode: settings.runtime.proxyAuthMode,
      registry: ADDED_PROVIDER_IDS.filter((id) => providerRegistry.get(id) !== undefined),
    };
  })
  .post("/overview/rtk", async ({ body, set }) => {
    const input = (body ?? {}) as { enabled?: boolean; minChars?: number; maxReductionPercent?: number };
    if (input.minChars !== undefined && (!Number.isFinite(input.minChars) || input.minChars < 0)) {
      set.status = 400;
      return consoleError("invalid_request", "minChars must be a non-negative number");
    }
    if (input.maxReductionPercent !== undefined && (!Number.isFinite(input.maxReductionPercent) || input.maxReductionPercent < 1 || input.maxReductionPercent > 90)) {
      set.status = 400;
      return consoleError("invalid_request", "maxReductionPercent must be between 1 and 90");
    }
    const next = patchRuntimeSettings({
      rtk: {
        enabled: input.enabled ?? false,
        minChars: input.minChars ?? 1500,
        maxReductionPercent: input.maxReductionPercent ?? 35,
      },
    });
    invalidateRuntimeSettings();
    addAuditEvent("settings.rtk", next.rtk as unknown as Record<string, unknown>);
    return { ok: true, rtk: next.rtk };
  });

import type { ModelMetadataResolver } from "../application/model-metadata";
import type { ProxyRequestDependencies } from "../application/request";
import type { AccountHealthManager, AuthDriverRegistry, CredentialConfigStore, CredentialSelector, TokenRefreshPool } from "../application/auth";
import { createConsoleApi } from "../console/api";
import { ConsoleDiagnostics } from "../console/diagnostics";
import { createConsoleLogStreamHub } from "../console/streams";
import { createConsoleRepositories } from "../console/wiring";
import { createConsoleServices } from "../console/services/composition";
import { probeProviderModel } from "../console/probe";
import { runtimeSettings } from "../console/runtime-settings";
import type { ProviderRegistry } from "../providers/registry";
import type { ConfigPersistence } from "../storage";
import type { RuntimePersistence } from "../storage/runtime/runtime";
import { activePerIpFlights } from "../traffic/per-ip";
import { getInFlightCount } from "../traffic/in-flight";
import type { NetworkSelector } from "../traffic/network";

export interface ConsoleAssemblyDependencies {
  readonly config: ConfigPersistence;
  readonly baseConfig: ConfigPersistence;
  readonly runtime: RuntimePersistence;
  readonly registry: ProviderRegistry;
  readonly authDrivers: AuthDriverRegistry;
  readonly modelMetadata: ModelMetadataResolver;
  readonly oauth: TokenRefreshPool;
  readonly proxy: ProxyRequestDependencies;
  readonly credentialStore: CredentialConfigStore;
  readonly accounts: CredentialSelector;
  readonly accountHealth: AccountHealthManager;
  readonly network: NetworkSelector;
}

/** Builds the console's repositories, services, diagnostics, stream hub, and mounted application once. */
export function createConsoleAssembly({ config, baseConfig, runtime, registry, authDrivers, modelMetadata, oauth, proxy, credentialStore, accounts, accountHealth, network }: ConsoleAssemblyDependencies) {
  const repositories = createConsoleRepositories(config, runtime, registry);
  const services = createConsoleServices({ repositories, registry, authDrivers, modelMetadata, oauthCoordinator: oauth });
  const recordRouteSwitch = (event: Parameters<typeof repositories.transitions.record>[2]) => repositories.transitions.record(event.scope, event.previousRouteId ?? event.replacementRouteId ?? "unknown", event);
  const prefixes = new Map(registry.list().map((adapter) => [adapter.metadata.id, adapter.metadata.id]));
  const diagnostics = new ConsoleDiagnostics({ services, repositories, registry, prefixes, runtimeCounters: { inFlight: () => getInFlightCount() } });
  const logStream = createConsoleLogStreamHub({
    latest: (limit, filters) => runtime.consoleLogs.list({ ...filters, limit }).items,
    after: (afterId, limit, filters) => runtime.consoleLogs.after(afterId, limit, filters),
    onPush: (listener) => runtime.consoleLogs.onPush(listener),
  });
  const api = createConsoleApi({ services, diagnostics, config: baseConfig, runtime, logStream, probe: probeProviderModel, probePorts: { registry, accounts: credentialStore, credentials: accounts, accountHealth, network }, liveTraffic: { byIp: () => activePerIpFlights.snapshot(), maxFlightsPerIp: () => runtimeSettings(config).maxFlightsPerIp }, proxy, resetConfig: baseConfig.resetAll, resetRuntime: runtime.resetAll });
  return {
    consoleApp: api.app,
    warpService: api.warpService,
    logStream,
    recordRouteSwitch,
    refreshQuota: async (accountId: string) => {
      const view = await services.quota.refresh(accountId);
      return view !== null && view.status !== "error";
    },
  };
}

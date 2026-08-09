import type { RoutingPreset } from "../../application/contracts";
import type { RouteHealth } from "../../application/contracts";

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

export type ProxyProtocol = "http" | "https" | "socks5";

/** Proxy row with its bounded health snapshot (repo join). */
export interface ProxyRowView {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly isRelay: boolean;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly passwordHint: string | null;
  readonly maxConcurrency: number;
  readonly priority: number;
  readonly weight: number;
  readonly active: boolean;
  readonly lastTestAt: string | null;
  readonly lastTestSuccessAt: string | null;
  readonly lastTestSuccessLatencyMs: number | null;
  readonly lastTestErrorAt: string | null;
  readonly lastTestError: string | null;
  readonly lastTestStatusCode: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly health: RouteHealth | null;
}

export interface ProxyCreateInput {
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly isRelay?: boolean;
  readonly host: string;
  readonly port: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly maxConcurrency?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly active?: boolean;
}

export interface ProxyUpdateInput {
  readonly name?: string;
  readonly protocol?: ProxyProtocol;
  readonly isRelay?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly maxConcurrency?: number;
  readonly priority?: number;
  readonly weight?: number;
  readonly active?: boolean;
}

export interface ProxyRepository {
  list(): Promise<readonly ProxyRowView[]>;
  get(id: string): Promise<ProxyRowView | null>;
  create(input: ProxyCreateInput): Promise<{ readonly id: string; readonly passwordHint: string | null }>;
  update(id: string, patch: ProxyUpdateInput): Promise<ProxyRowView | null>;
  remove(id: string): Promise<boolean>;
  /** Explicit credential endpoint contract. */
  credential(id: string): Promise<{ readonly password: string | null } | null>;
  health(proxyId: string): Promise<RouteHealth | null>;
  setHealth(proxyId: string, health: RouteHealth): Promise<void>;
  recordTest(proxyId: string, result: { readonly testedAt: string; readonly ok: boolean; readonly latencyMs: number | null; readonly statusCode: number | null; readonly error: string | null }): Promise<void>;
}

export interface ProxyTestInput {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username?: string | null;
  readonly password?: string | null;
  readonly isRelay?: boolean;
}

export interface ProxyTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly statusCode?: number;
  readonly error?: string;
}

export interface ProxySettingsView {
  readonly enabled: boolean;
  readonly excludedProviders: readonly string[];
  readonly smartDynamicRouting: boolean;
  readonly stickyProxyCount: number;
  readonly routingPreset: RoutingPreset;
  readonly targetConcurrent: number;
}

export interface ProxySettingsRepository {
  get(): Promise<ProxySettingsView>;
  patch(patch: Partial<ProxySettingsView>): Promise<ProxySettingsView>;
}

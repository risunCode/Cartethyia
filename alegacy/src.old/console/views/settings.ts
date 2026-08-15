// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ConsoleRuntimeSettings {
  readonly proxyAuthMode: "open" | "api_key";
  readonly privacyMode: "masked" | "full";
  readonly trackPayloads: "none" | "bounded";
  readonly trackAssets: "none" | "meta" | "store";
  readonly logRetentionDays: number;
  readonly assetRetentionDays: number;
  readonly maxFlightsPerIp: number;
  readonly trustProxy: boolean;
  readonly cacheMarkersEnabled: boolean;
  readonly sessionTtlHours: number;
  readonly sidebarIconDataUrl: string | null;
  readonly tokenSaverEnabled: boolean;
  readonly tokenSaverQuality: "lite" | "balanced" | "extreme";
  readonly headroomEnabled: boolean;
  readonly headroomUrl: string | null;
  readonly headroomTimeoutMs: number;
  readonly ponytailEnabled: boolean;
  readonly filterRulesEnabled: boolean;
}

/** Full settings snapshot — contains secrets; never returned by HTTP views. */
export interface SettingsSnapshot {
  readonly passwordHash: string | null;
  readonly passwordVersion: number;
  readonly jwtSecret: string;
  readonly runtime: ConsoleRuntimeSettings;
  readonly initializedAt: string;
  readonly updatedAt: string;
}

/** Safe settings view exposed to the dashboard. */
export interface SettingsView {
  readonly hasPassword: boolean;
  readonly passwordVersion: number;
  readonly runtime: ConsoleRuntimeSettings;
  readonly updatedAt: string;
}

export interface SettingsRepository {
  get(): Promise<SettingsSnapshot>;
  patchRuntime(patch: Partial<ConsoleRuntimeSettings>): Promise<ConsoleRuntimeSettings>;
  setPasswordHash(hash: string): Promise<void>;
  bumpPasswordVersion(): Promise<void>;
}

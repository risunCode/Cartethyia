/**
 * MultiWarp type contracts — Cloudflare Warp accounts, wireproxy instances,
 * and pool configuration for the proxy pool integration.
 */

/** A registered Cloudflare Warp account with WireGuard credentials. */
export interface WarpAccount {
  readonly id: string;
  readonly label: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly licenseKey: string;
  readonly privateKey: string;
  readonly addressV4: string;
  readonly addressV6: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly endpointPort: number;
  readonly dns: string;
  readonly mtu: number;
  readonly socksPort: number;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  /** Prefer IPv6 endpoint (engage.cloudflare.com resolves to IPv6). Default: true. */
  readonly preferIpv6: boolean;
  /** Custom endpoint override (e.g. 162.159.192.1:4500 for port hopping). */
  readonly customEndpoint: string | null;
  /** WireGuard persistent keepalive interval (seconds, 0 = off). */
  readonly persistentKeepalive: number;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

/**
 * Dashboard-facing view of a Warp account with secrets masked. List/detail
 * payloads never include raw secrets (AGENTS.md security rule); the full
 * credential is available only via an explicit credential endpoint.
 */
export interface WarpAccountView {
  readonly id: string;
  readonly label: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly licenseKey: string;
  readonly privateKey: string;
  readonly addressV4: string;
  readonly addressV6: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly endpointPort: number;
  readonly dns: string;
  readonly mtu: number;
  readonly socksPort: number;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly preferIpv6: boolean;
  readonly customEndpoint: string | null;
  readonly persistentKeepalive: number;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

/** Masks a secret string to its last 4 characters, prefixing with bullets. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/** Projects a WarpAccount into a dashboard-safe view with masked secrets. */
export function toWarpAccountView(account: WarpAccount): WarpAccountView {
  return {
    id: account.id,
    label: account.label,
    deviceId: account.deviceId,
    accessToken: maskSecret(account.accessToken),
    licenseKey: maskSecret(account.licenseKey),
    privateKey: maskSecret(account.privateKey),
    addressV4: account.addressV4,
    addressV6: account.addressV6,
    publicKey: account.publicKey,
    endpoint: account.endpoint,
    endpointPort: account.endpointPort,
    dns: account.dns,
    mtu: account.mtu,
    socksPort: account.socksPort,
    enabled: account.enabled,
    running: account.running,
    pid: account.pid,
    preferIpv6: account.preferIpv6,
    customEndpoint: account.customEndpoint,
    persistentKeepalive: account.persistentKeepalive,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/** Input for creating a new Warp account (via wgcf register). */
export interface WarpAccountInput {
  readonly label?: string;
}

/** Input for importing an existing Warp account from a profile .conf file. */
export interface WarpImportInput {
  readonly label?: string;
  /** Raw WireGuard .conf file content (INI format with [Interface] + [Peer]). */
  readonly profileContent: string;
  /** Optional Cloudflare account metadata (deviceId, accessToken, licenseKey). */
  readonly deviceId?: string;
  readonly accessToken?: string;
  readonly licenseKey?: string;
}

/** Runtime status of a warp instance (wireproxy process + health). */
export interface WarpInstanceStatus {
  readonly accountId: string;
  readonly label: string;
  readonly running: boolean;
  readonly pid: number | null;
  readonly socksPort: number;
  readonly socksUrl: string;
  readonly healthy: boolean | null;
  readonly egressIp: string | null;
  readonly message?: string;
}

/** Result of a register/generate/start/stop operation. */
export interface WarpResult {
  readonly success: boolean;
  readonly message: string;
  readonly accountId?: string;
}

/** Batch status response for all warp instances. */
export type WarpAllStatusesResult = Readonly<Record<string, WarpInstanceStatus>>;

/** Repository contract for warp account persistence. */
export interface WarpAccountRepository {
  list(): Promise<readonly WarpAccount[]>;
  get(id: string): Promise<WarpAccount | null>;
  create(input: WarpAccountCreateData): Promise<WarpAccount>;
  update(id: string, patch: Partial<WarpAccountUpdateData>): Promise<WarpAccount | null>;
  remove(id: string): Promise<boolean>;
  setRunning(id: string, running: boolean, pid: number | null): Promise<void>;
}

/** Data needed to create a warp account row. */
export interface WarpAccountCreateData {
  readonly id: string;
  readonly label: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly licenseKey: string;
  readonly privateKey: string;
  readonly addressV4: string;
  readonly addressV6: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly endpointPort: number;
  readonly dns: string;
  readonly mtu: number;
  readonly socksPort: number;
  readonly preferIpv6?: boolean;
  readonly customEndpoint?: string | null;
  readonly persistentKeepalive?: number;
}

/** Updatable fields for a warp account. */
export interface WarpAccountUpdateData {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly socksPort?: number;
  readonly preferIpv6?: boolean;
  readonly customEndpoint?: string | null;
  readonly persistentKeepalive?: number;
}

/** WireGuard profile .conf content for backup/export. */
export interface WarpProfileExport {
  readonly accountId: string;
  readonly label: string;
  readonly profileContent: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly licenseKey: string;
}

/** Backup payload containing one or more account profiles. */
export interface WarpBackupPayload {
  readonly version: 1;
  readonly exportedAt: string;
  readonly accounts: readonly WarpProfileExport[];
}

/** Input for importing from a backup payload. */
export interface WarpBackupImport {
  readonly label?: string;
  readonly payload: WarpBackupPayload;
}

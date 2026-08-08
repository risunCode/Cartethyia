/**
 * WarpPoolService — orchestrates wgcf registration, wireproxy process
 * management, and ProxyPool injection.
 *
 * The service is the application-layer boundary: API routes call it, it
 * dispatches to wgcf/wireproxy, persists accounts, and auto-injects running
 * instances into the ProxyPool via the proxies repository.
 */

import { randomUUID } from "node:crypto";
import type { WarpAccount, WarpAccountInput, WarpAccountView, WarpAllStatusesResult, WarpBackupPayload, WarpImportInput, WarpInstanceStatus, WarpProfileExport, WarpResult } from "./types";
import type { WarpAccountRepository } from "./types";
import { toWarpAccountView } from "./types";
import type { ConfigPersistence } from "../../storage/main/config";
import { registerWarpAccount, parseImportedProfile, type WgcfProfile } from "./wgcf";
import { readProcessMetrics, bandwidthDelta, clearProcessMetrics, type ProcessMetrics } from "./wireproxy-metrics";
import type { RuntimePersistence } from "../../storage/runtime/runtime";
import type { WarpMetricRow, WarpMetricsRepository, WarpMetricsSummary } from "../../storage/runtime/runtime";
import { startWireProxy, stopWireProxy, checkWireProxyHealth, findAvailablePort, getRunningAccountIds, stopAllWireProxies } from "./wireproxy";

/** Proxy pool injection — each running warp instance becomes a ProxyConfig row. */
interface ProxyPoolInjector {
  upsertWarpProxy(accountId: string, socksPort: number, label: string): Promise<void>;
  removeWarpProxy(accountId: string): Promise<void>;
}

/** Create a proxy pool injector from the config persistence. */
function createProxyPoolInjector(config: ConfigPersistence): ProxyPoolInjector {
  return {
    async upsertWarpProxy(accountId, socksPort, label) {
      const id = `warp-${accountId}`;
      const name = label && label.trim() ? label : `Warp-${socksPort}`;
      const row = config.proxies.get(id);
      if (row) {
        // Already exists — update name + port + activate.
        config.proxies.patch(id, { name, port: socksPort, active: true });
        return;
      }
      // Insert new proxy entry pointing at the wireproxy SOCKS5 port.
      config.proxies.create({
        id,
        name,
        protocol: "socks5",
        isRelay: false,
        host: "127.0.0.1",
        port: socksPort,
        username: null,
        password: null,
        maxConcurrency: 8,
        priority: 10,
        weight: 100,
        active: true,
      });
    },
    async removeWarpProxy(accountId) {
      const id = `warp-${accountId}`;
      config.proxies.delete(id);
    },
  };
}

export class WarpPoolService {
  private readonly repo: WarpAccountRepository;
  private readonly poolInjector: ProxyPoolInjector;
  private readonly metricsRepo: WarpMetricsRepository | null;
  private metricsTimer: Timer | null = null;
  /** Guard flag — prevents overlapping metrics polls if one exceeds the interval. */
  private isPolling = false;
  /** Consecutive health-check failures per account ID — triggers auto-stop after threshold. */
  private readonly healthFailures = new Map<string, number>();
  /** Consecutive failures before auto-stopping an unhealthy instance. */
  static readonly AUTO_STOP_THRESHOLD = 3;
  /** Cached health per account, populated by the metrics poll — lets getAllStatuses skip redundant live checks. */
  private readonly healthCache = new Map<string, { healthy: boolean | null; egressIp: string | null; message?: string; timestamp: number }>();
  /** Cache TTL — getAllStatuses does a live check only when the entry is older than this. */
  static readonly HEALTH_CACHE_TTL_MS = 30_000;

  constructor(config: ConfigPersistence, runtime?: RuntimePersistence) {
    this.repo = config.warpAccounts;
    this.poolInjector = createProxyPoolInjector(config);
    this.metricsRepo = runtime?.warpMetrics ?? null;
    // Reconcile stale persisted process state after restart. Warp instances
    // are deliberately opt-in: the dashboard/API must start them explicitly.
    this.reconcileInstances().catch(() => {});
  }

  /** Start telemetry only while at least one Warp instance is active. */
  private ensureMetricsCollection(): void {
    if (this.metricsRepo !== null && this.metricsTimer === null) {
      this.startMetricsCollection(15_000);
    }
  }

  /** Release the timer when no Warp instance remains active. */
  private stopMetricsCollection(): void {
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  /** Clear process state left by a previous server and remove stale proxies. */
  private async reconcileInstances(): Promise<void> {
    const accounts = await this.repo.list();
    for (const account of accounts) {
      if (!account.running && account.pid === null) continue;
      await this.repo.setRunning(account.id, false, null);
      await this.poolInjector.removeWarpProxy(account.id);
    }
  }

  /** Periodically collect process metrics for all running instances. */
  private startMetricsCollection(intervalMs: number): void {
    const poll = async (): Promise<void> => {
      if (this.isPolling) return; // skip overlapping poll
      this.isPolling = true;
      try {
        const accounts = await this.repo.list();
        const running = accounts.filter((a) => a.running && a.pid !== null);
        await Promise.all(running.map(async (account) => {
          const pid = account.pid!;
          const metrics = await readProcessMetrics(pid);
          const health = await checkWireProxyHealth(account.socksPort);
          this.healthCache.set(account.id, { healthy: health.healthy, egressIp: health.egressIp, message: health.message, timestamp: Date.now() });
          const delta = bandwidthDelta(pid, metrics.rxBytes, metrics.txBytes);
          this.metricsRepo!.record({
            accountId: account.id,
            label: account.label,
            pid,
            socksPort: account.socksPort,
            rssKb: metrics.rssKb,
            rxBytes: delta.rxDelta,
            txBytes: delta.txDelta,
            healthy: health.healthy,
            egressIp: health.egressIp,
            collectedAt: new Date().toISOString(),
          });

          // Auto-stop tracking: increment failures on unhealthy, reset on healthy.
          if (health.healthy) {
            this.healthFailures.delete(account.id);
          } else {
            const failures = (this.healthFailures.get(account.id) ?? 0) + 1;
            this.healthFailures.set(account.id, failures);
            if (failures >= WarpPoolService.AUTO_STOP_THRESHOLD) {
              // Instance is dead — stop it and remove from proxy pool.
              await this.stopInstance(account.id);
              this.healthFailures.delete(account.id);
            }
          }
        }));
        // Clean up failure counters for accounts that are no longer running.
        const runningIds = new Set(running.map((a) => a.id));
        for (const id of this.healthFailures.keys()) {
          if (!runningIds.has(id)) this.healthFailures.delete(id);
        }
        // Prune old metrics (keep last 1000 rows).
        this.metricsRepo!.prune(1000);
      } catch {
        // best effort — don't crash the poll loop
      } finally {
        this.isPolling = false;
      }
    };
    this.metricsTimer = setInterval(poll, intervalMs);
    this.metricsTimer.unref?.();
    // Initial poll immediately.
    poll().catch(() => {});
  }

  /** List all Warp accounts (secrets masked — safe for dashboard). */
  async listAccounts(): Promise<readonly WarpAccountView[]> {
    const accounts = await this.repo.list();
    return accounts.map(toWarpAccountView);
  }

  /** Get a single account by ID (secrets masked — safe for dashboard). */
  async getAccount(id: string): Promise<WarpAccountView | null> {
    const account = await this.repo.get(id);
    if (account === null) return null;
    return toWarpAccountView(account);
  }

  /** Get the raw credential for an account — explicit secret access. */
  async getCredential(id: string): Promise<WarpAccount | null> {
    return this.repo.get(id);
  }

  /** Register a new Warp account via wgcf. */
  async register(input: WarpAccountInput): Promise<WarpResult> {
    const id = randomUUID();
    try {
      // Allocate a SOCKS5 port.
      const accounts = await this.repo.list();
      const usedPorts = accounts.map((a) => a.socksPort);
      const socksPort = findAvailablePort(usedPorts);

      // Register via wgcf.
      const result = await registerWarpAccount(id);
      const account = await this.repo.create({
        id,
        label: input.label ?? `Warp-${accounts.length + 1}`,
        deviceId: result.account.deviceId,
        accessToken: result.account.accessToken,
        licenseKey: result.account.licenseKey,
        privateKey: result.profile.privateKey,
        addressV4: result.profile.addressV4,
        addressV6: result.profile.addressV6,
        publicKey: result.profile.publicKey,
        endpoint: result.profile.endpoint,
        endpointPort: result.profile.endpointPort,
        dns: result.profile.dns,
        mtu: result.profile.mtu,
        socksPort,
        preferIpv6: true,
        persistentKeepalive: 15,
      });
      return { success: true, message: `Registered ${account.label} (SOCKS5 port ${socksPort})`, accountId: id };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Registration failed" };
    }
  }

  /** Import a Warp account from an existing WireGuard profile. */
  async import(input: WarpImportInput): Promise<WarpResult> {
    const id = randomUUID();
    try {
      const result = parseImportedProfile(input.profileContent, {
        deviceId: input.deviceId,
        accessToken: input.accessToken,
        licenseKey: input.licenseKey,
      });
      const accounts = await this.repo.list();
      const usedPorts = accounts.map((a) => a.socksPort);
      const socksPort = findAvailablePort(usedPorts);
      const account = await this.repo.create({
        id,
        label: input.label ?? `Warp-${accounts.length + 1}`,
        deviceId: result.account.deviceId,
        accessToken: result.account.accessToken,
        licenseKey: result.account.licenseKey,
        privateKey: result.profile.privateKey,
        addressV4: result.profile.addressV4,
        addressV6: result.profile.addressV6,
        publicKey: result.profile.publicKey,
        endpoint: result.profile.endpoint,
        endpointPort: result.profile.endpointPort,
        dns: result.profile.dns,
        mtu: result.profile.mtu,
        socksPort,
        preferIpv6: true,
        persistentKeepalive: 15,
      });
      return { success: true, message: `Imported ${account.label} (SOCKS5 port ${socksPort})`, accountId: id };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Import failed" };
    }
  }

  /** Start a wireproxy instance for an account. */
  async startInstance(id: string): Promise<WarpResult> {
    const account = await this.repo.get(id);
    if (!account) return { success: false, message: "Account not found" };
    if (!account.enabled) return { success: false, message: "Account is disabled" };
    try {
      const { pid } = await startWireProxy(id, {
        privateKey: account.privateKey,
        addressV4: account.addressV4,
        addressV6: account.addressV6,
        publicKey: account.publicKey,
        endpoint: account.endpoint,
        endpointPort: account.endpointPort,
        dns: account.dns,
        mtu: account.mtu,
        socksPort: account.socksPort,
        preferIpv6: account.preferIpv6,
        customEndpoint: account.customEndpoint,
        persistentKeepalive: account.persistentKeepalive,
      });
      await this.repo.setRunning(id, true, pid);
      await this.poolInjector.upsertWarpProxy(id, account.socksPort, account.label);
      this.ensureMetricsCollection();
      return { success: true, message: `Started ${account.label} on port ${account.socksPort}`, accountId: id };
    } catch (error) {
      await this.repo.setRunning(id, false, null);
      return { success: false, message: error instanceof Error ? error.message : "Failed to start instance" };
    }
  }

  /** Stop a wireproxy instance. */
  async stopInstance(id: string): Promise<WarpResult> {
    const account = await this.repo.get(id);
    if (!account) return { success: false, message: "Account not found" };
    await stopWireProxy(id);
    // Clean up per-process metric state so the stopped PID leaves no stale
    // bandwidth-delta entry, and drop any accumulated health-check failures.
    if (account.pid) clearProcessMetrics(account.pid);
    this.healthFailures.delete(id);
    this.healthCache.delete(id);
    await this.repo.setRunning(id, false, null);
    await this.poolInjector.removeWarpProxy(id);
    const hasRunning = (await this.repo.list()).some((candidate) => candidate.running);
    if (!hasRunning) this.stopMetricsCollection();
    return { success: true, message: `Stopped ${account.label}`, accountId: id };
  }

  /** Start all enabled warp instances. */
  async startAll(): Promise<WarpResult> {
    const accounts = await this.repo.list();
    const enabled = accounts.filter((a) => a.enabled && !a.running);
    let started = 0;
    let failed = 0;
    for (const account of enabled) {
      const result = await this.startInstance(account.id);
      if (result.success) started++;
      else failed++;
    }
    return {
      success: failed === 0,
      message: `Started ${started}/${enabled.length} instances${failed > 0 ? ` (${failed} failed)` : ""}`,
    };
  }

  /** Stop all running warp instances. */
  async stopAll(): Promise<WarpResult> {
    const accounts = await this.repo.list();
    const running = accounts.filter((a) => a.running);
    let stopped = 0;
    for (const account of running) {
      await this.stopInstance(account.id);
      stopped++;
    }
    return { success: true, message: `Stopped ${stopped} instances` };
  }

  /** Get runtime status for all instances.
   *  Health for running instances is served from the metrics-poll cache;
   *  a live check runs only when the cache entry is missing or stale (>30s). */
  async getAllStatuses(): Promise<WarpAllStatusesResult> {
    const accounts = await this.repo.list();
    const now = Date.now();
    const entries = await Promise.all(
      accounts.map(async (account): Promise<[string, WarpInstanceStatus]> => {
        if (!account.running) {
          return [account.id, {
            accountId: account.id,
            label: account.label,
            running: false,
            pid: null,
            socksPort: account.socksPort,
            socksUrl: `socks5://127.0.0.1:${account.socksPort}`,
            healthy: null,
            egressIp: null,
            message: account.enabled ? "Stopped" : "Disabled",
          }];
        }
        const cached = this.healthCache.get(account.id);
        const fresh = cached !== undefined && (now - cached.timestamp) < WarpPoolService.HEALTH_CACHE_TTL_MS;
        const health = fresh
          ? { healthy: cached!.healthy, egressIp: cached!.egressIp, message: cached!.message }
          : await checkWireProxyHealth(account.socksPort);
        if (!fresh) {
          this.healthCache.set(account.id, { healthy: health.healthy, egressIp: health.egressIp, message: health.message, timestamp: now });
        }
        return [account.id, {
          accountId: account.id,
          label: account.label,
          running: true,
          pid: account.pid,
          socksPort: account.socksPort,
          socksUrl: `socks5://127.0.0.1:${account.socksPort}`,
          healthy: health.healthy,
          egressIp: health.egressIp,
          message: health.message,
        }];
      }),
    );
    return Object.fromEntries(entries);
  }

  /** Get aggregated metrics summary (memory + bandwidth card data).
   *  RSS/bandwidth come from the metrics DB; running/healthy counts come from
   *  live account state so stopped instances don't inflate the count. */
  async getMetricsSummary(): Promise<WarpMetricsSummary> {
    const accounts = await this.repo.list();
    const runningCount = accounts.filter((a) => a.running).length;
    if (!this.metricsRepo || runningCount === 0) {
      return { totalRssMb: 0, totalRxMb: 0, totalTxMb: 0, totalBandwidthMb: 0, runningCount, healthyCount: 0 };
    }
    const dbSummary = this.metricsRepo.summary();
    const healthyCount = Math.min(dbSummary.healthyCount, runningCount);
    return { ...dbSummary, runningCount, healthyCount };
  }

  /** Get paginated metrics history (infinite scroll table data). */
  getMetricsPage(cursor: number | null, limit: number = 10): { readonly items: readonly WarpMetricRow[]; readonly nextCursor: number | null } {
    if (!this.metricsRepo) return { items: [], nextCursor: null };
    return this.metricsRepo.page(cursor, limit);
  }

  /** Remove a warp account (stops instance first, removes proxy pool entry). */
  async removeAccount(id: string): Promise<WarpResult> {
    const account = await this.repo.get(id);
    if (!account) return { success: false, message: "Account not found" };
    if (account.running) await this.stopInstance(id);
    await this.repo.remove(id);
    return { success: true, message: `Removed ${account.label}`, accountId: id };
  }

  /** Update account label, enabled state, or network tuning. */
  async updateAccount(id: string, patch: { label?: string; enabled?: boolean; preferIpv6?: boolean; customEndpoint?: string | null; persistentKeepalive?: number }): Promise<WarpResult> {
    const account = await this.repo.update(id, patch);
    if (!account) return { success: false, message: "Account not found" };
    return { success: true, message: `Updated ${account.label}`, accountId: id };
  }

  /** Build a WireGuard .conf profile string from stored credentials. */
  private buildProfileContent(account: WarpAccount): string {
    const endpointHost = account.customEndpoint?.trim()
      ? account.customEndpoint.trim().split(":")[0]
      : account.preferIpv6
        ? "[2606:4700:d0::1]"
        : account.endpoint;
    const endpointPort = account.customEndpoint?.trim()
      ? (account.customEndpoint.trim().split(":")[1] ?? account.endpointPort)
      : account.endpointPort;
    const lines = [
      "[Interface]",
      `PrivateKey = ${account.privateKey}`,
      `Address = ${account.addressV4}/32,${account.addressV6}/128`,
      `DNS = ${account.dns}`,
      `MTU = ${account.mtu}`,
      "",
      "[Peer]",
      `PublicKey = ${account.publicKey}`,
      `Endpoint = ${endpointHost}:${endpointPort}`,
      "AllowedIPs = 0.0.0.0/0,::/0",
      account.persistentKeepalive > 0 ? `PersistentKeepalive = ${account.persistentKeepalive}` : "",
    ].filter((line) => line !== "");
    return lines.join("\n");
  }

  /** Export a single account's WireGuard profile (for backup). */
  async exportProfile(id: string): Promise<WarpProfileExport | null> {
    const account = await this.repo.get(id);
    if (!account) return null;
    return {
      accountId: account.id,
      label: account.label,
      profileContent: this.buildProfileContent(account),
      deviceId: account.deviceId,
      accessToken: account.accessToken,
      licenseKey: account.licenseKey,
    };
  }

  /** Export all accounts as a backup payload (JSON). */
  async exportAll(): Promise<WarpBackupPayload> {
    const accounts = await this.repo.list();
    const entries: WarpProfileExport[] = accounts.map((account) => ({
      accountId: account.id,
      label: account.label,
      profileContent: this.buildProfileContent(account),
      deviceId: account.deviceId,
      accessToken: account.accessToken,
      licenseKey: account.licenseKey,
    }));
    return { version: 1, exportedAt: new Date().toISOString(), accounts: entries };
  }

  /** Import one or more accounts from a backup payload. */
  async importBackup(payload: WarpBackupPayload, labelOverride?: string): Promise<WarpResult> {
    if (payload.version !== 1) return { success: false, message: "Unsupported backup version" };
    const accounts = await this.repo.list();
    const usedPorts = accounts.map((a) => a.socksPort);
    let imported = 0;
    let idx = accounts.length + 1;
    for (const entry of payload.accounts) {
      try {
        const result = parseImportedProfile(entry.profileContent, {
          deviceId: entry.deviceId,
          accessToken: entry.accessToken,
          licenseKey: entry.licenseKey,
        });
        const id = randomUUID();
        const socksPort = findAvailablePort(usedPorts);
        usedPorts.push(socksPort);
        const label = labelOverride
          ? `${labelOverride}-${idx}`
          : entry.label || `Warp-${idx}`;
        await this.repo.create({
          id,
          label,
          deviceId: result.account.deviceId,
          accessToken: result.account.accessToken,
          licenseKey: result.account.licenseKey,
          privateKey: result.profile.privateKey,
          addressV4: result.profile.addressV4,
          addressV6: result.profile.addressV6,
          publicKey: result.profile.publicKey,
          endpoint: result.profile.endpoint,
          endpointPort: result.profile.endpointPort,
          dns: result.profile.dns,
          mtu: result.profile.mtu,
          socksPort,
          preferIpv6: true,
          persistentKeepalive: 15,
        });
        imported++;
        idx++;
      } catch {
        // skip malformed entries
      }
    }
    if (imported === 0) return { success: false, message: "No valid accounts found in backup" };
    return { success: true, message: `Imported ${imported} account(s) from backup`, accountId: undefined };
  }

  /** Graceful shutdown — stop metrics timer + stop all wireproxy instances. */
  async shutdown(): Promise<void> {
    this.stopMetricsCollection();
    // Clear process metrics state for all tracked pids.
    const accounts = await this.repo.list();
    for (const account of accounts) {
      if (account.pid) clearProcessMetrics(account.pid);
    }
    await stopAllWireProxies();
  }
}

// Re-export for external consumers.
export { getRunningAccountIds };
export type { WgcfProfile };

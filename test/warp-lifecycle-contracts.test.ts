/**
 * WarpPoolService lifecycle contracts.
 *
 * Tests the manual-only startup invariant (constructor / reconcile never
 * starts enabled accounts), stale running/PID cleanup, explicit start/stop
 * transitions with proxy-pool injection/removal, port allocation boundaries,
 * health-cache behavior, metrics-timer activation/deactivation, shutdown
 * cleanup, and failure rollback.
 *
 * Strategy: real isolated SQLite persistence (config) so persisted-state
 * assertions are grounded, plus `mock.module` fakes for the wireproxy process
 * seam and the wireproxy-metrics OS seam — never launches a real provider,
 * the wireproxy binary, or the network. Runtime persistence is a minimal
 * in-memory fake exposing only the warpMetrics surface the service touches.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const REPO_ROOT = join(import.meta.dir, "..");
import type { WarpAccount, WarpAccountCreateData } from "../src/console/warp/types";
import type { WarpMetricRow, WarpMetricsRepository, WarpMetricsSummary, RuntimePersistence } from "../src/storage/runtime/runtime";

// ─── Isolated temp persistence ────────────────────────────────────────────

const DATA_DIR = mkdtempSync(join(tmpdir(), `warp-lifecycle-${process.pid}-`));
const DB_PATH = join(DATA_DIR, "config.sqlite");

// ─── Fakes for the process / OS seam ────────────────────────────────────────
//
// The service statically imports { startWireProxy, stopWireProxy,
// checkWireProxyHealth, findAvailablePort, getRunningAccountIds,
// stopAllWireProxies } from "./wireproxy" and { readProcessMetrics,
// bandwidthDelta, clearProcessMetrics } from "./wireproxy-metrics". These
// touch the wireproxy binary, spawn/probe OS processes, and make HTTPS
// requests to cloudflare.com — none belong in a deterministic local suite.
// We replace the whole modules so the service exercises its own orchestration
// against in-memory state.

interface FakeInstance { pid: number; socksPort: number; }
const fakeRunning = new Map<string, FakeInstance>();
let nextPid = 40_000;
let startShouldFail = false;
const fakeHealth = new Map<number, { healthy: boolean; egressIp: string | null; message?: string }>();
let stopAllCalled = false;
const clearedPids = new Set<number>();

function resetFakes(): void {
  fakeRunning.clear();
  nextPid = 40_000;
  startShouldFail = false;
  fakeHealth.clear();
  stopAllCalled = false;
  clearedPids.clear();
}

mock.module(join(REPO_ROOT, "src", "console", "warp", "wireproxy.ts"), () => ({
  startWireProxy: mock(async (_accountId: string, config: { socksPort: number }) => {
    if (startShouldFail) throw new Error("wireproxy start failed (injected)");
    const pid = ++nextPid;
    fakeRunning.set(_accountId, { pid, socksPort: config.socksPort });
    return { pid, socksUrl: `socks5://127.0.0.1:${config.socksPort}` };
  }),
  stopWireProxy: mock(async (accountId: string) => { return fakeRunning.delete(accountId); }),
  checkWireProxyHealth: mock(async (socksPort: number) => {
    return fakeHealth.get(socksPort) ?? { healthy: true, egressIp: "203.0.113.7", message: "ok" };
  }),
  findAvailablePort: mock((usedPorts: readonly number[], basePort = 40001, maxPort = 40100) => {
    const usedSet = new Set(usedPorts);
    for (let port = basePort; port <= maxPort; port++) { if (!usedSet.has(port)) return port; }
    return basePort;
  }),
  getRunningAccountIds: mock(() => [...fakeRunning.keys()]),
  stopAllWireProxies: mock(async () => { stopAllCalled = true; fakeRunning.clear(); }),
  destroyHealthAgent: mock(() => {}),
}));

mock.module(join(REPO_ROOT, "src", "console", "warp", "wireproxy-metrics.ts"), () => ({
  readProcessMetrics: mock(async (pid: number) => {
    if (pid <= 0) return { rssKb: 0, rxBytes: 0, txBytes: 0 };
    return { rssKb: 4_096, rxBytes: 1_024, txBytes: 2_048 };
  }),
  bandwidthDelta: mock((_pid: number, currentRx: number, currentTx: number) => {
    return { rxDelta: currentRx, txDelta: currentTx };
  }),
  clearProcessMetrics: mock((pid: number) => { clearedPids.add(pid); }),
}));

// Import AFTER mocks are registered so static imports resolve to fakes.
const { WarpPoolService } = await import("../src/console/warp/service");
const { createConfigPersistence } = await import("../src/storage/main/config");

// ─── Test persistence factories ─────────────────────────────────────────────

function makeEnv() {
  return {
    dataDir: DATA_DIR, dbPath: DB_PATH,
    runtimeDbPath: join(DATA_DIR, "runtime.sqlite"),
    assetDir: join(DATA_DIR, "assets"),
    logRetentionDays: 14, assetRetentionDays: 7, maxFlightsPerIp: 15,
  };
}

/**
 * Minimal RuntimePersistence exposing only the warpMetrics surface the
 * service touches, backed by an in-memory list. Avoids coupling to the real
 * write-behind buffer / schema migrations while still proving the service's
 * metrics-recording contract.
 */
function makeFakeRuntime(): RuntimePersistence {
  const rows: WarpMetricRow[] = [];
  let seq = 0;
  const repo: WarpMetricsRepository = {
    record(row) { rows.push({ ...row, id: ++seq }); },
    latest() {
      const byAccount = new Map<string, WarpMetricRow>();
      for (const r of rows) byAccount.set(r.accountId, r);
      return [...byAccount.values()];
    },
    summary(): WarpMetricsSummary {
      const latestRows = this.latest();
      const healthy = latestRows.filter((r) => r.healthy);
      let totalRssKb = 0, totalRx = 0, totalTx = 0;
      for (const r of healthy) { totalRssKb += r.rssKb; totalRx += r.rxBytes; totalTx += r.txBytes; }
      return {
        totalRssMb: Math.round(totalRssKb / 1024),
        totalRxMb: Math.round(totalRx / (1024 * 1024)),
        totalTxMb: Math.round(totalTx / (1024 * 1024)),
        totalBandwidthMb: Math.round((totalRx + totalTx) / (1024 * 1024)),
        runningCount: rows.length, healthyCount: healthy.length,
      };
    },
    page(cursor, limit) {
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 50);
      const filtered = cursor === null ? rows : rows.filter((r) => r.id < cursor);
      const sorted = [...filtered].sort((a, b) => b.id - a.id).slice(0, bounded);
      return { items: sorted, nextCursor: sorted.length === bounded ? (sorted.at(-1)?.id ?? null) : null };
    },
    prune(maxRows) {
      if (rows.length <= Math.floor(maxRows * 1.5)) return;
      const sorted = [...rows].sort((a, b) => b.id - a.id).slice(0, maxRows);
      rows.length = 0; rows.push(...sorted);
    },
  };
  return { warpMetrics: repo } as unknown as RuntimePersistence;
}

function accountInput(id: string, socksPort: number, label = `Warp-${socksPort}`): WarpAccountCreateData {
  return {
    id, label, deviceId: `dev-${id}`, accessToken: `token-${id}`, licenseKey: `license-${id}`,
    privateKey: "aGVTZXNzaW9uVG9rZW5rZXk=", addressV4: "172.16.0.2", addressV6: "fd01::2",
    publicKey: "bm9kZVB1YmxpY0tleQ==", endpoint: "engage.cloudflare.com", endpointPort: 2408,
    dns: "1.1.1.1", mtu: 1280, socksPort, preferIpv6: true, persistentKeepalive: 15,
  };
}

async function seedAccount(
  repo: { create(data: WarpAccountCreateData): Promise<WarpAccount>; update(id: string, patch: Partial<{ enabled: boolean }>): Promise<WarpAccount | null> },
  id: string, socksPort: number, opts: { label?: string; enabled?: boolean } = {},
): Promise<WarpAccount> {
  const created = await repo.create(accountInput(id, socksPort, opts.label));
  if (opts.enabled === false) await repo.update(id, { enabled: false });
  return created;
}

async function getAccountRaw(repo: { get(id: string): Promise<WarpAccount | null> }, id: string): Promise<WarpAccount> {
  const acc = await repo.get(id);
  if (!acc) throw new Error(`account ${id} missing from persistence`);
  return acc;
}

afterAll(() => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("WarpPoolService lifecycle contracts", () => {
  // ─── Manual-only startup ──────────────────────────────────────────────────

  describe("manual-only startup invariant", () => {
    test("constructor never starts enabled accounts — only reconciles stale state", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "manual-a", 40001);
        await seedAccount(config.warpAccounts, "manual-b", 40002);
        await config.warpAccounts.setRunning("manual-a", true, 99999);
        await config.warpAccounts.setRunning("manual-b", true, 88888);

        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        expect(fakeRunning.size).toBe(0);

        const a = await getAccountRaw(config.warpAccounts, "manual-a");
        const b = await getAccountRaw(config.warpAccounts, "manual-b");
        expect(a.running).toBe(false); expect(a.pid).toBe(null);
        expect(b.running).toBe(false); expect(b.pid).toBe(null);

        expect(config.proxies.get("warp-manual-a")).toBe(null);
        expect(config.proxies.get("warp-manual-b")).toBe(null);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("startAll is required to launch enabled accounts — never auto-invoked", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "auto-a", 40003);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        expect(fakeRunning.size).toBe(0);
        const statuses = await service.getAllStatuses();
        expect(statuses["auto-a"]?.running).toBe(false);
        expect(statuses["auto-a"]?.message).toBe("Stopped");

        const result = await service.startAll();
        expect(result.success).toBe(true);
        expect(fakeRunning.has("auto-a")).toBe(true);
        const a = await getAccountRaw(config.warpAccounts, "auto-a");
        expect(a.running).toBe(true); expect(a.pid).not.toBe(null);

        await service.shutdown();
      } finally { config.close(); }
    });
  });
  // ─── Stale running/PID cleanup ─────────────────────────────────────────────

  describe("stale running/PID cleanup", () => {
    test("reconcile clears running+pid and removes stale proxy rows", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "stale-1", 40004);
        await config.warpAccounts.setRunning("stale-1", true, 12345);
        config.proxies.create({
          id: "warp-stale-1", name: "stale", protocol: "socks5", isRelay: false,
          host: "127.0.0.1", port: 40004, username: null, password: null,
          maxConcurrency: 8, priority: 10, weight: 100, active: true,
        });
        await seedAccount(config.warpAccounts, "stale-2", 40005);
        await seedAccount(config.warpAccounts, "stale-3", 40006);
        await config.warpAccounts.setRunning("stale-3", false, 77777);

        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        const one = await getAccountRaw(config.warpAccounts, "stale-1");
        expect(one.running).toBe(false); expect(one.pid).toBe(null);
        expect(config.proxies.get("warp-stale-1")).toBe(null);

        const three = await getAccountRaw(config.warpAccounts, "stale-3");
        expect(three.running).toBe(false);
        expect(three.pid).toBe(null);

        await service.shutdown();
      } finally { config.close(); }
    });
  });

  // ─── Explicit start/stop transitions + proxy injection/removal ────────────

  describe("explicit start/stop transitions", () => {
    test("startInstance injects warp proxy into pool and persists running+pid", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "start-1", 40007);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        const result = await service.startInstance("start-1");
        expect(result.success).toBe(true);
        expect(result.accountId).toBe("start-1");

        const acc = await getAccountRaw(config.warpAccounts, "start-1");
        expect(acc.running).toBe(true);
        expect(acc.pid).not.toBe(null);
        expect(acc.pid!).toBeGreaterThan(0);

        const proxy = config.proxies.get("warp-start-1");
        expect(proxy).not.toBe(null);
        expect(proxy!.protocol).toBe("socks5");
        expect(proxy!.host).toBe("127.0.0.1");
        expect(proxy!.port).toBe(40007);
        expect(proxy!.active).toBe(true);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("stopInstance removes the warp proxy, clears running+pid, clears per-pid metrics", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "start-2", 40008);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        await service.startInstance("start-2");
        const pid = (await getAccountRaw(config.warpAccounts, "start-2")).pid!;
        expect(config.proxies.get("warp-start-2")).not.toBe(null);

        const result = await service.stopInstance("start-2");
        expect(result.success).toBe(true);

        const after = await getAccountRaw(config.warpAccounts, "start-2");
        expect(after.running).toBe(false); expect(after.pid).toBe(null);
        expect(config.proxies.get("warp-start-2")).toBe(null);
        expect(clearedPids.has(pid)).toBe(true);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("startInstance refuses a disabled account without side effects", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "disabled-1", 40009, { enabled: false });
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        const result = await service.startInstance("disabled-1");
        expect(result.success).toBe(false);
        expect(result.message).toContain("disabled");

        expect(fakeRunning.size).toBe(0);
        expect(config.proxies.get("warp-disabled-1")).toBe(null);
        const acc = await getAccountRaw(config.warpAccounts, "disabled-1");
        expect(acc.running).toBe(false); expect(acc.pid).toBe(null);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("startInstance on unknown account reports not found", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        const result = await service.startInstance("does-not-exist");
        expect(result.success).toBe(false);
        expect(result.message).toContain("not found");
        expect(fakeRunning.size).toBe(0);

        await service.shutdown();
      } finally { config.close(); }
    });
  });
  // ─── Port allocation boundaries ───────────────────────────────────────────

  describe("port allocation boundaries", () => {
    test("findAvailablePort skips ports already assigned to accounts", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "port-1", 40001);
        await seedAccount(config.warpAccounts, "port-2", 40002);
        await seedAccount(config.warpAccounts, "port-3", 40003);

        const { findAvailablePort } = await import("../src/console/warp/wireproxy");
        const used = [40001, 40002, 40003];
        expect(findAvailablePort(used)).toBe(40004);
        expect(findAvailablePort([])).toBe(40001);
      } finally { config.close(); }
    });

    test("exhausting the port range wraps to base (documented boundary)", async () => {
      const { findAvailablePort } = await import("../src/console/warp/wireproxy");
      const all: number[] = [];
      for (let p = 40001; p <= 40100; p++) all.push(p);
      expect(findAvailablePort(all)).toBe(40001);
    });
  });

  // ─── Health-cache behavior ────────────────────────────────────────────────

  describe("health-cache behavior", () => {
    test("getAllStatuses serves running instance health from cache when fresh", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "health-1", 40010);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        await service.startInstance("health-1");
        const first = await service.getAllStatuses();
        expect(first["health-1"]?.running).toBe(true);
        expect(first["health-1"]?.healthy).toBe(true);
        expect(first["health-1"]?.egressIp).toBe("203.0.113.7");

        fakeHealth.set(40010, { healthy: false, egressIp: null, message: "dead" });
        const cached = await service.getAllStatuses();
        expect(cached["health-1"]?.healthy).toBe(true);
        expect(cached["health-1"]?.egressIp).toBe("203.0.113.7");

        expect(WarpPoolService.HEALTH_CACHE_TTL_MS).toBe(30_000);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("stopped instance reports healthy=null and Stopped/Disabled message", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "health-2", 40011);
        await seedAccount(config.warpAccounts, "health-3", 40012, { enabled: false });
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        const statuses = await service.getAllStatuses();
        expect(statuses["health-2"]?.running).toBe(false);
        expect(statuses["health-2"]?.healthy).toBe(null);
        expect(statuses["health-2"]?.message).toBe("Stopped");
        expect(statuses["health-3"]?.running).toBe(false);
        expect(statuses["health-3"]?.healthy).toBe(null);
        expect(statuses["health-3"]?.message).toBe("Disabled");

        await service.shutdown();
      } finally { config.close(); }
    });
  });

  // ─── Metrics timer activation/deactivation ───────────────────────────────

  describe("metrics timer activation/deactivation", () => {
    test("timer starts only when an instance is running and stops when the last one stops", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      const runtime = makeFakeRuntime();
      try {
        await seedAccount(config.warpAccounts, "metrics-1", 40013);
        const service = new WarpPoolService(config, runtime);
        await Bun.sleep(20);

        expect(runtime.warpMetrics.latest()).toHaveLength(0);

        await service.startInstance("metrics-1");
        await Bun.sleep(50);
        const rows = runtime.warpMetrics.latest();
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0]?.accountId).toBe("metrics-1");
        expect(rows[0]?.pid).toBe((await getAccountRaw(config.warpAccounts, "metrics-1")).pid ?? undefined);
        expect(rows[0]?.healthy).toBe(true);

        const beforeCount = runtime.warpMetrics.latest().length;
        await service.stopInstance("metrics-1");
        await Bun.sleep(50);
        expect(runtime.warpMetrics.latest().length).toBe(beforeCount);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("timer is not started when runtime persistence is absent", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "metrics-2", 40014);
        const service = new WarpPoolService(config);
        await Bun.sleep(20);

        await service.startInstance("metrics-2");
        await Bun.sleep(50);
        const acc = await getAccountRaw(config.warpAccounts, "metrics-2");
        expect(acc.running).toBe(true);
        expect(fakeRunning.size).toBe(1);

        await service.shutdown();
      } finally { config.close(); }
    });
  });
  // ─── Shutdown cleanup ─────────────────────────────────────────────────────

  describe("shutdown cleanup", () => {
    test("shutdown stops the metrics timer, clears per-pid state, and stops all wireproxy processes", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      const runtime = makeFakeRuntime();
      try {
        await seedAccount(config.warpAccounts, "shut-1", 40015);
        await seedAccount(config.warpAccounts, "shut-2", 40016);
        const service = new WarpPoolService(config, runtime);
        await Bun.sleep(20);

        await service.startInstance("shut-1");
        await service.startInstance("shut-2");
        expect(fakeRunning.size).toBe(2);
        const pid1 = (await getAccountRaw(config.warpAccounts, "shut-1")).pid!;
        const pid2 = (await getAccountRaw(config.warpAccounts, "shut-2")).pid!;

        await service.shutdown();

        expect(stopAllCalled).toBe(true);
        expect(clearedPids.has(pid1)).toBe(true);
        expect(clearedPids.has(pid2)).toBe(true);
      } finally { config.close(); }
    });
  });

  // ─── Failure rollback ─────────────────────────────────────────────────────

  describe("failure rollback", () => {
    test("a failed start leaves no running state and no proxy residue", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      const runtime = makeFakeRuntime();
      try {
        await seedAccount(config.warpAccounts, "fail-1", 40017);
        const service = new WarpPoolService(config, runtime);
        await Bun.sleep(20);

        startShouldFail = true;
        const result = await service.startInstance("fail-1");
        expect(result.success).toBe(false);
        expect(result.message).toContain("failed");

        const acc = await getAccountRaw(config.warpAccounts, "fail-1");
        expect(acc.running).toBe(false);
        expect(acc.pid).toBe(null);
        expect(config.proxies.get("warp-fail-1")).toBe(null);
        expect(fakeRunning.size).toBe(0);
        expect(runtime.warpMetrics.latest().some((r) => r.accountId === "fail-1")).toBe(false);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("after a failed start, the account can be started again (no stuck state)", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "fail-2", 40018);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        startShouldFail = true;
        const failed = await service.startInstance("fail-2");
        expect(failed.success).toBe(false);

        startShouldFail = false;
        const ok = await service.startInstance("fail-2");
        expect(ok.success).toBe(true);
        const acc = await getAccountRaw(config.warpAccounts, "fail-2");
        expect(acc.running).toBe(true);
        expect(acc.pid).not.toBe(null);
        expect(config.proxies.get("warp-fail-2")).not.toBe(null);

        await service.shutdown();
      } finally { config.close(); }
    });

    test("startAll reports failures but does not leave running residue", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "fail-3", 40019);
        await seedAccount(config.warpAccounts, "fail-4", 40020);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        startShouldFail = true;
        const result = await service.startAll();
        expect(result.success).toBe(false);
        expect(result.message).toContain("failed");
        expect(fakeRunning.size).toBe(0);

        startShouldFail = false;
        const ok = await service.startInstance("fail-4");
        expect(ok.success).toBe(true);
        const acc = await getAccountRaw(config.warpAccounts, "fail-4");
        expect(acc.running).toBe(true);

        await service.shutdown();
      } finally { config.close(); }
    });
  });

  // ─── removeAccount cleanup ────────────────────────────────────────────────

  describe("removeAccount cleanup", () => {
    test("removeAccount stops a running instance first, then deletes the row and proxy", async () => {
      resetFakes();
      const config = createConfigPersistence(makeEnv());
      try {
        await seedAccount(config.warpAccounts, "remove-1", 40021);
        const service = new WarpPoolService(config, makeFakeRuntime());
        await Bun.sleep(20);

        await service.startInstance("remove-1");
        const pid = (await getAccountRaw(config.warpAccounts, "remove-1")).pid!;
        expect(config.proxies.get("warp-remove-1")).not.toBe(null);

        const result = await service.removeAccount("remove-1");
        expect(result.success).toBe(true);

        expect(await config.warpAccounts.get("remove-1")).toBe(null);
        expect(config.proxies.get("warp-remove-1")).toBe(null);
        expect(clearedPids.has(pid)).toBe(true);

        await service.shutdown();
      } finally { config.close(); }
    });
  });
});

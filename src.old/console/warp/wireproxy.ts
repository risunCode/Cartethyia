/**
 * wireproxy process manager — spawns/kills/health-checks wireproxy.exe instances.
 *
 * Each Warp account maps to one wireproxy process listening on a unique SOCKS5 port.
 * The process is spawned with a generated .conf file and runs in silent mode.
 * Health is checked by connecting to the SOCKS5 port and issuing a TRACE request
 * through the proxy to https://www.cloudflare.com/cdn-cgi/trace.
 *
 * IMPORTANT: wireproxy is a Go binary that forks itself internally — the parent
 * process (proc.pid from Bun.spawn) exits immediately, and the child process
 * (the actual wireproxy listening on the port) has a different PID. We resolve
 * the real PID from the listening port via netstat/ss after spawning.
 */

import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";

/** Path to the bundled wireproxy binary (.exe on Windows, bare on Linux). */
const WIREPROXY_BIN = join(process.cwd(), "bin", `wireproxy${process.platform === "win32" ? ".exe" : ""}`);

/** Directory for wireproxy config files. */
const WARP_CONF_DIR = join(process.cwd(), "data", "warp");

/** Track running processes by account ID — pid is the REAL listening PID. */
const runningProcesses = new Map<string, { pid: number; socksPort: number }>();

/**
 * Pool of SocksProxyAgent instances reused across health checks, keyed by SOCKS port.
 * Avoids re-doing TCP connect + SOCKS5 negotiation + TLS handshake on every poll.
 */
const healthAgentCache = new Map<number, SocksProxyAgent>();

/** Get (or lazily create) the pooled health-check agent for a SOCKS port. */
function getHealthAgent(socksPort: number): SocksProxyAgent {
  let agent = healthAgentCache.get(socksPort);
  if (!agent) {
    agent = new SocksProxyAgent(`socks5://127.0.0.1:${socksPort}`);
    healthAgentCache.set(socksPort, agent);
  }
  return agent;
}

/** Destroy the pooled health-check agent for a SOCKS port (call on instance stop). */
export function destroyHealthAgent(socksPort: number): void {
  const agent = healthAgentCache.get(socksPort);
  if (agent) {
    agent.destroy();
    healthAgentCache.delete(socksPort);
  }
}

/**
 * Resolve the PID of the process listening on a given TCP port.
 * Windows: `netstat -ano` filtered for the port + LISTENING.
 * Linux: `ss -tlnp` or `lsof -ti`.
 */
async function resolvePidFromPort(port: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["netstat", "-ano"], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(proc.stdout).text();
      await proc.exited.catch(() => {});
      for (const line of output.split("\n")) {
        if (line.includes(`:${port}`) && line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/);
          const pidStr = parts[parts.length - 1];
          const pid = Number(pidStr);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
    } else {
      try {
        const proc = Bun.spawn(["ss", "-tlnp", `sport = :${port}`], { stdout: "pipe", stderr: "ignore" });
        const output = await new Response(proc.stdout).text();
        await proc.exited.catch(() => {});
        const match = /pid=(\d+)/.exec(output);
        if (match) return Number(match[1]) || null;
      } catch {
        // ss not available
      }
      try {
        const proc = Bun.spawn(["lsof", "-ti", `:${port}`], { stdout: "pipe", stderr: "ignore" });
        const output = (await new Response(proc.stdout).text()).trim();
        await proc.exited.catch(() => {});
        const pid = Number(output);
        if (Number.isFinite(pid) && pid > 0) return pid;
      } catch {
        // lsof not available
      }
    }
  } catch {
    // best effort
  }
  return null;
}

/**
 * Kill a process by PID.
 * Windows: `taskkill /F /PID <pid>`
 * Linux/macOS: `process.kill(pid, "SIGTERM")`
 */
async function killPid(pid: number): Promise<void> {
  if (pid <= 0) return;
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["taskkill", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
      await proc.exited.catch(() => {});
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process may have already exited.
  }
}

/**
 * Start a wireproxy instance for a Warp account.
 * Spawns wireproxy, waits for it to come up, then resolves the real PID from
 * the listening port (because wireproxy forks internally, proc.pid is stale).
 */
export async function startWireProxy(
  accountId: string,
  config: {
    privateKey: string;
    addressV4: string;
    addressV6: string;
    publicKey: string;
    endpoint: string;
    endpointPort: number;
    dns: string;
    mtu: number;
    socksPort: number;
    preferIpv6?: boolean;
    customEndpoint?: string | null;
    persistentKeepalive?: number;
  },
): Promise<{ pid: number; socksUrl: string }> {
  // Kill existing process for this account if running.
  await stopWireProxy(accountId);

  // Ensure config directory exists.
  await mkdir(WARP_CONF_DIR, { recursive: true });

  // Resolve endpoint — custom override takes priority, then prefer-IPv6.
  const endpointHost = config.customEndpoint?.trim()
    ? config.customEndpoint.trim()
    : config.preferIpv6
      ? "[2606:4700:d0::1]"
      : config.endpoint;
  const endpointPort = config.customEndpoint?.trim()
    ? (config.customEndpoint.trim().split(":")[1] ?? config.endpointPort)
    : config.endpointPort;

  // Build WireGuard + SOCKS5 config.
  // PersistentKeepalive=15 combats datacenter QoS packet loss (adapted from MicroWARP).
  const keepalive = config.persistentKeepalive ?? 15;
  const confContent = [
    "[Interface]",
    `Address = ${config.addressV4}/32, ${config.addressV6}/128`,
    `PrivateKey = ${config.privateKey}`,
    `DNS = ${config.dns}`,
    `MTU = ${config.mtu}`,
    "",
    "[Peer]",
    `PublicKey = ${config.publicKey}`,
    `Endpoint = ${endpointHost}:${endpointPort}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    keepalive > 0 ? `PersistentKeepalive = ${keepalive}` : "",
    "",
    "[Socks5]",
    `BindAddress = 127.0.0.1:${config.socksPort}`,
    "",
  ].filter((line) => line !== "").join("\n");

  const confPath = join(WARP_CONF_DIR, `${accountId}.conf`);
  await writeFile(confPath, confContent, "utf8");

  // Spawn wireproxy in silent mode.
  // wireproxy is a Go binary that forks itself — the parent exits immediately
  // and the child (actual listener) gets a different PID. We resolve the real
  // PID from the listening port after a brief wait.
  const proc = Bun.spawn([WIREPROXY_BIN, "-c", confPath, "-s"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  void proc.exited.catch(() => {});

  // Wait briefly for the proxy to come up and start listening.
  await Bun.sleep(2000);

  // Resolve the real PID from the listening port.
  let realPid = await resolvePidFromPort(config.socksPort);
  if (!realPid) {
    // Retry once after a shorter wait.
    await Bun.sleep(1000);
    realPid = await resolvePidFromPort(config.socksPort);
  }

  // Fallback: use proc.pid if port resolution failed (better than 0).
  const pid = realPid ?? proc.pid;

  // Track the process with the real PID.
  runningProcesses.set(accountId, { pid, socksPort: config.socksPort });

  return { pid, socksUrl: `socks5://127.0.0.1:${config.socksPort}` };
}

/**
 * Stop a wireproxy instance by account ID.
 * Kills the process by its real PID (resolved from the port at start time).
 * Returns true if a process was tracked and killed.
 */
export async function stopWireProxy(accountId: string): Promise<boolean> {
  const entry = runningProcesses.get(accountId);
  if (!entry) return false;
  await killPid(entry.pid);
  runningProcesses.delete(accountId);
  // Release the pooled SocksProxyAgent so its socket is torn down.
  destroyHealthAgent(entry.socksPort);
  // Clean up config file.
  await rm(join(WARP_CONF_DIR, `${accountId}.conf`), { force: true }).catch(() => {});
  return true;
}

/**
 * Check if a wireproxy instance is healthy by making a test request through the SOCKS5 proxy.
 * Uses SocksProxyAgent (same as the production proxy pool fetcher) for compatibility.
 * Returns the egress IP if healthy, null otherwise.
 */
export async function checkWireProxyHealth(socksPort: number, timeoutMs = 8000): Promise<{ healthy: boolean; egressIp: string | null; message?: string }> {
  const traceUrl = "https://www.cloudflare.com/cdn-cgi/trace";
  const agent = getHealthAgent(socksPort);

  try {
    const target = new URL(traceUrl);
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;

    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = transport.request(
      {
        agent,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    const timer = setTimeout(() => { req.destroy(new Error("timeout")); }, timeoutMs);
    req.end();

    try {
      const { status, body } = await promise;

      if (status < 200 || status >= 300) {
        return { healthy: false, egressIp: null, message: `HTTP ${status}` };
      }

      const ipMatch = /ip=(.+)/.exec(body);
      const warpMatch = /warp=(.+)/.exec(body);
      const ip = ipMatch?.[1]?.trim() ?? null;
      const warp = warpMatch?.[1]?.trim() ?? "off";

      return {
        healthy: true,
        egressIp: ip,
        message: warp === "on" || warp === "plus" ? `Warp ${warp}, IP ${ip}` : `Connected, IP ${ip} (warp=${warp})`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      healthy: false,
      egressIp: null,
      message: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

/**
 * Find the next available SOCKS5 port starting from a base port.
 * Checks if the port is already in use by scanning existing accounts.
 */
export function findAvailablePort(usedPorts: readonly number[], basePort = 40001, maxPort = 40100): number {
  const usedSet = new Set(usedPorts);
  for (let port = basePort; port <= maxPort; port++) {
    if (!usedSet.has(port)) return port;
  }
  return basePort;
}

/**
 * Get all running account IDs.
 */
export function getRunningAccountIds(): readonly string[] {
  return [...runningProcesses.keys()];
}

/**
 * Stop all running wireproxy instances (graceful shutdown on server stop).
 */
export async function stopAllWireProxies(): Promise<void> {
  const ids = getRunningAccountIds();
  await Promise.all(ids.map((id) => stopWireProxy(id)));
}

#!/usr/bin/env bun
/**
 * restart.ts — rebuild and restart the compiled gateway gracefully.
 *
 * Why this exists: a hard kill (`taskkill /F`, `kill -9`) truncates every
 * in-flight response. On Linux the process handles SIGTERM/SIGINT and drains,
 * but Windows has no deliverable catchable signal — `process.kill(pid,
 * "SIGTERM")` of a console-less Bun process runs no JS handler (measured). So
 * this script stops the running instance through the drain endpoint when
 * `CARTETHYIA_DRAIN_TOKEN` is set (loopback + `x-drain-token`), and only falls
 * back to a hard kill when no token is configured.
 *
 * Env:
 *   CARTETHYIA_DRAIN_TOKEN  token for POST /admin/drain (required for graceful stop)
 *   PORT                    gateway port (default 12800)
 *   DRAIN_WAIT_MS           how long to wait for the drain to finish (default 30000)
 */
import { compiledBinaryPath } from "../build/binary";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const PORT = intEnv("PORT", 12800);
const DRAIN_WAIT_MS = intEnv("DRAIN_WAIT_MS", 30_000);

/** PIDs currently listening on `port` (best-effort, platform-specific). */
async function listeningPids(port: number): Promise<number[]> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawnSync(["netstat", "-ano", "-p", "TCP"]);
      const out = new TextDecoder().decode(proc.stdout);
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    const proc = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    return new TextDecoder()
      .decode(proc.stdout)
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listeningPids(port)).length === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return (await listeningPids(port)).length === 0;
}

async function stopGracefully(): Promise<boolean> {
  const token = process.env.CARTETHYIA_DRAIN_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    console.warn("[restart] CARTETHYIA_DRAIN_TOKEN unset — cannot drain gracefully");
    return false;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": token },
    });
    if (!response.ok) {
      console.warn(`[restart] drain request returned HTTP ${response.status}`);
      return false;
    }
    console.log("[restart] drain acknowledged; waiting for the process to exit");
    return await waitForPortFree(PORT, DRAIN_WAIT_MS);
  } catch (error) {
    console.warn(`[restart] drain request failed: ${(error as Error).message}`);
    return false;
  }
}

async function hardKill(): Promise<void> {
  const pids = await listeningPids(PORT);
  if (pids.length === 0) return;
  console.warn(`[restart] force-killing pid(s) ${pids.join(", ")} on :${PORT}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await waitForPortFree(PORT, 5_000);
}

async function main(): Promise<number> {
  const graceful = await stopGracefully();
  if (!graceful) await hardKill();

  console.log("[restart] building");
  const build = Bun.spawnSync(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) {
    console.error("[restart] build failed");
    return build.exitCode ?? 1;
  }

  const binary = compiledBinaryPath();
  console.log(`[restart] starting ${binary}`);
  const child = Bun.spawn([binary], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

if (import.meta.main) {
  process.exit(await main());
}

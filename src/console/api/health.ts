/**
 * Health metrics — this process's memory (RSS) against total system memory,
 * and CPU% sampled as a delta of `process.cpuUsage()` over wall-clock time
 * since the previous poll (first call after a cold start/GC has nothing to
 * diff against, so it reports 0). "Clear RAM usage" runs `Bun.gc(true)` \—
 * a JS-runtime GC call, not a shelled-out OS command, so it works
 * identically on Windows/Linux/macOS/anywhere Bun runs.
 */

import { Elysia } from "elysia";
import { cpus, freemem, totalmem } from "node:os";
import { addAuditEvent } from "../db/repos/audit";

let lastCpuUsage: NodeJS.CpuUsage | undefined;
let lastSampleAt: number | undefined;

function sampleCpuPercent(): number {
  const now = performance.now();
  const usage = process.cpuUsage();
  if (!lastCpuUsage || lastSampleAt === undefined) {
    lastCpuUsage = usage;
    lastSampleAt = now;
    return 0;
  }
  const elapsedMs = now - lastSampleAt;
  const deltaCpuUs = usage.user - lastCpuUsage.user + (usage.system - lastCpuUsage.system);
  lastCpuUsage = usage;
  lastSampleAt = now;
  if (elapsedMs <= 0) return 0;
  // deltaCpuUs is microseconds of CPU time across all cores; normalize by
  // core count so a fully-busy single core doesn't read as e.g. 800% on a
  // multi-core box, matching how Task Manager/Activity Monitor report it.
  const coreCount = Math.max(1, cpus().length);
  const percent = (deltaCpuUs / 1000 / elapsedMs) * 100 / coreCount;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

function memorySnapshot() {
  const rss = process.memoryUsage().rss;
  const total = totalmem();
  const free = freemem();
  return {
    // This process only (what "Clear RAM usage" / Bun.gc affects).
    memoryUsedMb: Math.round((rss / 1024 / 1024) * 10) / 10,
    // Whole machine — every process, not just ours.
    memorySystemUsedMb: Math.round(((total - free) / 1024 / 1024) * 10) / 10,
    memoryTotalMb: Math.round(total / 1024 / 1024),
  };
}

export const healthRoutes = new Elysia({ prefix: "/console/api/health" })
  .get("/metrics", () => ({
    ...memorySnapshot(),
    cpuPercent: sampleCpuPercent(),
  }))
  .post("/gc", () => {
    const before = memorySnapshot();
    Bun.gc(true);
    const after = memorySnapshot();
    addAuditEvent("health.gc", { freedMb: Math.round((before.memoryUsedMb - after.memoryUsedMb) * 10) / 10 });
    return { before, after };
  });

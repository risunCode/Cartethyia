/**
 * Health metrics — this process's memory (RSS) against total system memory,
 * and CPU% sampled as a delta of `process.cpuUsage()` over wall-clock time
 * since the previous poll (first call after a cold start/GC has nothing to
 * diff against, so it reports 0). "Clear RAM usage" schedules a process-wide,
 * asynchronous Bun GC at an idle point instead of synchronously pausing live
 * proxy traffic.
 */

import { Elysia } from "elysia";
import { cpus, freemem, totalmem } from "node:os";
import { addAuditEvent } from "../db/repos/audit";
import { scheduleGlobalGc } from "../memory";
const SERVER_STARTED_AT = Date.now();
const CPU_INFO = cpus();
let _version: string | undefined;
function getVersion(): string {
  if (_version) return _version;
  try { _version = (JSON.parse(require("fs").readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version) as string; } catch { _version = "unknown"; }
  return _version;
}

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
  const coreCount = Math.max(1, CPU_INFO.length);
  const percent = (deltaCpuUs / 1000 / elapsedMs) * 100 / coreCount;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

function memorySnapshot() {
  const mem = process.memoryUsage();
  const total = totalmem();
  const free = freemem();
  const toMb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
  return {
    memoryUsedMb: toMb(mem.rss),
    memorySystemUsedMb: toMb(total - free),
    memoryTotalMb: Math.round(total / 1024 / 1024),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    // Native C++ / NAPI: SQLite prepared statements, Bun internals
    externalMb: toMb(mem.external),
    // ArrayBuffer backing stores: SSE response chunks, body buffers
    arrayBuffersMb: toMb(mem.arrayBuffers),
  };
}

export const healthRoutes = new Elysia({ prefix: "/console/api/health" })
  .get("/status", () => {
    const now = Date.now();
    return {
      version: getVersion(),
      startedAt: SERVER_STARTED_AT,
      uptimeSeconds: Math.floor((now - SERVER_STARTED_AT) / 1000),
      // Lets the client compute a clock-drift offset so displayed "system
      // time" reflects this server's clock, not the browser's.
      now,
      // JS convention (Date.prototype.getTimezoneOffset): minutes to ADD to
      // local time to reach UTC. Lets the client render the server's own
      // wall-clock time (not the browser's timezone) alongside UTC.
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    };
  })
  .get("/metrics", () => ({
      ...memorySnapshot(),
      cpuPercent: sampleCpuPercent(),
      coreCount: CPU_INFO.length,
      cpuModel: CPU_INFO[0]?.model?.replace(/\s+/g, " ").trim() ?? "Unknown",
      pid: process.pid,
    }))
  .post("/gc", () => {
    const before = memorySnapshot();
    const gc = scheduleGlobalGc();
    const after = memorySnapshot();
    addAuditEvent("health.gc", { status: gc.status, inFlight: gc.inFlight });
    return { before, after, gc };
  });

/**
 * Log/asset maintenance — daily rotation cleanup. Started only from the
 * server entrypoint (never in tests); interval is unref'd.
 */

import { readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConsoleEnv } from "../env";
import { getRuntimeSettings } from "../runtime";
import { deleteAssetsOlderThan } from "../db/repos/details";
import { pushConsoleLog } from "../logs/ring";

let started = false;

function cutoffDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function deleteOldFiles(dir: string, olderThanDate: string, prefix: string): number {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    // file names look like requests-YYYY-MM-DD.jsonl
    const match = /(\d{4}-\d{2}-\d{2})/.exec(entry);
    if (!match || match[1]! >= olderThanDate) continue;
    try {
      unlinkSync(join(dir, entry));
      removed += 1;
    } catch {
      // busy file — skip
    }
  }
  return removed;
}

function runCleanup(): void {
  const env = getConsoleEnv();
  const runtime = getRuntimeSettings();
  const logCutoff = cutoffDate(runtime.logRetentionDays);
  const assetCutoff = cutoffDate(runtime.assetRetentionDays);

  const logsRemoved = deleteOldFiles(env.logDir, logCutoff, "requests-") + deleteOldFiles(env.logDir, logCutoff, "errors-");
  const payloadsRemoved = deleteOldFiles(env.payloadDir, assetCutoff, "");
  const orphanPaths = deleteAssetsOlderThan(assetCutoff);
  let assetsRemoved = 0;
  for (const path of orphanPaths) {
    try {
      if (statSync(path).isFile()) {
        unlinkSync(path);
        assetsRemoved += 1;
      }
    } catch {
      // already gone
    }
  }
  if (logsRemoved + payloadsRemoved + assetsRemoved > 0) {
    pushConsoleLog("info", "maintenance", `cleanup removed ${logsRemoved} logs, ${payloadsRemoved} payloads, ${assetsRemoved} assets`);
  }
}

export function startLogMaintenance(): void {
  if (started) return;
  started = true;
  try {
    runCleanup();
  } catch {
    // never crash boot
  }
  const timer = setInterval(() => {
    try {
      runCleanup();
    } catch {
      // keep the loop alive
    }
  }, 6 * 3_600_000);
  timer.unref?.();
}

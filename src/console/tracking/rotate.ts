/**
 * Runtime data maintenance — daily retention cleanup against `runtime.sqlite`
 * (request history, request details, tool calls, console logs). Started only
 * from the server entrypoint (never in tests); interval is unref'd.
 */

import { getRuntimeSettings } from "../runtime";
import { deleteRequestHistoryOlderThan } from "../db/repos/usage";
import { deleteRequestDetailsOlderThan, deleteRequestAssetsOlderThan, deleteRequestToolCallsOlderThan } from "../db/repos/details";
import { deleteConsoleLogsOlderThan, pushConsoleLog } from "../logs/ring";
import { cutoffDate } from "../../utils/date-utils";
import { unlinkSync, statSync } from "node:fs";

let started = false;

function runCleanup(): void {
  const runtime = getRuntimeSettings();
  const logCutoff = cutoffDate(runtime.logRetentionDays);
  const assetCutoff = cutoffDate(runtime.assetRetentionDays);

  const historyRemoved = deleteRequestHistoryOlderThan(logCutoff);
  const consoleLogsRemoved = deleteConsoleLogsOlderThan(logCutoff);
  const detailsRemoved = deleteRequestDetailsOlderThan(assetCutoff);
  const toolCallsRemoved = deleteRequestToolCallsOlderThan(assetCutoff);
  const orphanPaths = deleteRequestAssetsOlderThan(assetCutoff);
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
  const logsRemoved = historyRemoved + consoleLogsRemoved;
  const detailRowsRemoved = detailsRemoved + toolCallsRemoved;
  if (logsRemoved + detailRowsRemoved + assetsRemoved > 0) {
    pushConsoleLog("info", "maintenance", `cleanup removed ${logsRemoved} logs, ${detailRowsRemoved} detail rows, ${assetsRemoved} assets`);
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

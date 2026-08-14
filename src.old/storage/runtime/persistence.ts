import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { ConsoleLogRepository, RetentionResult, RuntimeMetadataRepository, RuntimePersistence } from "./runtime";
import { clearAllRuntimeTables, ensureRuntimeSchema, runtimeError } from "./runtime";
import { getPersistenceEnv, type PersistenceEnv } from "../main/env";
import { createConsoleLogRepository } from "./console-logs";
import { createRuntimeMetadataRepository } from "./metadata";
import { createRuntimePayloadRepository } from "./payloads";
import { retainRuntimeData } from "./retention";
import { createRuntimeTelemetryWriter } from "./telemetry-writer";
import { createWarpMetricsRepository } from "./warp-metrics";
import { createWriteBuffer } from "./write-buffer";
export function createRuntimePersistence(env: PersistenceEnv = getPersistenceEnv()): RuntimePersistence {
  let db: Database | null = null;
  let closed = false;
  let traceIdUnique = false;

  const getDb = (): Database => {
    if (closed) throw runtimeError("runtime database is closed");
    if (db === null) {
      try {
        mkdirSync(dirname(env.runtimeDbPath), { recursive: true });
        const opened = new Database(env.runtimeDbPath, { create: true });
        opened.exec("PRAGMA journal_mode=WAL");
        // NORMAL skips an fsync per commit (WAL still fsyncs at checkpoints):
        // the documented telemetry durability tradeoff. Config state stays at
        // FULL in `config.ts`.
        opened.exec("PRAGMA synchronous=NORMAL");
        opened.exec("PRAGMA busy_timeout=5000");
        // Keep hot telemetry pages in the process cache and avoid temporary
        // aggregate b-trees hitting disk. Runtime data is bounded/retained.
        opened.exec("PRAGMA cache_size=-65536");
        opened.exec("PRAGMA temp_store=MEMORY");
        opened.exec("PRAGMA wal_autocheckpoint=4096");
        opened.exec("PRAGMA optimize");
        traceIdUnique = ensureRuntimeSchema(opened).traceIdUnique;
        db = opened;
      } catch (error) {
        throw runtimeError(`runtime database unavailable: ${error instanceof Error ? error.message : "open failed"}`);
      }
    }
    return db;
  };
  const buffer = createWriteBuffer(getDb);
  const metadata = createRuntimeMetadataRepository(getDb);
  const consoleLogs = createConsoleLogRepository(buffer, getDb);
  const payloads = createRuntimePayloadRepository(buffer, getDb);
  const warpMetrics = createWarpMetricsRepository(buffer, getDb);
  const isTraceIdUnique = (): boolean => traceIdUnique;

  const retain = (options?: { logRetentionDays?: number; assetRetentionDays?: number }): RetentionResult => {
    buffer.flush();
    const settings = retentionDefaultProvider ? retentionDefaultProvider() : { logRetentionDays: env.logRetentionDays, assetRetentionDays: env.assetRetentionDays };
    return retainRuntimeData(getDb, {
      logRetentionDays: options?.logRetentionDays ?? settings.logRetentionDays,
      assetRetentionDays: options?.assetRetentionDays ?? settings.assetRetentionDays,
      assetDir: env.assetDir,
    });
  };

  return {
    env,
    telemetry: createRuntimeTelemetryWriter(buffer, isTraceIdUnique, metadata.invalidate),
    metadata,
    payloads,
    consoleLogs,
    warpMetrics,
    retain,
    startRetentionMaintenance(intervalMs = 6 * 3_600_000): { stop(): void } {
      let timer: Timer | null = null;
      let stopped = false;
      const run = (): void => {
        if (stopped) return;
        try {
          retain();
        } catch {
          // never crash the process over telemetry cleanup
        }
      };
      try {
        run();
      } catch {
        // never crash boot
      }
      timer = setInterval(run, intervalMs);
      timer.unref?.();
      return {
        stop(): void {
          stopped = true;
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    },
    flush: () => buffer.flush(),
    pendingWrites: () => buffer.pending(),
    telemetryStats: () => buffer.stats(),
    checkpoint(): void {
      db?.exec("PRAGMA wal_checkpoint(PASSIVE);");
    },
    db(): Database {
      return getDb();
    },
    closeForSwap(): void {
      // Drain the write-behind buffer so no queued telemetry is lost, then
      // close the old handle. The buffer instance survives — it still
      // references `getDb`, so a subsequent reopen() routes enqueues to the
      // new db. Unlike the terminal shutdown close(), the singleton stays
      // reopenable.
      buffer.flush();
      if (db) {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // mid-close — best effort
        }
        try {
          db.close();
        } catch {
          // already closed — best effort
        }
        db = null;
      }
      closed = false;
    },
    reopen(): void {
      // Re-open against the (possibly swapped) file and re-run schema setup.
      closed = false;
      traceIdUnique = ensureRuntimeSchema(getDb()).traceIdUnique;
    },
    resetAll(): void {
      buffer.flush();
      clearAllRuntimeTables(getDb());
      metadata.invalidate();
    },
    close(): void {
      if (closed) return;
      buffer.close();
      closed = true;
      if (db) {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // already closed or mid-shutdown — best effort
        }
        db.close();
        db = null;
      }
    },
  };
}

let retentionDefaultProvider: (() => { logRetentionDays: number; assetRetentionDays: number }) | null = null;

/**
 * Composition hook: point the maintenance/retention defaults at the config
 * settings repository (console-patched values are picked up on every run).
 */
export function setRetentionDefaults(provider: () => { logRetentionDays: number; assetRetentionDays: number }): void {
  retentionDefaultProvider = provider;
}

let singleton: RuntimePersistence | null = null;

/** Shared application instance; lazily opens on first access. */
export function getRuntimePersistence(): RuntimePersistence {
  if (singleton === null) singleton = createRuntimePersistence();
  return singleton;
}

/** Console-facing metadata accessor (delegates to the shared instance). */
export function getRuntimeMetadataRepository(): RuntimeMetadataRepository {
  return getRuntimePersistence().metadata;
}

/** Console-facing operational log accessor (delegates to the shared instance). */
export function getConsoleLogRepository(): ConsoleLogRepository {
  return getRuntimePersistence().consoleLogs;
}

/** Test-only: close the singleton so the next access re-opens (possibly at a re-pointed env). */
export function resetRuntimePersistenceForTests(): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // already closed — fine
    }
    singleton = null;
  }
}


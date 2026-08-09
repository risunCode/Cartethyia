import { runtimeMemoryLimits } from "../traffic/limits";
import { cancelScheduledGc, scheduleGlobalGc } from "../traffic/memory";

interface Stoppable {
  stop(): void;
}

interface Startable extends Stoppable {
  start(): void;
}

interface Closable {
  close(): void;
}

export interface RuntimeLifecycleDependencies {
  readonly retention: Stoppable;
  readonly logStream: Closable;
  readonly warpService: { shutdown(): Promise<unknown> };
  readonly oauth: Startable;
  readonly quotaRefreshWorker: Startable;
  readonly recoverySweep: Startable;
  readonly runtime: Closable;
  readonly config: Closable;
}

/** Starts process maintenance and returns the deterministic application shutdown action. */
export function createRuntimeLifecycle({ retention, logStream, warpService, oauth, quotaRefreshWorker, recoverySweep, runtime, config }: RuntimeLifecycleDependencies): { readonly close: () => void } {
  const gcIntervalMs = runtimeMemoryLimits.gcIntervalMs > 0 ? runtimeMemoryLimits.gcIntervalMs : 10 * 60_000;
  const gcInterval = setInterval(scheduleGlobalGc, gcIntervalMs);
  gcInterval.unref?.();
  oauth.start();
  quotaRefreshWorker.start();
  recoverySweep.start();
  return {
    close: () => {
      clearInterval(gcInterval);
      cancelScheduledGc();
      retention.stop();
      logStream.close();
      warpService.shutdown().catch(() => {});
      oauth.stop();
      quotaRefreshWorker.stop();
      recoverySweep.stop();
      runtime.close();
      config.close();
    },
  };
}

import { closeDb } from "../persistence/postgres";
import { closeRedis } from "../persistence/redis";
import { buildProductionDeps } from "./dependencies";
import type { ProductionDeps } from "./dependencies";
import { withTimeout } from "./timeout";
import { resolveShutdownDrainWindowMs } from "../config";

export type ShutdownReason = "SIGTERM" | "SIGINT" | "reload" | "update";
export type ShutdownState =
  "idle" | "stop_admitting" | "bounded_drain_wait" | "flush_telemetry" | "close_pools" | "done";

export interface ShutdownHooks {
  flushTelemetry?: (deadlineMs: number) => Promise<void>;
  closePools?: () => Promise<void>;
  abortInflight?: () => void;
}

export class ShutdownCoordinator {
  private state: ShutdownState = "idle";
  private draining = false;
  private inflight = new Set<string>();
  private started = false;
  private beginPromise: Promise<void> | undefined;
  private reason: ShutdownReason = "SIGTERM";
  private hooks: ShutdownHooks;
  private drainWindowMs: number;
  private drainTimeoutMs: number;
  private flushTimeoutMs: number;

  constructor(
    hooks?: ShutdownHooks,
    opts?: { drainWindowMs?: number; drainTimeoutMs?: number; flushTimeoutMs?: number },
  ) {
    this.hooks = hooks ?? {};
    this.drainWindowMs = opts?.drainWindowMs ?? 20_000;
    this.drainTimeoutMs = opts?.drainTimeoutMs ?? 5_000;
    this.flushTimeoutMs = opts?.flushTimeoutMs ?? 2_000;
  }

  /**
   * Upper bound on how long `begin()` can take, so the process-level
   * force-exit guard is derived from the same numbers the drain actually uses
   * rather than a hand-kept literal. A force-exit shorter than the drain would
   * hard-kill a process that was about to finish gracefully — the exact
   * mid-response truncation the drain exists to prevent.
   */
  totalShutdownBudgetMs(): number {
    return this.drainWindowMs + this.drainTimeoutMs + this.flushTimeoutMs + 5_000;
  }

  track(id: string): void {
    if (this.draining) return;
    this.inflight.add(id);
  }

  untrack(id: string): void {
    this.inflight.delete(id);
  }

  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Why the process began draining, for the public termination notice. Defaults
   * to `SIGTERM` (the orchestrator's ordinary stop) and is overwritten by
   * `begin(reason)` — `update` is the in-place image swap, whose callers must
   * see "back shortly" rather than a generic shutdown.
   */
  shutdownReason(): ShutdownReason {
    return this.reason;
  }

  stopAdmitting(): void {
    if (this.state === "idle") {
      this.state = "stop_admitting";
    }
    this.draining = true;
  }

  // idempotent begin
  async begin(reason: ShutdownReason = "SIGTERM"): Promise<void> {
    this.reason = reason;
    if (this.started) return this.beginPromise;
    this.started = true;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.beginPromise = promise;

    // Ordering: stop admitting new work, give in-flight requests a grace window
    // to finish *naturally*, then abort whatever remains so the bounded drain
    // below observes cancellation and finalizers run before telemetry flush and
    // pool close. The grace window matters because most requests complete in
    // well under it: aborting immediately truncated every in-flight response —
    // including long streams that would otherwise have finished — which is the
    // mid-response cut a graceful stop must not cause.
    this.stopAdmitting();

    (async () => {
      try {
        await this.waitForDrain(Date.now() + this.drainWindowMs);
        // Only now abort the stragglers. A draining stream that is aborted
        // emits a terminal frame (see the dispatch stream path) rather than
        // closing silently, so even the aborted requests end explicitly.
        if (this.inflight.size > 0) {
          try {
            this.hooks.abortInflight?.();
          } catch {
          }
        }
        await this.waitForDrain(Date.now() + this.drainTimeoutMs);
        await this.flushTelemetry(Date.now() + this.flushTimeoutMs);
        await this.closePools();
        this.state = "done";
        resolve();
      } catch (e) {
        reject(e as Error);
      }
    })();

    return promise;
  }

  setAbortInflight(handler: (() => void) | undefined): void {
    if (handler === undefined) delete this.hooks.abortInflight;
    else this.hooks.abortInflight = handler;
  }

  async waitForDrain(deadlineMs: number): Promise<void> {
    if (this.state === "stop_admitting") {
      this.state = "bounded_drain_wait";
    }
    // bounded wait: allow in-flight to finish or hit deadline
    while (this.inflight.size > 0) {
      const now = Date.now();
      if (now >= deadlineMs) break;
      const waitMs = Math.min(10, deadlineMs - now);
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }

  async flushTelemetry(deadlineMs: number): Promise<void> {
    if (this.state === "bounded_drain_wait" || this.state === "stop_admitting") {
      this.state = "flush_telemetry";
    }
    const remaining = Math.max(0, deadlineMs - Date.now());
    if (this.hooks.flushTelemetry) {
      try {
        await withTimeout(
          this.hooks.flushTelemetry(deadlineMs),
          remaining,
          "flush telemetry deadline exceeded",
        );
      } catch {
        // deadline exceeded still proceeds to closePools per bounded design
      }
    } else {
      // bounded small delay to simulate flush
      const wait = Math.min(remaining, 5);
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    }
  }

  async closePools(): Promise<void> {
    if (this.state !== "close_pools") {
      this.state = "close_pools";
    }
    if (this.hooks.closePools) {
      await this.hooks.closePools();
    }
  }
}

export interface ElyxiaServer {
  stop(closeActiveConnections?: boolean): unknown;
}

/**
 * All process-lifetime singleton state: connection pools' consumers,
 * background workers, and the shutdown coordinator. Cached on `globalThis`
 * so that `bun --hot` reloads — which re-evaluate this module's top level
 * but keep `globalThis` alive — reuse the same instances instead of
 * spawning duplicate intervals/workers/DB pools on every saved file. Under
 * `--watch` or the compiled production binary the whole OS process restarts
 * fresh each time, so `globalThis.__cartethyiaBoot` is always unset there
 * and this behaves exactly like a normal one-shot boot.
 */
export interface CartethyiaBoot {
  deps: ProductionDeps;
  shutdownCoordinator: ShutdownCoordinator;
  server: ElyxiaServer | undefined;
}


export async function bootstrap(): Promise<CartethyiaBoot> {
  const deps = await buildProductionDeps();
  const boot: CartethyiaBoot = {
    deps,
    server: undefined,
    shutdownCoordinator: new ShutdownCoordinator(
      {
        flushTelemetry: () => deps.telemetryBuffer.flush(),
        closePools: async () => {
          await boot.server?.stop();
          await deps.scheduledTasks.stop();
          await deps.telemetryBuffer.stop({ flush: true });
          await Promise.allSettled([
            closeDb(),
            closeRedis(),
            deps.poolAgentResolver.closeAll(),
          ]);
        },
      },
      {
        drainWindowMs: resolveShutdownDrainWindowMs(),
        drainTimeoutMs: 8_000,
        flushTimeoutMs: 1_000,
      },
    ),
  };
  return boot;
}

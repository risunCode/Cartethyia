import Redis from "ioredis";
import { log } from "../observability/logger";
import { timeoutAfter } from "../runtime/timeout";

export type RedisClient = InstanceType<typeof Redis>;

const DEFAULT_QUIT_TIMEOUT_MS = 2_000;

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL is required (e.g. redis://localhost:6379). " +
        "Cartethyia never infers a Docker or Laragon connection automatically.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: ${url}`);
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error(
      `REDIS_URL must include explicit host and port (got hostname="${parsed.hostname}" port="${parsed.port}")`,
    );
  }
  return url;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaRedis: RedisClient | undefined;
}

export function getRedis(): RedisClient {
  if (globalThis.__cartethyiaRedis) return globalThis.__cartethyiaRedis;
  const c = new Redis(requireRedisUrl(), {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  c.on("error", (err) => {
    // Visible but does not crash the process; health checks surface the state.
    log.error("[redis] connection error", err);
  });
  globalThis.__cartethyiaRedis = c;
  return c;
}

export function getRedisOrUndefined(): RedisClient | undefined {
  try {
    return getRedis();
  } catch {
    return undefined;
  }
}

export interface CloseRedisOptions {
  /** Bounded wait for `QUIT` before falling back to `disconnect()`. Defaults to 2s. */
  readonly quitTimeoutMs?: number;
}

/**
 * Gracefully closes the shared Redis connection: `QUIT` with a bounded
 * timeout, falling back to `disconnect()` only when `QUIT` does not resolve
 * in time. Failure-isolated — shutdown must never hang on Redis.
 */
export async function closeRedis(options: CloseRedisOptions = {}): Promise<void> {
  const c = globalThis.__cartethyiaRedis;
  if (!c) return;
  globalThis.__cartethyiaRedis = undefined;
  try {
    await Promise.race([
      c.quit(),
      timeoutAfter(options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS, "redis quit timed out"),
    ]);
  } catch {
    try {
      c.disconnect();
    } catch (error) {
      log.error("[redis] disconnect after quit timeout failed", error as Error);
    }
  }
}

export function setRedisForTesting(testClient: RedisClient): void {
  globalThis.__cartethyiaRedis = testClient;
}

/**
 * Runs a Lua script and returns its result as a finite number, or throws.
 *
 * Every scripted call here is a fixed, static script string (no dynamic
 * `eval` of caller input) and atomic — `INCR`+`EXPIRE` either both apply or
 * neither does, so a failure cannot leave half-updated distributed state.
 * What this guard adds: a NaN/garbled result (desynced script/args, cluster
 * resharding mid-eval) surfaces as a thrown error instead of silently
 * reading as a bogus counter value at the call site.
 */
export async function redisEvalNumber(
  redis: RedisClient,
  script: string,
  numKeys: number,
  ...keysAndArgs: (string | number)[]
): Promise<number> {
  const raw = await evalRaw(redis, script, numKeys, keysAndArgs);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`[redis] eval returned a non-finite result: ${String(raw)}`);
  }
  return value;
}

/**
 * Runs a Lua script and returns its result as an array of the script's own
 * elements, for scripts that decide and report several things at once.
 *
 * The array shape is validated here (not per call site): a script whose
 * multi-value return arrived as a scalar, or a reply the client could not
 * parse, would otherwise reach callers as an array of the wrong length or a
 * string they must re-split. Throwing keeps one guard for every tuple script,
 * matching {@link redisEvalNumber}'s job for the scalar ones. Elements are
 * returned as the driver decoded them; a caller converts and range-checks its
 * own fields, because only it knows which are counts and which are flags.
 */
export async function redisEvalTuple(
  redis: RedisClient,
  script: string,
  numKeys: number,
  ...keysAndArgs: (string | number)[]
): Promise<readonly unknown[]> {
  const raw = await evalRaw(redis, script, numKeys, keysAndArgs);
  if (!Array.isArray(raw)) {
    throw new Error(`[redis] eval returned a non-array result: ${String(raw)}`);
  }
  return raw as readonly unknown[];
}

async function evalRaw(
  redis: RedisClient,
  script: string,
  numKeys: number,
  keysAndArgs: readonly (string | number)[],
): Promise<unknown> {
  return (
    redis as unknown as {
      eval: (
        script: string,
        numKeys: number,
        ...args: (string | number)[]
      ) => Promise<unknown>;
    }
  ).eval(script, numKeys, ...keysAndArgs);
}

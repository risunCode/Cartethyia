import Redis from "ioredis";
import { log } from "../observability/logger";
import { timeoutAfter } from "../runtime/timeout";
import { encodeConnectionComponent, formatConnectionHost, requireConnectionUrl } from "./connection-url";

export type RedisClient = InstanceType<typeof Redis>;

const DEFAULT_QUIT_TIMEOUT_MS = 2_000;

/**
 * Assembles the discrete Redis variables into a URL, or `undefined` when the
 * host/port pair is missing.
 *
 * Redis puts the password in the URL's userinfo as `:password@` when there is no
 * username, so a password-only configuration must still emit the leading colon.
 */
function redisUrlFromParts(): string | undefined {
  const host = process.env.REDISHOST?.trim();
  const port = process.env.REDISPORT?.trim();
  if (!host || !port) return undefined;
  const user = process.env.REDISUSER?.trim();
  const password = process.env.REDISPASSWORD;
  const hasUser = user !== undefined && user.length > 0;
  const hasPassword = password !== undefined && password.length > 0;
  let credentials = "";
  if (hasUser && hasPassword) {
    credentials = `${encodeConnectionComponent(user)}:${encodeConnectionComponent(password)}@`;
  } else if (hasUser) {
    credentials = `${encodeConnectionComponent(user)}@`;
  } else if (hasPassword) {
    credentials = `:${encodeConnectionComponent(password)}@`;
  }
  return `redis://${credentials}${formatConnectionHost(host)}:${port}`;
}

function requireRedisUrl(): string {
  return requireConnectionUrl({
    schemes: ["redis:", "rediss:"],
    candidates: [
      { source: "REDIS_URL", value: process.env.REDIS_URL },
      { source: "REDIS_PUBLIC_URL", value: process.env.REDIS_PUBLIC_URL },
    ],
    assembled: {
      source: "REDISHOST/REDISPORT/REDISUSER/REDISPASSWORD",
      value: redisUrlFromParts(),
    },
    missing:
      "No Redis connection string is configured. Set REDIS_URL to the full URL " +
      "(redis://localhost:6379). On Railway, reference the Redis service from the app service's " +
      "Variables tab (REDIS_URL=${{ Redis.REDIS_URL }}), spelling the service name exactly — a " +
      "reference to a service that does not exist resolves to an empty string. REDISHOST, REDISPORT, " +
      "REDISUSER and REDISPASSWORD are accepted as an alternative. " +
      "Cartethyia never infers a Docker or Laragon connection automatically.",
  });
}

declare global {
  // eslint-disable-next-line no-var -- globalThis augmentation requires `var`
  var __cartethyiaRedis: RedisClient | undefined;
}

/**
 * The single Redis rule: a configured URL means a real shared client, no URL
 * means the in-process memory backend (every consumer already handles an
 * undefined client). There is no mode flag anymore.
 */
export function resolveRedisClient(): RedisClient | undefined {
  if (globalThis.__cartethyiaRedis) return globalThis.__cartethyiaRedis;
  let url: string;
  try {
    url = requireRedisUrl();
  } catch {
    return undefined;
  }
  const c = new Redis(url, {
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

/** Which coordination backend is active: shared Redis or process memory. */
export type RedisBackend = "redis" | "memory";

export function resolveRedisBackend(client: RedisClient | undefined): RedisBackend {
  return client === undefined ? "memory" : "redis";
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

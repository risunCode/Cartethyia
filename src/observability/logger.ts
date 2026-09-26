import pino from 'pino';
import { pushConsoleLog, type ConsoleLogLevel } from './log-ring';
import { redactTelemetryValue } from './redaction';

/**
 * Structured logger using Pino for production-ready logging.
 * Replaces console.log/warn/error with structured, level-based logging.
 */

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Pretty-printing runs the `pino-pretty` transport in a **worker thread**, and
 * that thread outlives the log call: it is torn down when the process exits,
 * which in a test worker means it can exit mid-run and take the worker with it
 * (`error: the worker thread exited`, surfacing as unrelated failures across
 * whatever file the worker was running). It is also pure presentation — a
 * human reading a terminal — so it is enabled only for an interactive TTY.
 * Piped output, CI, and tests get the plain JSON transport, which writes on
 * the calling thread and has nothing to tear down.
 */
const wantsPrettyTransport = isDevelopment && process.stdout.isTTY === true;

const baseOptions = {
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  formatters: {
    level: (label: string) => {
      return { level: label };
    },
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Pretty print for an interactive terminal, JSON everywhere else.
const developmentOptions = wantsPrettyTransport
  ? {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    }
  : {};

const logger = pino({
  ...baseOptions,
  ...developmentOptions,
});

/**
 * Circular-safe, depth-capped structural copy for the ring pre-pass.
 * `redactTelemetryValue` (the canonical redactor, applied next) recurses
 * without a cycle guard, so a circular log arg would overflow the stack
 * before redaction even runs. Errors collapse to name+message — stacks are
 * too long for a tail line and the message already carries the cause.
 */
function decycle(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth > 5) return "[truncated]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => decycle(item, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = decycle(entry, seen, depth + 1);
  return out;
}

/**
 * Flatten a log call into one ring line. Args go through the shared
 * telemetry redactor (embedded `sk-`/`Bearer`/`rk_` shapes become
 * `***REDACTED***`) so the live console tail can never leak credential
 * material that a structured error object happened to carry.
 */
function formatRingMessage(msg: string, args: readonly unknown[]): string {
  if (args.length === 0) return msg;
  let rendered = "";
  try {
    rendered = JSON.stringify(redactTelemetryValue(decycle(args.length === 1 ? args[0] : args)) ?? null);
  } catch {
    rendered = "[unserializable args]";
  }
  return rendered.length > 0 ? `${msg} ${rendered}` : msg;
}

function ring(level: ConsoleLogLevel, msg: string, args: readonly unknown[]): void {
  try {
    pushConsoleLog(level, msg.length > 0 ? formatRingMessage(msg, args) : formatRingMessage("(empty)", args));
  } catch {
    // The ring is observability-only; it must never break the log call itself.
  }
}

/**
 * Log levels
 */
export const log = {
  debug: (msg: string, ...args: unknown[]) => {
    ring("debug", msg, args);
    logger.debug({ args }, msg);
  },
  info: (msg: string, ...args: unknown[]) => {
    ring("info", msg, args);
    logger.info({ args }, msg);
  },
  warn: (msg: string, ...args: unknown[]) => {
    ring("warn", msg, args);
    logger.warn({ args }, msg);
  },
  error: (msg: string, error?: Error, ...args: unknown[]) => {
    ring("error", msg, error ? [error, ...args] : args);
    if (error) {
      logger.error({ error, args }, msg);
    } else {
      logger.error({ args }, msg);
    }
  },
};
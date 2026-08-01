/**
 * Buffered stdout writer for the per-request access log line in
 * `middleware.ts`. `console.log`/`process.stdout.write` is a synchronous
 * syscall whenever stdout is piped rather than an interactive TTY - the
 * normal case under Docker/Railway, where the container log driver reads a
 * pipe. At high request volume that's one blocking write syscall per
 * request on every single proxied request. Batching lines into one write
 * every ~50ms (or every 200 lines, whichever comes first) turns that into a
 * write syscall roughly every 50ms instead of every request.
 */

const buffer: string[] = [];
let flushTimer: Timer | null = null;

const FLUSH_INTERVAL_MS = 50;
const FLUSH_THRESHOLD = 200;

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const chunk = buffer.splice(0, buffer.length).join("");
  process.stdout.write(chunk);
}

/** Queues one access-log line (no trailing newline needed) for the next batched stdout write. */
export function logRequestLine(line: string): void {
  buffer.push(`${line}\n`);
  if (buffer.length >= FLUSH_THRESHOLD) {
    flush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

/** Flushes any buffered lines immediately. Called periodically and on graceful shutdown. */
export function flushRequestLogBuffer(): void {
  flush();
}

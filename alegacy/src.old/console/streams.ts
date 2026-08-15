/**
 * Bounded fanout hub for the console log SSE stream (/console/api/console-logs/stream).
 *
 * Each attached client receives one bounded `init` snapshot (newest-first, with
 * an optional `lastId` watermark) and then only `line` deltas for rows written
 * after its watermark, produced by a single shared tick — never a full-ring
 * snapshot per client per tick. `ping` frames keep idle connections alive so
 * silent streams are not dropped by intermediaries; `clear` resets every
 * client after a server-side clear.
 *
 * Limits are environment-tunable but always clamped. The hub never retains the
 * `Request` object: per-client state holds only a stream controller, and
 * detach removes the client entry entirely so aborted connections are
 * collectable.
 */

import type { ConsoleLogCategoryFilter, ConsoleLogFilters, ConsoleLogRow } from "../storage";
import { isLogCategoryFilter } from "../application/logging";
import type { ConsoleLogLine } from "./services/composition";

/** Row source backing the stream — newest-first `latest`, ascending `after`. */
export interface ConsoleLogStreamSource {
  latest(limit: number, filters?: ConsoleLogFilters): readonly ConsoleLogRow[];
  after(afterId: number, limit: number, filters?: ConsoleLogFilters): readonly ConsoleLogRow[];
  /** Optional push notification — when a row is written, call this to trigger immediate delivery. */
  onPush?: (listener: () => void) => () => void;
}

export interface ConsoleLogStreamHub {
  /** Create a stream response for one client; never stores the request. */
  handle(request: Request): Response;
  /** Push `clear` to every attached client and advance their watermarks. */
  broadcastClear(): void;
  /** Stop the shared tick and drop all clients (application shutdown). */
  close(): void;
  readonly activeClients: number;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(Bun.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

const STREAM_LIMITS = Object.freeze({
  maxClients: boundedInteger("CARTETHYIA_CONSOLE_LOG_CLIENTS", 16, 1, 64),
  maxSnapshotLines: boundedInteger("CARTETHYIA_CONSOLE_LOG_SNAPSHOT_LINES", 200, 1, 1_000),
  maxBatchLines: boundedInteger("CARTETHYIA_CONSOLE_LOG_BATCH_LINES", 100, 1, 500),
  maxEventBytes: boundedInteger("CARTETHYIA_CONSOLE_LOG_EVENT_BYTES", 256 * 1024, 8 * 1024, 4 * 1024 * 1024),
  tickMs: boundedInteger("CARTETHYIA_CONSOLE_LOG_TICK_MS", 2_000, 500, 30_000),
  pushDebounceMs: boundedInteger("CARTETHYIA_CONSOLE_LOG_PUSH_DEBOUNCE_MS", 32, 16, 500),
});

interface LogStreamClient {
  readonly id: number;
  readonly category: ConsoleLogCategoryFilter;
  lastId: number;
  closed: boolean;
  enqueue(frame: Uint8Array): void;
}

function wireLine(row: ConsoleLogRow): ConsoleLogLine {
  return { id: row.id, ts: row.ts, level: row.level, scope: row.scope, category: row.category, msg: row.msg };
}

export function createConsoleLogStreamHub(source: ConsoleLogStreamSource): ConsoleLogStreamHub {
  const encoder = new TextEncoder();
  let clients = new Map<number, LogStreamClient>();
  let nextClientId = 1;
  let timer: Timer | undefined;
  let pushTimer: Timer | undefined;

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (pushTimer !== undefined) {
      clearTimeout(pushTimer);
      pushTimer = undefined;
    }
  };

  /** Serialize and enqueue one event, enforcing the serialized-byte bound. */
  const deliver = (client: LogStreamClient, event: string, data: unknown): boolean => {
    if (client.closed) return false;
    const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (frame.byteLength > STREAM_LIMITS.maxEventBytes) return false;
    try {
      client.enqueue(frame);
    } catch {
      client.closed = true;
      return false;
    }
    return true;
  };

  const tick = (): void => {
    if (clients.size === 0) return;
    const groups = new Map<ConsoleLogCategoryFilter, { minLastId: number; clientCount: number }>();
    for (const client of clients.values()) {
      const group = groups.get(client.category);
      if (group === undefined) {
        groups.set(client.category, { minLastId: client.lastId, clientCount: 1 });
      } else {
        group.minLastId = Math.min(group.minLastId, client.lastId);
        group.clientCount += 1;
      }
    }
    const rowsByCategory = new Map<ConsoleLogCategoryFilter, readonly ConsoleLogRow[]>();
    for (const [category, group] of groups) {
      rowsByCategory.set(category, source.after(group.minLastId, STREAM_LIMITS.maxBatchLines * group.clientCount, { category }));
    }
    for (const client of clients.values()) {
      const rows = rowsByCategory.get(client.category) ?? [];
      let delivered = false;
      for (const row of rows) {
        if (row.id <= client.lastId) continue;
        deliver(client, "line", wireLine(row));
        client.lastId = row.id;
        delivered = true;
      }
      if (!delivered) deliver(client, "ping", {});
    }
  };

  /** Coalesce source notifications so a log burst produces one DB read. */
  const pushTick = (): void => {
    if (clients.size === 0 || pushTimer !== undefined) return;
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      tick();
    }, STREAM_LIMITS.pushDebounceMs);
    pushTimer.unref?.();
  };

  // Subscribe to push notifications for immediate delivery (no 2s delay).
  let unsubscribePush: (() => void) | undefined;
  const ensurePushSubscription = (): void => {
    if (unsubscribePush !== undefined || !source.onPush) return;
    unsubscribePush = source.onPush(pushTick);
  };

  const ensureTimer = (): void => {
    if (timer === undefined) {
      timer = setInterval(tick, STREAM_LIMITS.tickMs);
      timer.unref?.();
    }
  };

  const broadcastClear = (): void => {
    if (clients.size === 0) return;
    // Advance every client past the rows that were just cleared so pre-clear
    // rows are never replayed; rows written afterwards still flow as deltas.
    const top = source.latest(1)[0]?.id ?? 0;
    for (const client of clients.values()) {
      client.lastId = Math.max(client.lastId, top);
      deliver(client, "clear", {});
    }
  };

  const handle = (request: Request): Response => {
    const categoryValue = new URL(request.url).searchParams.get("category");
    const category: ConsoleLogCategoryFilter = isLogCategoryFilter(categoryValue) ? categoryValue : "all";
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let client: LogStreamClient | null = null;

    const detach = (): void => {
      if (client === null) return;
      clients.delete(client.id);
      client.closed = true;
      client = null;
      if (clients.size === 0) stopTimer();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        request.signal.addEventListener("abort", detach, { once: true });
        if (request.signal.aborted) {
          detach();
          controller.close();
          return;
        }
        ensurePushSubscription();
        if (clients.size >= STREAM_LIMITS.maxClients) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ message: "too many active console log stream clients" })}\n\n`),
          );
          controller.close();
          return;
        }
        const snapshot = source.latest(STREAM_LIMITS.maxSnapshotLines, { category });
        const top = snapshot[0]?.id ?? 0;
        client = {
          id: nextClientId++,
          category,
          lastId: top,
          closed: false,
          enqueue(frame) {
            if (this.closed) return;
            controller?.enqueue(frame);
          },
        };
        clients.set(client.id, client);
        // Bounded init snapshot; if it exceeds the byte cap, drop oldest rows
        // (snapshot is newest-first) and retry.
        let lines = snapshot.map(wireLine);
        let frame = encoder.encode(`event: init\ndata: ${JSON.stringify({ lines, lastId: top })}\n\n`);
        while (frame.byteLength > STREAM_LIMITS.maxEventBytes && lines.length > 1) {
          lines = lines.slice(0, -1);
          frame = encoder.encode(`event: init\ndata: ${JSON.stringify({ lines, lastId: top })}\n\n`);
        }
        if (frame.byteLength > STREAM_LIMITS.maxEventBytes) {
          frame = encoder.encode(`event: error\ndata: ${JSON.stringify({ message: "console log snapshot too large" })}\n\n`);
        }
        controller.enqueue(frame);
        ensureTimer();
      },
      cancel() {
        detach();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  };

  const close = (): void => {
    stopTimer();
    unsubscribePush?.();
    unsubscribePush = undefined;
    for (const client of clients.values()) client.closed = true;
    clients.clear();
  };

  return {
    handle,
    broadcastClear,
    close,
    get activeClients() {
      return clients.size;
    },
  };
}

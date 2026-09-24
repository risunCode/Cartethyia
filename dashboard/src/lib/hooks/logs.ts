import { useCallback, useEffect, useRef, useState } from "react";
import { consoleRequest, isRecord } from "../api";

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";

export interface ConsoleLogLine {
  readonly ts: string;
  readonly level: ConsoleLogLevel;
  readonly msg: string;
  readonly event?: "request_start" | "request_complete" | "request_error" | "token_refresh";
  readonly requestId?: string;
  readonly endpoint?: string;
  readonly method?: string;
  readonly model?: string;
  readonly routedModel?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly networkPoolId?: string;
  readonly clientIp?: string;
  readonly userAgent?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly details?: Record<string, unknown>;
}

export type ConsoleLogStatus = "live" | "reconnecting" | "idle";

/** A stored log line with a stable monotonic id assigned by the stream hook. */
export interface ConsoleLogEntry extends ConsoleLogLine {
  readonly id: string;
}

const MAX_LINES = 500;
const STREAM_RETRY_MS = 5_000;
/** How long a freshly streamed line keeps its highlight before fading. */
const NEW_LINE_HIGHLIGHT_MS = 1_500;

function isLogLine(value: unknown): value is ConsoleLogLine {
  return (
    isRecord(value) &&
    typeof value.ts === "string" &&
    (value.level === "debug" ||
      value.level === "info" ||
      value.level === "warn" ||
      value.level === "error") &&
    typeof value.msg === "string"
  );
}

function readLines(payload: unknown): ConsoleLogLine[] {
  if (!isRecord(payload) || !Array.isArray(payload.lines)) return [];
  return payload.lines.filter(isLogLine);
}

/**
 * Live server-log tail over the console SSE stream (`GET /logs/stream`).
 * Opens with an authenticated snapshot fetch — so a dead session bounces to
 * login through the shell's normal 401 handling instead of spinning a retry
 * loop — then appends `line` events, applies `clear`, and re-snapshots +
 * re-opens after a short delay on transport failure.
 */
export function useConsoleLogStream() {
  const [lines, setLines] = useState<readonly ConsoleLogEntry[]>([]);
  const [newLineIds, setNewLineIds] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<ConsoleLogStatus>("idle");
  const attempt = useRef(0);
  const nextId = useRef(0);
  // Tag every stored line with a monotonic id so the view can key rows stably
  // and highlight the ones that arrived after the last snapshot.
  const tag = (line: ConsoleLogLine): ConsoleLogEntry => ({
    ...line,
    id: `l${(nextId.current += 1)}`,
  });

  useEffect(() => {
    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const runId = (attempt.current += 1);

    const append = (line: ConsoleLogLine) => {
      const stored = tag(line);
      setNewLineIds((prev) => {
        const next = new Set(prev);
        next.add(stored.id);
        return next;
      });
      // Drop the "new" highlight shortly after arrival so the list settles
      // into a steady state instead of every recent line staying flagged.
      window.setTimeout(() => {
        setNewLineIds((prev) => {
          if (!prev.has(stored.id)) return prev;
          const next = new Set(prev);
          next.delete(stored.id);
          return next;
        });
      }, NEW_LINE_HIGHLIGHT_MS);
      setLines((prev) => {
        const next = [...prev, stored];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    const openStream = () => {
      source = new EventSource("/console/api/logs/stream");
      source.addEventListener("init", (event) => {
        if (stopped) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data as string) as unknown;
          if (isRecord(payload)) {
            setLines(readLines(payload).slice(-MAX_LINES).map(tag));
            setNewLineIds(new Set());
          }
          setStatus("live");
        } catch {
          // Malformed frame: keep polling state.
        }
      });
      source.addEventListener("line", (event) => {
        if (stopped) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data as string) as unknown;
          if (isLogLine(payload)) {
            append(payload);
            setStatus("live");
          }
        } catch {
          // Malformed frame: keep the last good state.
        }
      });
      source.addEventListener("clear", () => {
        if (!stopped) {
          setLines([]);
          setNewLineIds(new Set());
        }
      });
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        setStatus("reconnecting");
        retryTimer = setTimeout(() => {
          if (!stopped && runId === attempt.current) void snapshotThenStream();
        }, STREAM_RETRY_MS);
      };
    };

    const snapshotThenStream = async () => {
      try {
        const snapshot = await consoleRequest<unknown>("/logs?limit=200");
        if (stopped || runId !== attempt.current) return;
        setLines(readLines(snapshot).slice(-MAX_LINES).map(tag));
        setNewLineIds(new Set());
        openStream();
      } catch {
        // Unauthenticated (shell handles the transition) or offline: stay idle.
      }
    };

    void snapshotThenStream();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  const clear = useCallback(async () => {
    await consoleRequest<unknown>("/logs", { method: "DELETE" });
    setLines([]);
    setNewLineIds(new Set());
  }, []);

  return { lines, newLineIds, status, clear };
}

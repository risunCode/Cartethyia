/**
 * useConsoleLogStream — EventSource hook for /console/api/console-logs/stream
 * (design §9.3): backoff 1s→2s→…→30s, SQL-backed snapshot cap 200 lines, status badge state.
 * Native EventSource handles SSE framing + sends the session cookie same-origin.
 *
 * Incoming `line` events are coalesced into batches and committed with one
 * state update per batch (per animation frame), so the 200-line view is copied
 * once per burst instead of once per line event.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";
export type ConsoleLogCategory = "all" | "web" | "request" | "system";

export interface ConsoleLogLine {
  id: number;
  ts: string;
  level: ConsoleLogLevel;
  scope: string;
  category: Exclude<ConsoleLogCategory, "all">;
  msg: string;
}

export type StreamStatus = "connected" | "connecting" | "error";

const MAX_LINES = 200;
const STREAM_URL = "/console/api/console-logs/stream";
/** Fallback flush window when the tab is hidden and requestAnimationFrame is throttled. */
const FLUSH_FALLBACK_MS = 32;

export interface ConsoleLogStream {
  lines: ConsoleLogLine[];
  newLineIds: ReadonlySet<number>;
  status: StreamStatus;
  attempts: number;
}

export function useConsoleLogStream(category: ConsoleLogCategory = "request"): ConsoleLogStream {
  const [lines, setLines] = useState<ConsoleLogLine[]>([]);
  const [newLineIds, setNewLineIds] = useState<ReadonlySet<number>>(new Set());
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [attempts, setAttempts] = useState(0);
  const attemptsRef = useRef(0);
  const watermarkRef = useRef(0);
  const pendingRef = useRef<ConsoleLogLine[]>([]);
  const scheduledRef = useRef(false);
  const rafRef = useRef(0);
  const flushTimerRef = useRef(0);
  const reconnectTimerRef = useRef(0);
  const highlightTimerRef = useRef(0);

  /** Commit the pending batch as one newest-first ring update. */
  const flushPending = useCallback(() => {
    scheduledRef.current = false;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    setLines((prev) => {
      const merged = [...batch].reverse().concat(prev);
      return merged.length <= MAX_LINES ? merged : merged.slice(0, MAX_LINES);
    });
    setNewLineIds(new Set(batch.map((line) => line.id)));
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setNewLineIds(new Set()), 3_000);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    rafRef.current = requestAnimationFrame(flushPending);
    flushTimerRef.current = window.setTimeout(flushPending, FLUSH_FALLBACK_MS);
  }, [flushPending]);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    const streamUrl = `${STREAM_URL}?category=${encodeURIComponent(category)}`;

    setLines([]);
    setNewLineIds(new Set());
    pendingRef.current = [];
    watermarkRef.current = 0;

    const connect = () => {
      if (disposed) return;
      setStatus(attemptsRef.current === 0 ? "connecting" : "error");
      const es = new EventSource(streamUrl, { withCredentials: true });
      source = es;
      es.addEventListener("init", (event) => {
        const data = JSON.parse((event as MessageEvent).data as string) as { lines: ConsoleLogLine[]; lastId?: number };
        pendingRef.current = [];
        watermarkRef.current = Math.max(data.lastId ?? 0, ...data.lines.map((line) => line.id));
        setNewLineIds(new Set());
        setLines(data.lines.slice(0, MAX_LINES));
        setStatus("connected");
        attemptsRef.current = 0;
        setAttempts(0);
      });
      es.addEventListener("line", (event) => {
        const line = JSON.parse((event as MessageEvent).data as string) as ConsoleLogLine;
        if (line.id <= watermarkRef.current) return;
        watermarkRef.current = line.id;
        const pending = pendingRef.current;
        if (pending.length >= MAX_LINES) pending.splice(0, pending.length - MAX_LINES + 1);
        pending.push(line);
        scheduleFlush();
      });
      es.addEventListener("clear", () => {
        pendingRef.current = [];
        watermarkRef.current = 0;
        setNewLineIds(new Set());
        setLines([]);
      });

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setStatus("error");
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30_000);
        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      clearTimeout(flushTimerRef.current);
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(highlightTimerRef.current);
      source?.close();
    };
  }, [scheduleFlush, category]);

  return { lines, newLineIds, status, attempts };
}
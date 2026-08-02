/**
 * useConsoleLogStream — EventSource hook for /console/api/console-logs/stream
 * (design §9.3): backoff 1s→2s→…→30s, ring cap 1000 lines, status badge state.
 * Native EventSource handles SSE framing + sends the session cookie same-origin.
 */

import { useEffect, useRef, useState } from "react";

export type ConsoleLogLevel = "debug" | "info" | "warn" | "error";

export interface ConsoleLogLine {
  ts: string;
  level: ConsoleLogLevel;
  scope: string;
  msg: string;
}

export type StreamStatus = "connected" | "connecting" | "error";

const MAX_LINES = 1000;
const STREAM_URL = "/console/api/console-logs/stream";

export interface ConsoleLogStream {
  lines: ConsoleLogLine[];
  status: StreamStatus;
  attempts: number;
}

export function useConsoleLogStream(): ConsoleLogStream {
  const [lines, setLines] = useState<ConsoleLogLine[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [attempts, setAttempts] = useState(0);
  const attemptsRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let source: EventSource | null = null;

    const connect = () => {
      if (disposed) return;
      setStatus(attemptsRef.current === 0 ? "connecting" : "error");
      const es = new EventSource(STREAM_URL, { withCredentials: true });
      source = es;

      es.addEventListener("init", (event) => {
        const data = JSON.parse((event as MessageEvent).data as string) as { lines: ConsoleLogLine[] };
        setLines(data.lines.slice(-MAX_LINES));
        setStatus("connected");
        attemptsRef.current = 0;
        setAttempts(0);
      });
      es.addEventListener("line", (event) => {
        const line = JSON.parse((event as MessageEvent).data as string) as ConsoleLogLine;
        setLines((prev) => (prev.length >= MAX_LINES ? [...prev.slice(prev.length - MAX_LINES + 1), line] : [...prev, line]));
      });
      es.addEventListener("clear", () => setLines([]));

      es.onerror = () => {
        es.close();
        if (disposed) return;
        setStatus("error");
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 30_000);
        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
    };
  }, []);

  return { lines, status, attempts };
}

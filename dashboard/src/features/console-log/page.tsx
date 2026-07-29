/**
 * Console Log page — live SSE stream with colored levels, auto-scroll
 * (paused when the user scrolls up), 1000-line cap and server-side clear (REQ-6).
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Trash2, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Select } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { useConsoleLogStream, type ConsoleLogLevel } from "../../lib/hooks/use-console-log-stream";

const LEVEL_COLORS: Record<ConsoleLogLevel, string> = {
  debug: "text-[var(--text-3)]",
  info: "text-[#0fa3d1] dark:text-[var(--teal)]",
  warn: "text-[var(--orange)]",
  error: "text-[var(--red)]",
};

const LEVELS: (ConsoleLogLevel | "all")[] = ["all", "debug", "info", "warn", "error"];

export function ConsoleLogPage() {
  const { lines, status, attempts } = useConsoleLogStream();
  const [filter, setFilter] = useState<ConsoleLogLevel | "all">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = filter === "all" ? lines : lines.filter((line) => line.level === filter);

  // Auto-scroll to bottom unless the user scrolled up.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const clearLogs = async () => {
    try {
      await api<{ ok: boolean }>("/console-logs", { method: "DELETE", body: "{}" });
      setClearOpen(false);
      toast.success("Console logs cleared");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "failed to clear logs");
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">Console Log</h1>
          {status === "connected" ? (
            <Badge tone="ok">
              <Wifi size={11} className="mr-1" /> live
            </Badge>
          ) : status === "connecting" ? (
            <Badge tone="info">connecting…</Badge>
          ) : (
            <Badge tone="err">
              <WifiOff size={11} className="mr-1" /> reconnecting ({attempts})
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            ariaLabel="Filter level"
            value={filter}
            onChange={(value) => setFilter(value as ConsoleLogLevel | "all")}
            options={LEVELS.map((level) => ({ value: level, label: level === "all" ? "All levels" : level }))}
          />
          {!autoScroll && (
            <Button variant="secondary" size="sm" onClick={() => setAutoScroll(true)}>
              <ArrowDown size={13} /> Follow
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
            <Trash2 size={13} /> Clear
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <div ref={scrollRef} onScroll={onScroll} className="max-h-[calc(100vh-220px)] overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed">
          {visible.length === 0 ? (
            <p className="py-10 text-center font-sans text-sm text-[var(--text-3)]">No log lines{filter !== "all" ? ` at level "${filter}"` : ""}.</p>
          ) : (
            visible.map((line, index) => (
              <div key={`${line.ts}-${index}`} className="flex gap-2 whitespace-pre-wrap break-all py-0.5 hover:bg-[var(--hover)]">
                <span className="shrink-0 text-[var(--text-3)]">{formatTime(line.ts)}</span>
                <span className={`w-12 shrink-0 font-semibold uppercase ${LEVEL_COLORS[line.level]}`}>{line.level}</span>
                <span className="shrink-0 text-[var(--text-3)]">[{line.scope}]</span>
                <span className="text-[var(--text-1)]">{line.msg}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => void clearLogs()}
        title="Clear Console Logs"
        message="Clear the in-memory log ring (500 lines)? New lines keep streaming afterwards."
        danger
        confirmLabel="Clear"
      />
    </div>
  );
}

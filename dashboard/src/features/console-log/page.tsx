/**
 * Console Log page — live SSE stream with colored levels, auto-scroll
 * (paused when the user scrolls up), 1000-line cap and server-side clear (REQ-6).
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Trash2, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiDelete } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Select } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { useConsoleLogStream, type ConsoleLogLevel } from "../../hooks/use-console-log-stream";

const LEVEL_COLORS: Record<ConsoleLogLevel, string> = {
  debug: "text-[var(--text-3)]",
  info: "text-[#0fa3d1] dark:text-[var(--teal)]",
  warn: "text-[var(--orange)]",
  error: "text-[var(--red)]",
};

const LEVELS: (ConsoleLogLevel | "all")[] = ["all", "debug", "info", "warn", "error"];

const ConsoleLogRow = memo(function ConsoleLogRow({ line }: { line: { ts: string; level: ConsoleLogLevel; msg: string } }) {
  return (
    <div
      className="flex flex-col gap-0.5 whitespace-pre-wrap break-all py-1 hover:bg-[var(--hover)] sm:flex-row sm:gap-2 sm:py-0.5"
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 24px" }}
    >
      <span className="shrink-0 text-[var(--text-3)]">{formatTime(line.ts)}</span>
      <span className={LEVEL_COLORS[line.level]}>{line.msg}</span>
    </div>
  );
});

export function ConsoleLogPage() {
  const { lines, status, attempts } = useConsoleLogStream();
  const [filter, setFilter] = useState<ConsoleLogLevel | "all">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filter === "all" ? lines : lines.filter((line) => line.level === filter), [filter, lines]);

  // Auto-scroll to bottom unless the user scrolled up.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [visible.length, filter, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const clearLogs = async () => {
    try {
      await apiDelete<{ ok: boolean }>("/console-logs");
      setClearOpen(false);
      toast.success("Console logs cleared");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "failed to clear logs");
    }
  };

  return (
    <div className="flex h-[calc(100dvh-180px)] min-h-0 flex-col gap-3 overflow-hidden sm:h-[calc(100dvh-196px)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h1 className="text-lg font-bold tracking-tight">Console Log</h1>
          {status === "connected" ? (
            <Badge tone="ok">
              <Wifi size={11} className="mr-1" /> live
            </Badge>
          ) : status === "connecting" ? (
            <Badge tone="info">connecting...</Badge>
          ) : (
            <Badge tone="err">
              <WifiOff size={11} className="mr-1" /> reconnecting ({attempts})
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            ariaLabel="Filter level"
            value={filter}
            onChange={(value) => setFilter(value as ConsoleLogLevel | "all")}
            options={LEVELS.map((level) => ({ value: level, label: level === "all" ? "All levels" : level }))}
          />
          <Button variant="secondary" size="sm" onClick={() => setAutoScroll(true)} disabled={autoScroll} title={autoScroll ? "Following the latest log line" : "Resume following the latest log line"}>
            <ArrowDown size={13} /> {autoScroll ? "Following" : "Follow"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
            <Trash2 size={13} /> Clear
          </Button>
        </div>
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden p-0">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain p-3 font-mono text-[11.5px] leading-relaxed">
          {visible.length === 0 ? (
            <p className="py-10 text-center font-sans text-sm text-[var(--text-3)]">No log lines{filter !== "all" ? ` at level "${filter}"` : ""}.</p>
          ) : (
            visible.map((line, index) => <ConsoleLogRow key={`${line.ts}-${index}`} line={line} />)
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


import { Show, createSignal, type JSX } from "solid-js";
import { cn } from "../../lib/cn";
import { consoleStreamUrl } from "../../lib/console-api";
import { LogStream } from "../../components/shared/LogStream";
import { LogHistory } from "../../components/shared/LogHistory";
import { LogFilter, type LogLevel } from "../../components/shared/LogFilter";
import type { LogLevel as StreamLogLevel } from "../../components/shared/log-types";

type Tab = "live" | "history";

const STREAM_URL = consoleStreamUrl("/logs/stream");

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "live", label: "Live stream" },
  { value: "history", label: "History" },
];

export default function ConsoleLog(): JSX.Element {
  const [tab, setTab] = createSignal<Tab>("live");
  const [level, setLevel] = createSignal<LogLevel>("all");
  const [source, setSource] = createSignal<string>("");

  // The filter exposes an explicit "all" option while both log readers use
  // minimum-level semantics — "debug" is the floor that admits every entry.
  const streamLevel = (): StreamLogLevel => {
    const current = level();
    return current === "all" ? "debug" : current;
  };

  return (
    <div class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-2xl font-bold text-[var(--text-1)]">Console Log</h2>
        <LogFilter level={level()} onLevelChange={setLevel} source={source()} onSourceChange={setSource} />
      </div>

      <div
        role="tablist"
        aria-label="Console log view"
        class="flex w-fit items-center gap-1 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-muted)] p-1"
      >
        {TABS.map((entry) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab() === entry.value}
            onClick={() => setTab(entry.value)}
            class={cn(
              "animate-fade-in rounded-full px-3.5 py-1.5 text-[11.5px] font-semibold transition-colors duration-150",
              tab() === entry.value
                ? "bg-[var(--active-pill)] text-[var(--text-1)]"
                : "text-[var(--text-3)] hover:text-[var(--text-2)]",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <Show when={tab() === "live"} fallback={<LogHistory level={streamLevel()} source={source()} />}>
        <LogStream url={STREAM_URL} level={streamLevel()} source={source()} bufferSize={1000} autoScroll />
      </Show>
    </div>
  );
}

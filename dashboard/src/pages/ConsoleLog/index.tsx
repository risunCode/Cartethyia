
import { createSignal, type JSX } from "solid-js";
import { TerminalSquare } from "lucide-solid";
import { LogHistory } from "../../components/shared/LogHistory";
import { LogFilter, type LogLevel } from "../../components/shared/LogFilter";

export default function ConsoleLog(): JSX.Element {
  const [level, setLevel] = createSignal<LogLevel>("all");
  const [source, setSource] = createSignal<string>("");
  const historyLevel = (): Exclude<LogLevel, "all"> => {
    const current = level();
    return current === "all" ? "debug" : current;
  };

  return (
    <div class="space-y-4">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex items-center gap-2.5">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <TerminalSquare size={17} aria-hidden="true" />
          </span>
          <div>
            <h2 class="text-xl font-bold text-[var(--text-1)]">Console Log</h2>
            <p class="text-[11px] text-[var(--text-3)]">Historical daemon events</p>
          </div>
        </div>
        <LogFilter
          className="w-full lg:w-auto"
          level={level()}
          onLevelChange={setLevel}
          source={source()}
          onSourceChange={setSource}
        />
      </div>
      <LogHistory level={historyLevel()} source={source()} />
    </div>
  );
}

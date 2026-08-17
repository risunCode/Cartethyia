
import { createSignal, type JSX } from "solid-js";
import { TerminalSquare, Radio } from "lucide-solid";
import { LogHistory } from "@components/shared/LogHistory";
import { LogStream } from "@components/shared/LogStream";
import { LogFilter, type LogLevel } from "@components/shared/LogFilter";
import { Card, CardHeader } from "@components/ui/card";
import { consoleStreamUrl } from "@lib/console-api";

export default function ConsoleLog(): JSX.Element {
  const [level, setLevel] = createSignal<LogLevel>("all");
  const [source, setSource] = createSignal<string>("");
  const historyLevel = (): Exclude<LogLevel, "all"> => {
    const current = level();
    return current === "all" ? "debug" : current;
  };
  const streamUrl = (): string => consoleStreamUrl("/logs/stream");

  return (
    <div class="dashboard-page space-y-4">
      <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="flex items-center gap-2.5">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <TerminalSquare size={17} aria-hidden="true" />
          </span>
          <div>
            <h2 class="text-xl font-bold text-[var(--text-1)]">Console Log</h2>
            <p class="mt-0.5 text-[11px] text-[var(--text-2)]">Historical daemon events and live SSE tail</p>
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
      <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LogHistory level={historyLevel()} source={source()} />
        <Card density="compact" class="max-h-[600px] overflow-y-auto">
          <CardHeader title="Live stream" icon={Radio} iconColor="var(--accent)" sub="SSE event source — click provider or URL-level details" />
          <LogStream
            url={streamUrl()}
            level={historyLevel()}
            source={source()}
            bufferSize={200}
            autoScroll
          />
        </Card>
      </div>
    </div>
  );
}

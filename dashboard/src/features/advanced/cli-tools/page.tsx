/** CLI Tools page — responsive grid of tool cards linking to detail subpages. */

import { Link } from "react-router-dom";
import { CheckCircle2, XCircle, ArrowRight, Terminal } from "lucide-react";
import { cn } from "../../../lib/cn";
import { Card } from "../../../components/ui/card";
import { StatePanel } from "../../../components/ui/state";
import { useToolRegistry, useToolStatuses } from "./api";
import { ToolIcon } from "./tool-icon";

export function CliToolsPage() {
  const registryQuery = useToolRegistry();
  const statusesQuery = useToolStatuses();

  if (registryQuery.isLoading) {
    return (
      <div className="dashboard-page space-y-4">
        <StatePanel kind="loading" title="Loading CLI tools" description="Reading the tool registry…" />
      </div>
    );
  }

  if (registryQuery.isError || !registryQuery.data) {
    return (
      <div className="dashboard-page space-y-4">
        <StatePanel kind="error" title="Failed to load" description="Could not load the CLI tools registry." icon={Terminal} />
      </div>
    );
  }

  const tools = registryQuery.data;
  const statuses = statusesQuery.data ?? {};
  const fileTools = tools.filter((t) => t.configType !== "guide");
  const guideTools = tools.filter((t) => t.configType === "guide");
  const configuredCount = fileTools.filter((t) => statuses[t.id]?.configured).length;

  return (
    <div className="dashboard-page space-y-4">
      {/* Header */}
      <Card>
        <div className="flex items-start gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]"><Terminal size={15} /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-tight">CLI Tools</h2>
            <p className="text-[11.5px] text-[var(--text-2)]">
              Inject or download config for CLI coding agents. {configuredCount}/{fileTools.length} configured.
            </p>
          </div>
        </div>
      </Card>

      {/* File-injected tools — responsive grid */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
          Auto-Inject ({fileTools.length})
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {fileTools.map((def) => {
            const st = statuses[def.id];
            return (
              <Link
                key={def.id}
                to={`/advanced/cli-tools/${def.id}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-[var(--radius-card)] border p-2.5 transition-colors hover:border-[var(--accent)]/50",
                  st?.configured ? "border-[var(--accent)]/40" : "border-[var(--inner-border)]",
                  "bg-[var(--hover)]",
                )}
              >
                <ToolIcon toolId={def.id} name={def.name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[12px] font-semibold text-[var(--text-1)]">{def.name}</p>
                    {st?.installed ? (
                      <CheckCircle2 size={11} className="shrink-0 text-[var(--accent)]" />
                    ) : (
                      <XCircle size={11} className="shrink-0 text-[var(--text-3)]" />
                    )}
                  </div>
                  <p className="truncate text-[10px] text-[var(--text-3)]">
                    {st?.configured ? "Configured" : st?.installed ? "Installed" : "Not installed"}
                  </p>
                </div>
                <ArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />
              </Link>
            );
          })}
        </div>
      </div>

      {/* Guide-only tools */}
      <div>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--text-3)]">
          Manual Setup ({guideTools.length})
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {guideTools.map((def) => (
            <Link
              key={def.id}
              to={`/advanced/cli-tools/${def.id}`}
              className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-[var(--inner-border)] bg-[var(--hover)] p-2.5 transition-colors hover:border-[var(--accent)]/50"
            >
              <ToolIcon toolId={def.id} name={def.name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-[var(--text-1)]">{def.name}</p>
                <p className="truncate text-[10px] text-[var(--text-3)]">Guide</p>
              </div>
              <ArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

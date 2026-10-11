import { Activity, Check, Copy, Database, Globe, MemoryStick } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Stack } from "../../components/ui/stack";
import { ApiKeysPanel } from "../../components/ApiKeysPanel";
import { CompressionPanel } from "../../components/CompressionPanel";
import { useSystemHealth } from "../../hooks/system";

import { useTrackedTimeout } from "../../hooks/use-timeout";
import { formatBytes } from "../../lib/format/numbers";
import { getErrorMessage } from "../../data/api";


function ApiEndpointCard() {
  const [copied, setCopied] = useState(false);
  const schedule = useTrackedTimeout();
  const endpoint = `${window.location.origin}/v1`;
  const copy = () => {
    void navigator.clipboard.writeText(endpoint);
    setCopied(true);
    schedule(() => setCopied(false), 2000);
  };
  return (
    <Card>
      <CardHeader
        title="Gateway Endpoint"
        subtitle="Universal OpenAI & Anthropic Wire API Endpoint Compatible"
        icon={<Globe size={16} />}
        action={
          <Button variant="secondary" size="sm" onClick={copy} icon={copied ? <Check size={13} /> : <Copy size={13} />}>
            {copied ? "Copied" : "Copy"}
          </Button>
        }
      />
      <CardBody>
        <Stack gap="10px">
          <div className="nested-panel flex items-center justify-between rounded-control border border-inner-border bg-code-surface px-7 py-5 font-mono text-body font-semibold tabular-nums">
            <code>{endpoint}</code>
            <span className="text-badge font-normal text-text-tertiary">PORT 12800</span>
          </div>
          <p className="text-caption leading-normal text-text-secondary">
            Point any SDK, CLI, or agent (e.g. Claude Code, OpenCode, Pi, OMP, Kilo, Cline, Droid and more clients) to this same-origin base URL.
          </p>
        </Stack>
      </CardBody>
    </Card>
  );
}

function MemoryBar({ label, value, percent, color }: { readonly label: string; readonly value: string; readonly percent: number; readonly color: string }) {
  return (
    <div className="nested-panel min-w-0 rounded-control bg-surface-3 px-4.5 py-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-3 text-micro font-bold uppercase tracking-wider text-text-tertiary">
        <span>{label}</span><span className="font-mono text-badge normal-case tracking-normal" style={{ color }}>{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/25">
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, percent))}%`, background: color }} />
      </div>
    </div>
  );
}

function SystemHealthCard(): ReactNode {
  const query = useSystemHealth();
  const health = query.data;
  const total = Math.max(health?.memory_bytes ?? 1, 1);
  const runtime = health ? Math.max(0, health.memory_bytes - health.memory_heap_bytes - health.memory_external_bytes) : 0;
  return (
    <Card>
      <CardHeader title="System Health" subtitle="Memory, process, and coordination" icon={<Activity size={16} />} />
      <CardBody>
        {query.isPending ? <LoadingState label="Loading system health…" /> : null}
        {query.isError ? <ErrorState message={getErrorMessage(query.error, "Failed to load system health")} onRetry={() => void query.refetch()} /> : null}
        {health ? (
          <div className="grid grid-cols-1 gap-4 min-medium:grid-cols-2">
            <section className="nested-panel rounded-card border border-inner-border bg-surface-2 p-4.5">
              <div className="flex items-center gap-3.5">
                <span className="grid size-11 place-items-center rounded-inset bg-purple text-white"><MemoryStick size={12} /></span>
                <div><div className="text-caption font-bold leading-none">RAM & Memory</div><div className="mt-1 text-micro text-text-tertiary">Process + database</div></div>
              </div>
              <div className="mt-3 font-mono text-display font-bold leading-none tabular-nums">{formatBytes(health.memory_bytes).replace(" ", "")} <span className="text-micro text-text-tertiary">RSS</span></div>
              <p className="mt-1 text-micro leading-[1.35] text-text-secondary">{health.database_in_process ? "Cartethyia process memory. The embedded database is inside this number, so it is not the gateway alone." : "Cartethyia process memory. The database runs in another process."}</p>
              <div className="mt-4 grid grid-cols-3 gap-2.5">
                <MemoryBar label="JS heap" value={formatBytes(health.memory_heap_bytes)} percent={(health.memory_heap_bytes / total) * 100} color="var(--purple)" />
                <MemoryBar label="Bun runtime" value={formatBytes(runtime)} percent={(runtime / total) * 100} color="var(--green)" />
                <MemoryBar label="Buffers" value={formatBytes(health.memory_external_bytes)} percent={(health.memory_external_bytes / total) * 100} color="var(--status-info)" />
              </div>
            </section>

            <section className="nested-panel rounded-card border border-inner-border bg-surface-2 p-4.5">
              <div className="flex items-center gap-3.5">
                <span className="grid size-11 place-items-center rounded-inset bg-status-info text-white"><Database size={12} /></span>
                <div><div className="text-caption font-bold leading-none">Coordination</div><div className="mt-1 text-micro text-text-tertiary">Database and Redis</div></div>
              </div>
              <div className="mt-3 font-mono text-display font-bold leading-none tabular-nums">{health.database_healthy && (!health.redis_configured || health.redis_healthy) ? "Ready" : "Degraded"}</div>
              <p className="mt-1 text-micro text-text-secondary">{health.database_in_process ? "Database shares this process." : "Database runs separately."}</p>
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                <div className="nested-panel flex items-center gap-3.5 rounded-inset bg-surface-3 px-3.5 py-2.5 text-micro"><Database size={13} className="shrink-0 text-teal" /><span><b className="block text-caption">{health.database_healthy ? "Healthy" : "Down"}</b><span className="text-text-tertiary">{health.database_in_process ? "Inside memory" : "Separate"}</span></span></div>
                <div className="nested-panel flex items-center gap-3.5 rounded-inset bg-surface-3 px-3.5 py-2.5 text-micro"><Activity size={13} className="shrink-0 text-orange" /><span><b className="block text-caption">{health.redis_configured ? "Redis" : "Memory"}</b><span className="text-text-tertiary">{health.redis_configured ? (health.redis_healthy ? "Healthy" : "Down") : "No Redis"}</span></span></div>
              </div>
            </section>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default function Overview(): ReactNode {
  return (
    <Stack gap="16px">
      <ApiEndpointCard />
      <SystemHealthCard />
      <CompressionPanel />
      <ApiKeysPanel />
    </Stack>
  );
}

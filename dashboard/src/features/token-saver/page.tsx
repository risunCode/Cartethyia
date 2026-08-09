import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Zap } from "lucide-react";
import { apiGet, apiPost } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { toast } from "../../lib/toast";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";

type Quality = "lite" | "balanced" | "extreme";
interface SettingsResponse { settings: { runtime: { tokenSaverEnabled: boolean; tokenSaverQuality: Quality; headroomEnabled: boolean; headroomUrl: string | null; headroomTimeoutMs: number; ponytailEnabled: boolean } } }
const QUALITY: Array<{ value: Quality; label: string; description: string; saving: string }> = [
  { value: "lite", label: "Lite", description: "Gentle truncation. Keeps more context and is safest for debugging.", saving: "Lower savings" },
  { value: "balanced", label: "Balanced", description: "Recommended RTK profile for everyday coding requests.", saving: "Recommended" },
  { value: "extreme", label: "Extreme", description: "Aggressive compression for high-volume sessions; older tool output is shortened more.", saving: "Highest savings" },
];

/** Configures the RTK-inspired Token Saver compression pipeline. */
export function TokenSaverPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: qk.settings.all, queryFn: () => apiGet<SettingsResponse>("/settings") });
  const mutation = useMutation({
    mutationFn: (patch: Partial<{ tokenSaverEnabled: boolean; tokenSaverQuality: Quality; headroomEnabled: boolean; headroomTimeoutMs: number; ponytailEnabled: boolean }>) => apiPost("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update Token Saver"),
  });
  const settings = query.data?.settings.runtime;
  const enabled = settings?.tokenSaverEnabled ?? false;
  const quality = settings?.tokenSaverQuality ?? "balanced";
  const headroomEnabled = settings?.headroomEnabled ?? false;
  const ponytailEnabled = settings?.ponytailEnabled ?? false;
  return (
    <div className="dashboard-page space-y-4">
      <Card>
        <CardHeader title="Token Saver" icon={Zap} iconColor="#ff9f0a" sub="Choose the compression strategy for older context and tool output" />
        <div className="divide-y divide-[var(--inner-border)]">
          <section className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div><div className="flex items-center gap-2 text-sm font-semibold">RTK <Badge tone={enabled ? "ok" : "default"}>{enabled ? "Active" : "Disabled"}</Badge></div><p className="mt-1 text-[11px] text-[var(--text-3)]">Local smart filtering and truncation for older textual tool results. Recent turns remain untouched.</p></div>
              <Switch checked={enabled} onChange={(value) => mutation.mutate({ tokenSaverEnabled: value })} disabled={!settings || mutation.isPending} label="Enable RTK Token Saver" />
            </div>
            <div className="grid gap-2.5 md:grid-cols-3">
              {QUALITY.map((item) => (
                <Button key={item.value} variant="ghost" className={`h-auto items-start justify-start rounded-[14px] border p-3 text-left ${quality === item.value ? "border-[#ff9f0a] bg-[rgba(255,159,10,0.1)]" : "border-[var(--inner-border)] bg-[var(--hover)]"}`} onClick={() => mutation.mutate({ tokenSaverQuality: item.value })} disabled={!settings || mutation.isPending}>
                  <span><span className="flex items-center gap-2 text-sm font-semibold">{item.label} {quality === item.value && <Badge tone="accent">Active</Badge>}</span><span className="mt-1 block text-[11px] font-normal leading-relaxed text-[var(--text-3)]">{item.description}</span><span className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-[#ff9f0a]">{item.saving}</span></span>
                </Button>
              ))}
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3 text-[11px] text-[var(--text-3)]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#30d158]" /><span>RTK never modifies recent turns, user messages, images, or tool-call arguments. It only bounds older textual tool results.</span></div>
          </section>
          <section className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div><div className="flex items-center gap-2 text-sm font-semibold">Ponytail <Badge tone={ponytailEnabled ? "ok" : "default"}>{ponytailEnabled ? "Active" : "Disabled"}</Badge></div><p className="mt-1 text-[11px] text-[var(--text-3)]">Minimal-solution guidance for Model Studio only. Public API traffic is never modified.</p></div>
              <Switch checked={ponytailEnabled} onChange={(value) => mutation.mutate({ ponytailEnabled: value })} disabled={!settings || mutation.isPending} label="Enable Ponytail mode" />
            </div>
          </section>
          <section className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-4">
              <div><div className="flex items-center gap-2 text-sm font-semibold">Headroom <Badge tone={headroomEnabled ? "ok" : "default"}>{headroomEnabled ? "Auto" : "Disabled"}</Badge></div><p className="mt-1 text-[11px] text-[var(--text-3)]">Uses the configured Headroom service automatically. No local URL is required here; failures leave the original request untouched.</p></div>
              <Switch checked={headroomEnabled} onChange={(value) => mutation.mutate({ headroomEnabled: value })} disabled={!settings || mutation.isPending} label="Enable Headroom" />
            </div>
            <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
              <label className="text-xs font-semibold text-[var(--text-2)]">Timeout (ms)<Input type="number" min={250} max={10000} step={250} value={String(settings?.headroomTimeoutMs ?? 3000)} onChange={(event) => mutation.mutate({ headroomTimeoutMs: Number(event.target.value) || 3000 })} disabled={!settings || mutation.isPending} /></label>
            </div>
          </section>
        </div>
      </Card>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, ShieldCheck, Zap } from "lucide-react";
import { apiGet, apiPost } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";

type Quality = "lite" | "balanced" | "extreme";
interface SettingsResponse { settings: { runtime: { tokenSaverEnabled: boolean; tokenSaverQuality: Quality } } }

const QUALITY: Array<{ value: Quality; label: string; description: string; saving: string }> = [
  { value: "lite", label: "Lite", description: "Gentle truncation. Keeps more context and is safest for debugging.", saving: "Lower savings" },
  { value: "balanced", label: "Balanced", description: "Recommended RTK profile for everyday coding requests.", saving: "Recommended" },
  { value: "extreme", label: "Extreme", description: "Aggressive compression for high-volume sessions; older tool output is shortened more.", saving: "Highest savings" },
];

/** Configures the RTK-inspired Token Saver compression pipeline. */
export function TokenSaverPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: () => apiGet<SettingsResponse>("/settings") });
  const mutation = useMutation({
    mutationFn: (patch: Partial<{ tokenSaverEnabled: boolean; tokenSaverQuality: Quality }>) => apiPost("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update Token Saver"),
  });
  const settings = query.data?.settings.runtime;
  const enabled = settings?.tokenSaverEnabled ?? false;
  const quality = settings?.tokenSaverQuality ?? "balanced";
  return (
    <div className="dashboard-page space-y-4">
      <Card>
        <CardHeader title="Token Saver" icon={Zap} iconColor="#ff9f0a" sub="RTK-inspired compression for older tool output" />
        <div className="flex items-center justify-between gap-4 rounded-[14px] border border-[var(--inner-border)] bg-[var(--hover)] p-3.5">
          <div><div className="text-sm font-semibold">Enable Token Saver</div><p className="mt-1 text-[11px] text-[var(--text-3)]">Compresses older tool results before they reach the provider. Recent turns remain untouched.</p></div>
          <Switch checked={enabled} onChange={(value) => mutation.mutate({ tokenSaverEnabled: value })} disabled={!settings || mutation.isPending} label="Enable Token Saver" />
        </div>
      </Card>
      <Card>
        <CardHeader title="Compression quality" icon={Gauge} sub="Choose the balance between context fidelity and token savings" />
        <div className="grid gap-2.5 md:grid-cols-3">
          {QUALITY.map((item) => (
            <Button key={item.value} variant="ghost" className={`h-auto items-start justify-start rounded-[14px] border p-3 text-left ${quality === item.value ? "border-[#ff9f0a] bg-[rgba(255,159,10,0.1)]" : "border-[var(--inner-border)] bg-[var(--hover)]"}`} onClick={() => mutation.mutate({ tokenSaverQuality: item.value })} disabled={!settings || mutation.isPending}>
              <span><span className="flex items-center gap-2 text-sm font-semibold">{item.label} {quality === item.value && <Badge tone="accent">Active</Badge>}</span><span className="mt-1 block text-[11px] font-normal leading-relaxed text-[var(--text-3)]">{item.description}</span><span className="mt-2 block text-[10px] font-semibold uppercase tracking-wide text-[#ff9f0a]">{item.saving}</span></span>
            </Button>
          ))}
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3 text-[11px] text-[var(--text-3)]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#30d158]" /><span>Token Saver never modifies recent turns, user messages, images, or tool-call arguments. It only bounds older textual tool results.</span></div>
      </Card>
    </div>
  );
}

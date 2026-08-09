/**
 * Filter Rules — pre-request content sanitizer patterns.
 * DB-backed CRUD: add, edit, toggle, delete filter rules.
 * Based on etteum-pool's filter system (pudidil template).
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Filter, Plus, Trash2, Power, PowerOff, Pencil, X } from "lucide-react";
import { Card, CardHeader } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../lib/api";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { cn } from "../../lib/cn";

interface FilterRule {
  id: number;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
}

interface FilterListResponse {
  count: number;
  activeCount: number;
  rules: FilterRule[];
}

interface SettingsResponse {
  settings: { runtime: { filterRulesEnabled: boolean } };
}

interface RuleFormState {
  id: number | null;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
}

const EMPTY_FORM: RuleFormState = { id: null, pattern: "", replacement: "", isRegex: true, isActive: true };


/** Human-readable label from the ruleId — "remove_claude_code_identity" → "Remove Claude Code Identity" */
function ruleLabel(ruleId: string): string {
  return ruleId
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function FilterSanitizePage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RuleFormState | null>(null);

  const settingsQuery = useQuery({ queryKey: qk.settings.all, queryFn: () => apiGet<SettingsResponse>("/settings") });
  const rulesQuery = useQuery({ queryKey: qk.filterRules.all, queryFn: () => apiGet<FilterListResponse>("/filters") });

  const settingsMutation = useMutation({
    mutationFn: (patch: Partial<{ filterRulesEnabled: boolean }>) => apiPost("/settings", patch),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.settings.all }); toast.success("Filter master toggle updated"); },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to update master toggle")),
  });

  const createMutation = useMutation({
    mutationFn: (data: { pattern: string; replacement: string; isRegex: boolean; isActive: boolean }) => apiPost("/filters", data),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.filterRules.all }); setForm(null); toast.success("Filter rule created"); },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to create rule")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<{ pattern: string; replacement: string; isRegex: boolean; isActive: boolean }> }) =>
      apiPatch(`/filters/${id}`, data),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.filterRules.all }); setForm(null); toast.success("Filter rule updated"); },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to update rule")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiDelete(`/filters/${id}`),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: qk.filterRules.all }); toast.success("Rule deleted"); },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to delete rule")),
  });

  const masterEnabled = settingsQuery.data?.settings.runtime.filterRulesEnabled ?? false;
  const rules = rulesQuery.data?.rules ?? [];
  const loading = !rulesQuery.data || createMutation.isPending || updateMutation.isPending || settingsMutation.isPending;

  const handleToggle = (rule: FilterRule) => {
    updateMutation.mutate({ id: rule.id, data: { isActive: !rule.isActive } });
  };

  const handleDelete = (rule: FilterRule) => {
    if (!confirm(`Delete rule "${ruleLabel(rule.ruleId)}"?`)) return;
    deleteMutation.mutate(rule.id);
  };

  const handleSave = () => {
    if (!form) return;
    if (!form.pattern.trim()) { toast.error("Pattern is required"); return; }
    if (form.id === null) {
      createMutation.mutate({ pattern: form.pattern, replacement: form.replacement, isRegex: form.isRegex, isActive: form.isActive });
    } else {
      updateMutation.mutate({ id: form.id, data: { pattern: form.pattern, replacement: form.replacement, isRegex: form.isRegex, isActive: form.isActive } });
    }
  };

  return (
    <div className="dashboard-page space-y-3">
      {/* Master toggle */}
      <Card>
        <CardHeader title="Filter Rules" sub="Strip patterns that trigger upstream content moderation before requests are sent" icon={Filter} />
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold">Master toggle</p>
            <p className="text-[11px] text-[var(--text-3)]">When ON, all active filter rules are applied to outbound request text. Default: OFF.</p>
          </div>
          <Switch
            checked={masterEnabled}
            onChange={(v) => settingsMutation.mutate({ filterRulesEnabled: v })}
            disabled={!settingsQuery.data || settingsMutation.isPending}
            label="Master toggle"
          />
        </div>
      </Card>

      {/* Rule list */}
      <Card>
        <CardHeader title="Rules" icon={Filter}>
          <Button size="sm" variant="ghost" onClick={() => setForm({ ...EMPTY_FORM })}>
            <Plus size={14} className="mr-1" />
            Add Rule
          </Button>
        </CardHeader>
        {rulesQuery.isLoading ? (
          <div className="p-3 text-[12px] text-[var(--text-3)]">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="p-3 text-[12px] text-[var(--text-3)]">No rules configured. Click "Add Rule" to create one.</div>
        ) : (
          <div className="space-y-1.5 p-2">
            {rules.map((rule) => {
              const editing = form?.id === rule.id;
              return (
                <div key={rule.id} className={cn("rounded-lg border px-3 py-2.5", rule.isActive && masterEnabled ? "border-[var(--accent)]/30 bg-[var(--accent-soft)]" : "border-[var(--inner-border)] bg-[var(--hover)]")}>
                  {editing ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-semibold">{ruleLabel(rule.ruleId)}</span>
                        <button type="button" onClick={() => setForm(null)} className="text-[var(--text-3)] hover:text-[var(--text-1)]" aria-label="Close inline editor"><X size={16} /></button>
                      </div>
                      <label className="block text-[11px] font-semibold text-[var(--text-3)]">Pattern<textarea className="mt-1 h-16 w-full resize-none rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] p-2.5 font-mono text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--accent)]" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} /></label>
                      <label className="block text-[11px] font-semibold text-[var(--text-3)]">Replacement<textarea className="mt-1 h-14 w-full resize-none rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] p-2.5 font-mono text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--accent)]" placeholder="(empty to remove matched text)" value={form.replacement} onChange={(e) => setForm({ ...form, replacement: e.target.value })} /></label>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-4">
                          <label className="flex cursor-pointer items-center gap-2 text-[12px]"><Switch checked={form.isRegex} onChange={(v) => setForm({ ...form, isRegex: v })} label="Regex" /><span>Regex</span></label>
                          <label className="flex cursor-pointer items-center gap-2 text-[12px]"><Switch checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" /><span>Active</span></label>
                        </div>
                        <div className="flex gap-2"><Button size="sm" onClick={handleSave} disabled={loading}>Save</Button><Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button></div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="w-6 shrink-0 text-[10px] text-[var(--text-3)]">#{rule.sortOrder}</span>
                          <span className="text-[12px] font-semibold text-[var(--text-1)]" title={rule.ruleId}>{ruleLabel(rule.ruleId)}</span>
                          <Badge tone={rule.isRegex ? "info" : "default"}>{rule.isRegex ? "regex" : "string"}</Badge>
                        </div>
                        <div className="mt-1 break-all font-mono text-[10px] text-[var(--text-2)]"><span className="font-sans text-[var(--text-3)]">pattern:</span> {rule.pattern}</div>
                        <div className="mt-0.5 break-all font-mono text-[10px] text-[var(--text-2)]"><span className="font-sans text-[var(--text-3)]">replacement:</span> {rule.replacement || "(remove match)"}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button type="button" onClick={() => handleToggle(rule)} className={cn("rounded-md p-1.5 transition-colors", rule.isActive ? "text-[var(--text-3)] hover:text-[#ff5f56]" : "text-[var(--text-3)] hover:text-[#27c93f]")} title={rule.isActive ? "Disable" : "Enable"}>{rule.isActive ? <PowerOff size={13} /> : <Power size={13} />}</button>
                        <button type="button" onClick={() => setForm({ id: rule.id, pattern: rule.pattern, replacement: rule.replacement, isRegex: rule.isRegex, isActive: rule.isActive })} className="rounded-md p-1.5 text-[var(--text-3)] transition-colors hover:text-[var(--accent)]" title="Edit"><Pencil size={13} /></button>
                        <button type="button" onClick={() => handleDelete(rule)} className="rounded-md p-1.5 text-[var(--text-3)] transition-colors hover:text-[#ff5f56]" title="Delete"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {form?.id === null && (
        <Card>
          <CardHeader title={form.id === null ? "New Rule" : `Edit: ${ruleLabel(rules.find((r) => r.id === form.id)?.ruleId ?? "")}`} icon={Filter}>
            <button type="button" onClick={() => setForm(null)} className="text-[var(--text-3)] hover:text-[var(--text-1)]" aria-label="Close form">
              <X size={16} />
            </button>
          </CardHeader>
          <div className="space-y-3 p-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-[var(--text-3)]">Pattern</label>
              <textarea
                className="h-20 w-full resize-none rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] p-2.5 font-mono text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--accent)]"
                placeholder={form.isRegex ? "regex pattern (case-insensitive)" : "exact string to match"}
                value={form.pattern}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-[var(--text-3)]">Replacement</label>
              <textarea
                className="h-16 w-full resize-none rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] p-2.5 font-mono text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--accent)]"
                placeholder="(empty to remove matched text)"
                value={form.replacement}
                onChange={(e) => setForm({ ...form, replacement: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <Switch checked={form.isRegex} onChange={(v) => setForm({ ...form, isRegex: v })} label="Regex" />
                <span>Regex</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <Switch checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
                <span>Active</span>
              </label>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={loading}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

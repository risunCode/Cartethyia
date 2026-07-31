/** Filter Rules page — pattern-based outbound-text sanitizer CRUD (REQ-9). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiGet, apiPost, apiDelete } from "../../lib/api";
import { staggerClass } from "../../lib/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";

interface RuleRecord {
  id: number;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
  builtin: boolean;
}

interface SettingsResponse {
  settings: { filterRulesEnabled: boolean };
}

export function FilterRulesPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["console", "filter.sanitize"], queryFn: () => apiGet<{ items: RuleRecord[] }>("/filter.sanitize") });
  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: () => apiGet<SettingsResponse>("/settings") });
  const filterRulesEnabled = settingsData?.settings.filterRulesEnabled ?? false;
  const globalToggleMut = useMutation({
    mutationFn: (enabled: boolean) => apiPost("/settings", { filterRulesEnabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [ruleId, setRuleId] = useState("");
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RuleRecord | null>(null);

  const resetForm = () => { setRuleId(""); setPattern(""); setReplacement(""); setIsRegex(false); };

  const invalidate = () => qc.invalidateQueries({ queryKey: ["console", "filter.sanitize"] });

  const createMut = useMutation({
    mutationFn: () => apiPost("/filter.sanitize", { ruleId: ruleId.trim(), pattern, replacement, isRegex }),
    onSuccess: () => { invalidate(); setCreateOpen(false); resetForm(); toast.success("Filter rule created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleMut = useMutation({
    mutationFn: (rule: RuleRecord) => apiPost(`/filter.sanitize/${rule.id}`, { isActive: !rule.isActive }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiDelete<{ ok: boolean }>(`/filter.sanitize/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast.success("Filter rule deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-1)]">Filter Rules</h2>
          <p className="mt-1 text-xs text-[var(--text-2)]">
            Built-in rules ship with Cartethyia and run from code. Disable or override them here; custom rules are stored in the database.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--inner-border)] px-3 py-1.5">
            <span className="text-xs font-medium text-[var(--text-2)]">All rules</span>
            <Switch checked={filterRulesEnabled} onChange={(v) => globalToggleMut.mutate(v)} label="Enable all filter rules" />
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New Rule
          </Button>
        </div>
      </div>
      {!filterRulesEnabled && (
        <p className="mt-2 text-xs text-[var(--text-3)]">
          Filter Rules are globally disabled - outbound requests are not sanitized, regardless of each rule's own toggle below.
        </p>
      )}

      {isLoading ? (
        <p className="py-8 text-center text-sm text-[var(--text-3)]">Loading…</p>
      ) : isError ? (
        <div className="space-y-3 py-8 text-center">
          <p className="text-sm text-[var(--text-2)]">Failed to load filter rules.</p>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>Retry</Button>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {items.map((rule, i) => (
            <div
              key={rule.id}
              {...staggerClass(i)}
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-2.5"
            >
              <div className="min-w-0 flex-1 overflow-hidden">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-[var(--text-1)]">{rule.ruleId}</span>
                  {rule.builtin && <Badge tone="default">built-in</Badge>}
                  <Badge tone={rule.isRegex ? "accent" : "default"}>{rule.isRegex ? "regex" : "literal"}</Badge>
                  {!rule.isActive && <Badge tone="default">disabled</Badge>}
                </div>
                <code className="mt-1 block truncate text-xs text-[var(--text-3)]">{rule.pattern}</code>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={rule.isActive} onChange={() => toggleMut.mutate(rule)} label={`Toggle ${rule.ruleId}`} />
                {!rule.builtin && (
                  <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(rule)}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Filter Rule"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button disabled={!ruleId.trim() || !pattern.trim()} onClick={() => createMut.mutate()}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="rule-id">Rule ID</Label>
            <Input id="rule-id" placeholder="e.g. my-custom-rule" value={ruleId} onChange={(e) => setRuleId(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rule-pattern">Pattern {isRegex ? "(regular expression)" : "(literal text)"}</Label>
            <Input id="rule-pattern" placeholder={isRegex ? "e.g. powered by (Claude|Anthropic)" : "e.g. Claude Code"} value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rule-replacement">Replacement (blank strips the match)</Label>
            <Input id="rule-replacement" placeholder="" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-[var(--inner-border)] px-3 py-2">
            <span className="text-sm text-[var(--text-2)]">Treat pattern as regex</span>
            <Switch checked={isRegex} onChange={setIsRegex} label="Treat pattern as regex" />
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title="Delete filter rule?"
        message={`Remove custom rule "${deleteTarget?.ruleId}"? Outbound requests will stop being sanitized against this pattern.`}
        confirmLabel="Delete"
        danger
      />
    </Card>
  );
}

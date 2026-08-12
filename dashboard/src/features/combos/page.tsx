/** Combos page — alias CRUD and combo builder. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy, Pencil, Plus, Route, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "../../lib/toast";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Tabs } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { ModelPickerField, ModelTargetPicker } from "../../components/model-picker";

// ── Types ─────────────────────────────────────────────────────────────────

interface AliasRecord { alias: string; model: string; createdAt: string }
interface ComboRecord { id: string; name: string; models: string[]; strategy: "fallback" | "round-robin"; stickyLimit: number }

function RoutingActionButton({ icon: Icon, label, onClick, danger = false }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={onClick}
      className={`h-8 gap-1.5 px-2 text-[11px] ${danger ? "text-[var(--red)] hover:text-[var(--red)]" : "text-[var(--text-2)]"}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

async function copyRoutingName(value: string, label: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Clipboard unavailable on this origin");
  }
}

// ── Aliases sub-section ───────────────────────────────────────────────────
function AliasesTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: qk.aliases.all, queryFn: () => apiGet<{ items: AliasRecord[] }>("/aliases") });
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AliasRecord | null>(null);
  const [alias, setAlias] = useState("");
  const [model, setModel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const resetForm = () => {
    setEditTarget(null);
    setAlias("");
    setModel("");
  };

  const createMut = useMutation({
    mutationFn: () => apiPost("/aliases", { alias: alias.trim(), model: model.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.aliases.all });
      setCreateOpen(false);
      resetForm();
      toast.success(editTarget ? "Alias updated" : "Alias created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (a: string) => apiDelete<{ ok: boolean }>(`/aliases/${encodeURIComponent(a)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.aliases.all }); setDeleteTarget(null); toast.success("Alias deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[var(--text-2)]">Map readable names to model targets (e.g. <code>claude-mythos-5</code> → <code>claude-opus-5</code>).</p>
        <div className="flex w-full sm:w-auto">
          <Button className="w-full justify-center sm:w-auto" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> New Alias</Button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="flex min-h-[220px] flex-1 items-center justify-center text-center">
          <p className="text-sm text-[var(--text-3)]">No aliases defined yet.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {items.map((a) => (
            <div key={a.alias} className="flex items-center gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-2.5">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                <code className="shrink-0 break-words rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">{a.alias}</code>
                <ArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />
                <code className="min-w-0 flex-1 break-words whitespace-normal text-xs text-[var(--text-2)]">{a.model}</code>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <RoutingActionButton icon={Copy} label="Copy" onClick={() => void copyRoutingName(a.alias, "Alias")} />
                <RoutingActionButton
                  icon={Pencil}
                  label="Edit"
                  onClick={() => {
                    setEditTarget(a);
                    setAlias(a.alias);
                    setModel(a.model);
                    setCreateOpen(true);
                  }}
                />
                <RoutingActionButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(a.alias)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={createOpen} onClose={() => { setCreateOpen(false); resetForm(); }} title={editTarget ? "Edit Alias" : "New Alias"}
        footer={<><Button variant="secondary" onClick={() => { setCreateOpen(false); resetForm(); }}>Cancel</Button><Button disabled={!alias.trim() || !model.trim()} onClick={() => createMut.mutate()}>{editTarget ? "Save" : "Create"}</Button></>}>
        <div className="space-y-3">
          <div><Label htmlFor="alias-name">Alias name</Label><Input id="alias-name" placeholder="e.g. fast" value={alias} onChange={(e) => setAlias(e.target.value)} disabled={!!editTarget} /></div>
          <div><Label htmlFor="alias-model">Target model (qualified or combo name)</Label><ModelTargetPicker value={model} onChange={setModel} placeholder="e.g. claude-opus-5" /></div>
        </div>
      </Dialog>
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget)} title="Delete alias?" message={`Remove alias "${deleteTarget}"? Requests using this alias will need their full model name.`} confirmLabel="Delete" danger />
    </div>
  );
}

// ── Combos sub-section ────────────────────────────────────────────────────

function CombosTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: qk.combos.all, queryFn: () => apiGet<{ items: ComboRecord[] }>("/combos") });
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ComboRecord | null>(null);
  const [name, setName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [stickyLimit, setStickyLimit] = useState("0");
  const [deleteTarget, setDeleteTarget] = useState<ComboRecord | null>(null);

  const resetForm = () => { setName(""); setModels([]); setStickyLimit("0"); setEditTarget(null); };
  const createMut = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), models, stickyLimit: Math.max(0, Number(stickyLimit) || 0) };
      return editTarget
        ? apiPatch(`/combos/${editTarget.id}`, body)
        : apiPost("/combos", { ...body, strategy: "fallback" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.combos.all }); setCreateOpen(false); resetForm(); toast.success(editTarget ? "Combo updated" : "Combo created"); },
    onError: (e: Error) => toast.error(e.message),
  });


  const strategyMut = useMutation({
    mutationFn: ({ id, strategy }: { id: string; strategy: ComboRecord["strategy"] }) => apiPatch(`/combos/${id}`, { strategy }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.combos.all });
      toast.success("Strategy updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/combos/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.combos.all });
      setDeleteTarget(null);
      toast.success("Combo deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openEdit = (c: ComboRecord) => {
    setEditTarget(c); setName(c.name); setModels(c.models); setStickyLimit(String(c.stickyLimit)); setCreateOpen(true);
  };

  const items = data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[var(--text-2)]">Combine multiple models with fallback or round-robin strategy.</p>
        <div className="flex w-full sm:w-auto">
          <Button className="w-full justify-center sm:w-auto" size="sm" onClick={() => { resetForm(); setCreateOpen(true); }}><Plus size={14} /> New Combo</Button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="flex min-h-[220px] flex-1 items-center justify-center text-center">
          <p className="text-sm text-[var(--text-3)]">No combos defined yet.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {items.map((c) => (
            <div key={c.id} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-bold">{c.name}</span>
                  {c.stickyLimit > 0 && <Badge>sticky:{c.stickyLimit}</Badge>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 sm:shrink-0 sm:justify-end">
                  <select
                    aria-label={`Strategy for ${c.name}`}
                    value={c.strategy}
                    disabled={strategyMut.isPending}
                    onChange={(event) => strategyMut.mutate({ id: c.id, strategy: event.target.value as ComboRecord["strategy"] })}
                    className="h-9 max-w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-2)] px-3 text-xs font-semibold text-[var(--text-1)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="fallback">Fallback — try in order</option>
                    <option value="round-robin">Round Robin — rotate</option>
                  </select>
                  <div className="flex items-center gap-1">
                    <RoutingActionButton icon={Copy} label="Copy" onClick={() => void copyRoutingName(c.name, "Combo")} />
                    <RoutingActionButton icon={Pencil} label="Edit" onClick={() => openEdit(c)} />
                    <RoutingActionButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(c)} />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.models.map((m) => <code key={m} className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10.5px] text-[var(--accent)]">{m}</code>)}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={createOpen} onClose={() => { setCreateOpen(false); resetForm(); }} title={editTarget ? "Edit Combo" : "New Combo"} wide
        footer={<><Button variant="secondary" onClick={() => { setCreateOpen(false); resetForm(); }}>Cancel</Button><Button disabled={!name.trim() || models.length < 2} onClick={() => createMut.mutate()}>{editTarget ? "Save" : "Create"}</Button></>}>
        <div className="space-y-3">
          <div><Label htmlFor="combo-name">Name</Label><Input id="combo-name" placeholder="e.g. fast-combo" value={name} onChange={(e) => setName(e.target.value)} disabled={!!editTarget} /></div>
          <ModelPickerField label="Models (at least 2, qualified prefix/model)" values={models} onChange={setModels} mode="models" manualPlaceholder="e.g. kimchi/kimi-k2.7" />
          <div>
            <Label htmlFor="combo-sticky">Sticky limit</Label>
            <Input id="combo-sticky" type="number" min={0} value={stickyLimit} onChange={(e) => setStickyLimit(e.target.value)} className="w-24" />
          </div>
        </div>
      </Dialog>
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)} title="Delete combo?" message={`Remove combo "${deleteTarget?.name}"? Any aliases pointing to it will no longer resolve.`} confirmLabel="Delete" danger />
    </div>
  );
}




// ── Main page ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "aliases", label: "Aliases" },
  { id: "combos", label: "Combos" },
];

export function CombosPage() {
  const [tab, setTab] = useState("aliases");
  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-4">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader title="Model Routing Rules" icon={Route} sub="Aliases and combos determine how model names resolve to providers." />
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div className="mt-4 min-h-0 flex-1 flex flex-col">
          {tab === "aliases" && <AliasesTab />}
          {tab === "combos" && <CombosTab />}
        </div>
      </Card>
    </div>
  );
}

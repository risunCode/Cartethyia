/** Combos page — alias CRUD, combo builder, resolve preview (REQ-13). */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pencil, Plus, Route, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "../../lib/toast";
import { apiGet, apiPost, apiPatch, apiDelete } from "../../lib/api";
import { staggerClass } from "../../lib/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { IconButton } from "../../components/ui/icon";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label } from "../../components/ui/input";
import { Tabs } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { ModelPickerField, ModelTargetPicker } from "../../components/model-picker";

// ── Types ─────────────────────────────────────────────────────────────────

interface AliasRecord { alias: string; model: string; createdAt: string }
interface ComboRecord { id: string; name: string; models: string[]; strategy: "fallback" | "round-robin"; stickyLimit: number }
interface ResolveResult { ok: boolean; trace: string[]; resolved: unknown }

// ── Aliases sub-section ───────────────────────────────────────────────────

function AliasesTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["console", "aliases"], queryFn: () => apiGet<{ items: AliasRecord[] }>("/aliases") });
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
      qc.invalidateQueries({ queryKey: ["console", "aliases"] });
      setCreateOpen(false);
      resetForm();
      toast.success(editTarget ? "Alias updated" : "Alias created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (a: string) => apiDelete<{ ok: boolean }>(`/aliases/${encodeURIComponent(a)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["console", "aliases"] }); setDeleteTarget(null); toast.success("Alias deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = data?.items ?? [];

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[var(--text-2)]">Map readable names to model targets (e.g. <code>claude-mythos-5</code> → <code>claude-opus-5</code>).</p>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> New Alias</Button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-3)]">No aliases defined yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {items.map((a, i) => (
            <div key={a.alias} {...staggerClass(i)} className="flex items-center justify-between rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <code className="max-w-[40%] truncate rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-xs font-semibold text-[var(--accent)]">{a.alias}</code>
                <ArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />
                <code className="min-w-0 truncate text-xs text-[var(--text-2)]">{a.model}</code>
              </div>
              <div className="flex gap-1">
                <IconButton
                  icon={Pencil}
                  label={`Edit alias ${a.alias}`}
                  onClick={() => {
                    setEditTarget(a);
                    setAlias(a.alias);
                    setModel(a.model);
                    setCreateOpen(true);
                  }}
                />
                <IconButton icon={Trash2} label={`Delete alias ${a.alias}`} onClick={() => setDeleteTarget(a.alias)} />
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
    </>
  );
}

// ── Combos sub-section ────────────────────────────────────────────────────

function CombosTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["console", "combos"], queryFn: () => apiGet<{ items: ComboRecord[] }>("/combos") });
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ComboRecord | null>(null);
  const [name, setName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<"fallback" | "round-robin">("fallback");
  const [stickyLimit, setStickyLimit] = useState("0");
  const [deleteTarget, setDeleteTarget] = useState<ComboRecord | null>(null);

  const resetForm = () => { setName(""); setModels([]); setStrategy("fallback"); setStickyLimit("0"); setEditTarget(null); };

  const createMut = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), models, strategy, stickyLimit: Math.max(0, Number(stickyLimit) || 0) };
      return editTarget ? apiPatch(`/combos/${editTarget.id}`, body) : apiPost("/combos", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["console", "combos"] }); setCreateOpen(false); resetForm(); toast.success(editTarget ? "Combo updated" : "Combo created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/combos/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["console", "combos"] });
      setDeleteTarget(null);
      toast.success("Combo deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openEdit = (c: ComboRecord) => {
    setEditTarget(c); setName(c.name); setModels(c.models); setStrategy(c.strategy); setStickyLimit(String(c.stickyLimit)); setCreateOpen(true);
  };

  const items = data?.items ?? [];

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[var(--text-2)]">Combine multiple models with fallback or round-robin strategy.</p>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => { resetForm(); setCreateOpen(true); }}><Plus size={14} /> New Combo</Button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-3)]">No combos defined yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {items.map((c, i) => (
            <div key={c.id} {...staggerClass(i)} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-bold">{c.name}</span>
                  <Badge tone={c.strategy === "fallback" ? "info" : "accent"}>{c.strategy}</Badge>
                  {c.stickyLimit > 0 && <Badge>sticky:{c.stickyLimit}</Badge>}
                </div>
                <div className="flex gap-1">
                  <IconButton icon={Pencil} label={`Edit combo ${c.name}`} onClick={() => openEdit(c)} />
                  <IconButton icon={Trash2} label={`Delete combo ${c.name}`} onClick={() => setDeleteTarget(c)} />
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
          <div className="flex gap-4">
            <div><Label htmlFor="combo-strategy">Strategy</Label>
              <select id="combo-strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as "fallback" | "round-robin")} className="h-8 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-xs font-medium text-[var(--text-1)]"><option value="fallback">Fallback</option><option value="round-robin">Round-robin</option></select>
            </div>
            <div><Label htmlFor="combo-sticky">Sticky limit</Label><Input id="combo-sticky" type="number" min={0} value={stickyLimit} onChange={(e) => setStickyLimit(e.target.value)} className="w-24" /></div>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)} title="Delete combo?" message={`Remove combo "${deleteTarget?.name}"? Any aliases pointing to it will no longer resolve.`} confirmLabel="Delete" danger />
    </>
  );
}



// ── Resolve preview ───────────────────────────────────────────────────────

function ResolvePreview() {
  const [model, setModel] = useState("");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!model.trim()) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await apiPost<ResolveResult>("/resolve-preview", { model: model.trim() });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolution failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Resolve Preview" icon={Search} sub="Test how a model name resolves through the chain: prefix → alias → combo → filter." />
      <div className="flex gap-2">
        <Input placeholder="e.g. fast, kimchi/kimi-k2.7, my-combo" value={model} onChange={(e) => setModel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
        <Button onClick={run} disabled={busy || !model.trim()}><Search size={14} />{busy ? "Resolving…" : "Resolve"}</Button>
      </div>
      {error && <div className="mt-3 rounded-lg bg-[var(--red-soft)] p-3 text-xs text-[var(--red)]">{error}</div>}
      {result && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <Badge tone={result.ok ? "ok" : "err"}>{result.ok ? "resolved" : "blocked"}</Badge>
          </div>
          {result.trace && (
            <div className="rounded-lg bg-[var(--hover)] p-3 text-[11px] leading-relaxed text-[var(--text-2)]">
              {result.trace.map((line, i) => <div key={i} className="flex gap-1.5"><ArrowRight size={10} className="mt-0.5 shrink-0 text-[var(--text-3)]" /><span className="break-all">{line}</span></div>)}
            </div>
          )}
        </div>
      )}
    </Card>
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
    <div className="dashboard-page space-y-4">
      <ResolvePreview />
      <Card>
        <CardHeader title="Model Routing Rules" icon={Route} sub="Aliases and combos determine how model names resolve to providers." />
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <div className="mt-4">
          {tab === "aliases" && <AliasesTab />}
          {tab === "combos" && <CombosTab />}
        </div>
      </Card>
    </div>
  );
}

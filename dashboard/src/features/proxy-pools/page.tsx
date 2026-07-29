/** Proxy pools — CRUD, checklist batch ops, platform toggle, inline test results. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CheckCircle2, ExternalLink, FileUp, Globe, Info, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, apiGet, apiPost } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { staggerItem } from "../../lib/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input, Label, Textarea } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/shared";

// ── Types ─────────────────────────────────────────────────────────────────

type PoolPlatform = "custom" | "cloudflare" | "vercel";

interface ProxyEntry { url: string; scheme: "http" | "https" | "socks5" }
interface PoolRecord {
  id: string; name: string; entries: ProxyEntry[]; noProxy: string;
  strictProxy: boolean; platform: PoolPlatform; createdAt: string; updatedAt: string;
}
interface EntryTestResult { url: string; ok: boolean; latencyMs: number; error?: string }



// ── Pool form dialog ──────────────────────────────────────────────────────

function PoolFormDialog({ open, onClose, editTarget }: { open: boolean; onClose: () => void; editTarget: PoolRecord | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState(editTarget?.name ?? "");
  const [entriesText, setEntriesText] = useState(editTarget?.entries.map((e) => e.url).join("\n") ?? "");
  const [noProxy, setNoProxy] = useState(editTarget?.noProxy ?? "");
  const [strictProxy, setStrictProxy] = useState(editTarget?.strictProxy ?? false);
  const [isRelay, setIsRelay] = useState(editTarget?.platform === "vercel" || editTarget?.platform === "cloudflare");

  const entries = entriesText.split("\n").map((l) => l.trim()).filter(Boolean);

  const mut = useMutation({
    mutationFn: () => apiPost(editTarget ? `/proxy-pools/${editTarget.id}` : "/proxy-pools", {
      name: name.trim(), entries: entries.map((url) => ({ url, scheme: new URL(url).protocol.replace(":", "") })),
      noProxy: noProxy.trim(), strictProxy, platform: isRelay ? "vercel" : "custom",
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["console", "proxy-pools"] }); onClose(); toast.success(editTarget ? "Pool updated" : "Pool created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onClose={onClose} title={editTarget ? "Edit Proxy Pool" : "New Proxy Pool"} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || entries.length === 0 || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Saving…" : editTarget ? "Save" : "Create"}</Button></>}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="pool-name">Name</Label>
          <Input id="pool-name" placeholder="e.g. us-proxies" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setIsRelay(!isRelay)} className={`flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isRelay ? "bg-[var(--accent)]" : "bg-[var(--inner-border)]"}`}>
            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${isRelay ? "translate-x-4" : "translate-x-0.5"}`} />
          </button>
          <span className="text-xs text-[var(--text-2)]">Vercel / Cloudflare relay</span>
        </div>
        <div>
          <Label htmlFor="pool-entries">Entries (one proxy URL per line)</Label>
          <Textarea id="pool-entries" placeholder={"http://proxy1.example.com:8080\nhttps://proxy2.example.com:443\nsocks5://proxy3.example.com:1080"} value={entriesText} onChange={(e) => setEntriesText(e.target.value)} rows={5} />
        </div>
        <div>
          <Label htmlFor="pool-noproxy">No-proxy bypass list (comma-separated)</Label>
          <Input id="pool-noproxy" placeholder="localhost,127.0.0.1,.internal" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setStrictProxy(!strictProxy)} className={`flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${strictProxy ? "bg-[var(--accent)]" : "bg-[var(--inner-border)]"}`}>
            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${strictProxy ? "translate-x-4" : "translate-x-0.5"}`} />
          </button>
          <span className="text-xs text-[var(--text-2)]">Reject requests when proxy is unreachable</span>
        </div>
      </div>
    </Dialog>
  );
}

// ── Import dialog ─────────────────────────────────────────────────────────

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ added: ProxyEntry[]; skipped: Array<{ line: number; reason: string }> } | null>(null);

  const mut = useMutation({
    mutationFn: () => apiPost<{ added: ProxyEntry[]; skipped: Array<{ line: number; reason: string }> }>("/proxy-pools/import", { text }),
    onSuccess: (data) => { setResult(data); qc.invalidateQueries({ queryKey: ["console", "proxy-pools"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onClose={() => { onClose(); setText(""); setResult(null); }} title="Import Proxies" wide
      footer={<>{!result ? (<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!text.trim() || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Importing…" : "Import"}</Button></>) : (<Button onClick={onClose}>Done</Button>)}</>}>
      {!result ? (
        <div>
          <Label htmlFor="import-text">Paste one proxy URL per line</Label>
          <Textarea id="import-text" placeholder={"http://proxy1.example.com:8080\nhttps://proxy2.example.com:443"} value={text} onChange={(e) => setText(e.target.value)} rows={8} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2"><CheckCircle2 size={16} className="text-[var(--green)]" /><span className="text-sm font-semibold">{result.added.length} proxy entries added</span></div>
          {result.skipped.length > 0 && (
            <div className="rounded-lg bg-[rgba(255,159,10,0.1)] p-3 text-xs text-[var(--orange)]">
              <div className="mb-1 font-semibold">{result.skipped.length} lines skipped:</div>
              {result.skipped.map((s) => <div key={s.line}>Line {s.line}: {s.reason}</div>)}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function ProxyPoolsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["console", "proxy-pools"], queryFn: () => apiGet<{ items: PoolRecord[] }>("/proxy-pools") });
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PoolRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PoolRecord | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastTest, setLastTest] = useState<Record<string, { at: string; ok: number; fail: number }>>({});

  const items = data?.items ?? [];

  const deleteMut = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/proxy-pools/${id}`, { method: "DELETE", body: "{}" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["console", "proxy-pools"] }); setDeleteTarget(null); toast.success("Pool deleted"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const batchDeleteMut = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api<{ ok: boolean }>(`/proxy-pools/${id}`, { method: "DELETE", body: "{}" }).catch(() => {}))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["console", "proxy-pools"] }); setSelected(new Set()); toast.success("Selected pools deleted"); },
  });

  const testMut = useMutation({
    mutationFn: async (id: string) => {
      setTestingId(id);
      const res = await apiPost<{ items: EntryTestResult[] }>(`/proxy-pools/${id}/test`);
      return { id, items: res.items };
    },
    onSuccess: ({ id, items: results }) => {
      setTestingId(null);
      const ok = results.filter((r) => r.ok).length;
      setLastTest((prev) => ({ ...prev, [id]: { at: new Date().toISOString(), ok, fail: results.length - ok } }));
      const toastMsg = ok === results.length ? `All ${ok} entries OK` : `${ok}/${results.length} OK`;
      ok === results.length ? toast.success(toastMsg) : toast.error(toastMsg);
    },
    onError: (e: Error) => { toast.error(e.message); setTestingId(null); },
  });

  const batchTestMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const results: Array<{ id: string; items: EntryTestResult[] }> = [];
      for (const id of ids) {
        try {
          const res = await apiPost<{ items: EntryTestResult[] }>(`/proxy-pools/${id}/test`);
          results.push({ id, items: res.items });
        } catch { results.push({ id, items: [] }); }
      }
      return results;
    },
    onSuccess: (results) => {
      const now = new Date().toISOString();
      const updates: Record<string, { at: string; ok: number; fail: number }> = {};
      for (const { id, items: r } of results) {
        const ok = r.filter((i) => i.ok).length;
        updates[id] = { at: now, ok, fail: r.length - ok };
      }
      setLastTest((prev) => ({ ...prev, ...updates }));
      const totalOk = Object.values(updates).reduce((s, v) => s + v.ok, 0);
      const totalFail = Object.values(updates).reduce((s, v) => s + v.fail, 0);
      toast.success(`Batch test: ${totalOk} OK, ${totalFail} failed`);
    },
    onError: () => toast.error("Batch test failed"),
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = items.length > 0 && items.every((p) => selected.has(p.id));

  return (
    <div className="space-y-4">
      {/* Deploy checklist — always visible at the top */}
      <Card className="border-dashed">
        <div className="flex items-start gap-3 text-xs text-[var(--text-3)]">
          <Info size={16} className="mt-0.5 shrink-0 text-[var(--teal)]" />
          <div>
            <div className="mb-1 font-semibold text-[var(--text-2)]">Deploy checklist (manual)</div>
            <ul className="ml-3 list-disc space-y-0.5">
              <li><strong>Cloudflare Workers/Pages:</strong> set proxy URLs in <code>wrangler.toml</code> vars</li>
              <li><strong>Vercel:</strong> set <code>HTTPS_PROXY</code> / <code>ALL_PROXY</code> in project env vars</li>
              <li><strong>Docker:</strong> pass <code>--env HTTPS_PROXY=...</code> at container start</li>
              <li><strong>Direct/Bare metal:</strong> export <code>HTTPS_PROXY</code> in the service environment</li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Pool list */}
      <Card>
        <CardHeader title="Proxy Pools" icon={Globe} sub={`${items.length} pool${items.length === 1 ? "" : "s"} configured`}>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}><FileUp size={14} /> Import</Button>
            <Button size="sm" onClick={() => { setEditTarget(null); setFormOpen(true); }}><Plus size={14} /> New Pool</Button>
          </div>
        </CardHeader>

        {/* Batch actions bar */}
        {selected.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-xl bg-[var(--accent-soft)] px-3.5 py-2.5">
            <span className="text-[11.5px] font-semibold text-[var(--accent)]">{selected.size} selected</span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button variant="secondary" size="sm" disabled={batchTestMut.isPending} onClick={() => batchTestMut.mutate([...selected])}>
                {batchTestMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />} Test
              </Button>
              <Button variant="ghost" size="sm" className="text-[#ff453a]" onClick={() => { if (selected.size === items.length) batchDeleteMut.mutate([...selected]); else setDeleteTarget(items.find((p) => selected.has(p.id)) ?? null); }}>
                <Trash2 size={13} /> Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="py-10 text-center text-sm text-[var(--text-3)]">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm text-[var(--text-3)]">No proxy pools configured yet.</div>
        ) : (
          <div className="space-y-2.5">
            {/* Select all header */}
            <div className="flex items-center gap-2 px-1 text-[10.5px] text-[var(--text-3)]">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((p) => p.id)))} />
              <span>Select all</span>
            </div>

            {items.map((pool, i) => (
              <motion.div key={pool.id} {...staggerItem(i)} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3.5">
                <div className="flex items-start gap-3">
                  <input type="checkbox" className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]" checked={selected.has(pool.id)} onChange={() => toggleSelect(pool.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold">{pool.name}</span>
                      <Badge>{pool.entries.length} {pool.entries.length === 1 ? "entry" : "entries"}</Badge>
                      {pool.platform !== "custom" && <Badge tone="info">{pool.platform}</Badge>}
                      {pool.strictProxy && <Badge tone="warn">strict</Badge>}
                      {lastTest[pool.id] && (
                        <span className="text-[10px] text-[var(--text-3)]">
                          last test: {formatTime(lastTest[pool.id]!.at)} · <span className="text-[var(--green)]">{lastTest[pool.id]!.ok} OK</span>
                          {lastTest[pool.id]!.fail > 0 && <span className="text-[var(--red)]"> · {lastTest[pool.id]!.fail} fail</span>}
                        </span>
                      )}
                    </div>

                    {/* Full URLs */}
                    <div className="mt-2 space-y-1">
                      {pool.entries.map((e) => (
                        <div key={e.url} className="flex items-center gap-2 text-[11px]">
                          <Globe size={11} className="shrink-0 text-[var(--text-3)]" />
                          <code className="break-all text-[var(--text-2)]">{e.url}</code>
                        </div>
                      ))}
                    </div>

                    {pool.noProxy && <div className="mt-1 text-[10px] text-[var(--text-3)]">no-proxy: {pool.noProxy}</div>}
                  </div>

                  <div className="flex shrink-0 gap-1">
                    <Button variant="secondary" size="sm" disabled={testingId === pool.id} onClick={() => testMut.mutate(pool.id)}>
                      {testingId === pool.id ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
                      {testingId === pool.id ? "Testing…" : "Test"}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => { setEditTarget(pool); setFormOpen(true); }}><Pencil size={13} /></Button>
                    <Button variant="ghost" size="icon" className="text-[#ff453a]" onClick={() => setDeleteTarget(pool)}><Trash2 size={13} /></Button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </Card>

      {formOpen && <PoolFormDialog open={formOpen} onClose={() => { setFormOpen(false); setEditTarget(null); }} editTarget={editTarget} />}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)} title="Delete proxy pool?" message={`Remove pool "${deleteTarget?.name}"? Providers using this pool will fall back to direct connections.`} confirmLabel="Delete" danger />
    </div>
  );
}

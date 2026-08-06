/**
 * Database Map page — password-gated unified DB browser.
 *
 * Layout (single column, no tabs):
 *   ┌──────────────────────────────────────────┐
 *   │ [Config DB] [Runtime DB]      ⏱ 09:58    │
 *   ├──────────────────────────────────────────┤
 *   │  ┌─ Tree Map (scrollable, ~60% height) ─┐ │
 *   │  │ ▼ access_rules  (0 rows)            │ │
 *   │  │   columns…  data preview…           │ │
 *   │  │ ▶ api_keys  (1 row)                 │ │
 *   │  └─────────────────────────────────────┘ │
 *   ├──────────────────────────────────────────┤
 *   │  ┌─ SQL Console (fixed bottom) ────────┐ │
 *   │  │ [SELECT][EXEC]  textarea  [Run]      │ │
 *   │  │ result table…                        │ │
 *   │  └─────────────────────────────────────┘ │
 *   └──────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from "react";
import { Lock, Database, Download, Upload, AlertTriangle } from "lucide-react";
import { toast } from "../../../lib/toast";
import { apiPost, ApiError } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { Button } from "../../../components/ui/button";
import { Input, Label } from "../../../components/ui/input";
import { Dialog } from "../../../components/ui/dialog";
import { useSchema, useExportDb, useImportDb } from "./api";
import type { DbTarget } from "./types";
import { TreeMap } from "./tree-map";
import { SqlConsole } from "./sql-console";

const DB_MAP_AUTH_KEY = "cartethyia:db-map-auth";
const DB_MAP_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isAuthed(): boolean {
  const raw = sessionStorage.getItem(DB_MAP_AUTH_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > DB_MAP_AUTH_TTL_MS) {
    sessionStorage.removeItem(DB_MAP_AUTH_KEY);
    return false;
  }
  return true;
}

function AuthGate({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/login", { password });
      sessionStorage.setItem(DB_MAP_AUTH_KEY, String(Date.now()));
      toast.success("Database Map access granted for 10 minutes");
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={true} onClose={onClose} title="Database Map Access">
      <form onSubmit={submit} className="space-y-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <Lock size={18} />
          </span>
          <div>
            <h2 className="text-sm font-bold">Re-authenticate</h2>
            <p className="text-xs text-[var(--text-2)]">Enter your password to unlock Database Map for 10 minutes.</p>
          </div>
        </div>
        <div>
          <Label htmlFor="db-map-password">Password</Label>
          <Input id="db-map-password" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password…" className="mt-1" />
        </div>
        {error && <p role="alert" className="text-xs font-medium text-[var(--red)]">{error}</p>}
        <div className="flex items-center justify-end gap-2 [button:last-child]:bg-[var(--accent)] [button:last-child]:text-white">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !password}>{busy ? "Verifying…" : "Unlock"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function DbSelector({ db, onChange }: { readonly db: DbTarget; readonly onChange: (db: DbTarget) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-1)] p-0.5">
      {(["config", "runtime"] as const).map((target) => (
        <button
          key={target}
          type="button"
          onClick={() => onChange(target)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            db === target ? "bg-[var(--accent)] text-white" : "text-[var(--text-3)] hover:text-[var(--text-2)]",
          )}
        >
          <Database size={11} />
          {target === "config" ? "Config DB" : "Runtime DB"}
        </button>
      ))}
    </div>
  );
}

export function DatabaseMapPage() {
  const [authed, setAuthed] = useState(() => isAuthed());
  const [showGate, setShowGate] = useState(false);
  const [db, setDb] = useState<DbTarget>("config");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const schemaQuery = useSchema(db);
  const exportMut = useExportDb();
  const importMut = useImportDb();
  const fileRef = useRef<HTMLInputElement>(null);

  const dbName = db === "config" ? "cartethyia.sqlite" : "runtime.sqlite";

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPendingFile(file);
    e.target.value = "";
  };

  const confirmImport = async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    setPendingFile(null);
    await importMut.mutateAsync({ db, file });
  };

  // Countdown timer for auth expiry
  useEffect(() => {
    if (!authed) return;
    const updateRemaining = () => {
      const raw = sessionStorage.getItem(DB_MAP_AUTH_KEY);
      if (!raw || Date.now() - Number(raw) > DB_MAP_AUTH_TTL_MS) {
        setAuthed(false);
        setSecondsLeft(0);
        sessionStorage.removeItem(DB_MAP_AUTH_KEY);
        toast.error("Database Map access expired. Re-authenticate to continue.");
      } else {
        setSecondsLeft(Math.max(0, Math.ceil((DB_MAP_AUTH_TTL_MS - (Date.now() - Number(raw))) / 1000)));
      }
    };
    updateRemaining();
    const id = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(id);
  }, [authed]);

  if (!authed) {
    return (
      <div className="dashboard-page flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden">
        <Lock size={40} className="text-[var(--text-3)]/40" aria-hidden="true" />
        <p className="text-sm font-semibold text-[var(--text-3)]">Database Map is locked.</p>
        <p className="text-[10.5px] text-[var(--text-3)]/60">Re-authenticate to access schema, data, and SQL tools.</p>
        <Button type="button" size="sm" onClick={() => setShowGate(true)}>Unlock Database Map</Button>
        {showGate && <AuthGate onSuccess={() => { setAuthed(true); setShowGate(false); }} onClose={() => setShowGate(false)} />}
      </div>
    );
  }

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;

  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2">
        <DbSelector db={db} onChange={setDb} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => exportMut.mutate(db)}
            disabled={exportMut.isPending}
            title={`Export ${dbName}`}
            className="flex items-center gap-1 rounded-md border border-[var(--inner-border)] px-2 py-1 text-[10px] font-medium text-[var(--text-3)] hover:bg-[var(--surface-1)] disabled:opacity-50"
          >
            <Download size={11} />
            Export
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={importMut.isPending}
            title={`Import ${dbName}`}
            className="flex items-center gap-1 rounded-md border border-[var(--inner-border)] px-2 py-1 text-[10px] font-medium text-[var(--text-3)] hover:bg-[var(--surface-1)] disabled:opacity-50"
          >
            <Upload size={11} />
            Import
          </button>
          <input ref={fileRef} type="file" accept=".sqlite,.db,application/x-sqlite3,application/octet-stream" onChange={onFileChange} className="hidden" />
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
          <Lock size={11} className="text-[var(--status-warning)]" />
          <span>{String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}</span>
          <span className="text-[var(--text-3)]/50">remaining</span>
        </div>
      </div>

      {/* Tree Map — top section, scrollable */}
      <div className="min-h-0 flex-[3] overflow-hidden sm:flex-[5]">
        {schemaQuery.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--surface-2)] border-t-[var(--accent)]" />
          </div>
        ) : schemaQuery.isError || !schemaQuery.data ? (
          <div className="flex h-full items-center justify-center text-[var(--red)]">
            <p className="text-xs">{schemaQuery.error instanceof Error ? schemaQuery.error.message : "Failed to load schema"}</p>
          </div>
        ) : (
          <TreeMap
            db={db}
            tables={schemaQuery.data.tables}
            dbName={db === "config" ? "cartethyia.sqlite" : "runtime.sqlite"}
          />
        )}
      </div>

      {/* SQL Console — bottom section */}
      <div className="min-h-0 flex-[2] overflow-hidden sm:flex-[4]">
        <SqlConsole db={db} />
      </div>

      {/* Import confirm dialog */}
      {pendingFile && (
        <Dialog open={true} onClose={() => setPendingFile(null)} title="Confirm Database Import">
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] bg-[var(--status-warning)]/10 text-[var(--status-warning)]">
                <AlertTriangle size={18} />
              </span>
              <div>
                <h2 className="text-sm font-bold">Replace {dbName}?</h2>
                <p className="text-xs text-[var(--text-2)]">
                  Uploading <strong className="font-mono">{pendingFile.name}</strong> ({(pendingFile.size / 1024).toFixed(1)} KB).
                  The current database will be backed up and replaced. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 [button:last-child]:bg-[var(--accent)] [button:last-child]:text-white">
              <Button type="button" variant="ghost" size="sm" onClick={() => setPendingFile(null)}>Cancel</Button>
              <Button type="button" size="sm" onClick={() => void confirmImport()}>Replace</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

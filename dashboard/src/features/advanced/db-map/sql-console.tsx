/**
 * SQL Console — compact query/execute panel for the bottom of the Database Map.
 *
 * Two modes:
 * - SELECT: read-only queries (SELECT/WITH/EXPLAIN), returns result table
 * - EXEC: write operations (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER), returns row count
 *
 * ⌘+Enter runs the current SQL.
 */

import { useState } from "react";
import { Play, AlertCircle, Terminal as TerminalIcon } from "lucide-react";
import { cn } from "../../../lib/cn";
import { useQuerySql, useExecuteSql } from "./api";
import type { DbTarget } from "./types";

interface SqlConsoleProps {
  readonly db: DbTarget;
}

type Mode = "query" | "execute";

function formatCell(value: unknown): string {
  if (value === null) return "∅";
  if (value === undefined) return "";
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function SqlConsole({ db }: SqlConsoleProps) {
  const [sql, setSql] = useState("SELECT * FROM api_keys LIMIT 10;");
  const [mode, setMode] = useState<Mode>("query");
  const [result, setResult] = useState<{
    readonly columns?: readonly string[];
    readonly rows?: readonly Record<string, unknown>[];
    readonly changes?: number;
    readonly durationMs?: number;
    readonly lastInsertRowId?: number | null;
    readonly error?: string;
  } | null>(null);

  const queryMut = useQuerySql();
  const executeMut = useExecuteSql();

  const run = async () => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    setResult(null);
    try {
      if (mode === "query") {
        const res = await queryMut.mutateAsync({ db, sql: trimmed });
        setResult({ columns: res.columns, rows: res.rows, durationMs: res.durationMs });
      } else {
        const res = await executeMut.mutateAsync({ db, sql: trimmed });
        setResult({ changes: res.changes, lastInsertRowId: res.lastInsertRowId, durationMs: res.durationMs });
      }
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Execution failed" });
    }
  };

  const loading = queryMut.isPending || executeMut.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* Header — mode toggle + run */}
      <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-1.5">
        <TerminalIcon size={14} className="shrink-0 text-[var(--text-3)]" />
        <span className="text-xs font-semibold text-[var(--text-2)]">SQL Console</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-md border border-[var(--inner-border)] bg-[var(--surface-1)] p-0.5">
            <button
              type="button"
              onClick={() => setMode("query")}
              className={cn("rounded px-2 py-0.5 text-[10px] font-medium transition-colors", mode === "query" ? "bg-[var(--accent)] text-white" : "text-[var(--text-3)] hover:text-[var(--text-2)]")}
            >SELECT</button>
            <button
              type="button"
              onClick={() => setMode("execute")}
              className={cn("rounded px-2 py-0.5 text-[10px] font-medium transition-colors", mode === "execute" ? "bg-[var(--accent)] text-white" : "text-[var(--text-3)] hover:text-[var(--text-2)]")}
            >EXEC</button>
          </div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[10px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Play size={11} />
            {loading ? "…" : "Run"}
          </button>
        </div>
      </div>

      {/* Editor + Result — stacked top/bottom on mobile, side-by-side on desktop */}
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 sm:flex-row">
        {/* Editor column */}
        <div className="flex min-h-0 flex-1 flex-col gap-1 sm:max-w-[40%]">
          <span className="px-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-3)]/60">Terminal</span>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void run(); }
            }}
            placeholder={mode === "query" ? "SELECT * FROM table_name LIMIT 10;" : "INSERT INTO table_name (col) VALUES ('val');"}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-1)] p-2 font-mono text-[11px] text-[var(--text-2)] placeholder:text-[var(--text-3)]/50 focus:border-[var(--accent)] focus:outline-none"
          />
          <div className="flex items-center gap-1.5 px-1 text-[9px] text-[var(--text-3)]/60">
            <span>⌘+Enter</span>
            {mode === "execute" && (
              <span className="flex items-center gap-0.5 text-[var(--status-warning)]">
                <AlertCircle size={9} /> write mode
              </span>
            )}
          </div>
        </div>

        {/* Result column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          <span className="px-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-3)]/60">Result</span>
          <div className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)]/50">
          {result?.error ? (
            <div className="flex items-start gap-2 p-2.5 text-[var(--red)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <pre className="whitespace-pre-wrap text-[10.5px]">{result.error}</pre>
            </div>
          ) : result?.rows ? (
            <table className="w-full border-collapse text-[10px]">
              <thead className="sticky top-0 bg-[var(--surface-2)]">
                <tr>
                  <th className="w-7 border-b border-[var(--inner-border)] px-1 py-0.5 text-right font-medium text-[var(--text-3)]/60">#</th>
                  {result.columns?.map((col) => (
                    <th key={col} className="border-b border-[var(--inner-border)] px-1.5 py-0.5 text-left font-mono font-semibold text-[var(--text-2)] whitespace-nowrap">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr><td colSpan={(result.columns?.length ?? 0) + 1} className="px-3 py-3 text-center text-[var(--text-3)]/60">No rows returned</td></tr>
                ) : (
                  result.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-[var(--surface-1)]/40">
                      <td className="border-b border-[var(--inner-border)]/50 px-1 py-0.5 text-right font-mono text-[var(--text-3)]/40">{i + 1}</td>
                      {result.columns?.map((col) => {
                        const val = row[col];
                        return (
                          <td
                            key={col}
                            className={cn("max-w-[200px] truncate border-b border-[var(--inner-border)]/50 px-1.5 py-0.5 font-mono", val === "••••••" ? "text-[var(--status-warning)]" : "text-[var(--text-2)]")}
                            title={typeof val === "string" ? val : formatCell(val)}
                          >{formatCell(val)}</td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : result?.changes !== undefined ? (
            <div className="p-2.5 text-[10.5px] text-[var(--text-2)]">
              <span className="font-semibold">{result.changes}</span> row(s) affected
              {result.lastInsertRowId !== null && result.lastInsertRowId !== undefined && <> · last insert row id: <span className="font-mono">{result.lastInsertRowId}</span></>}
              {result.durationMs !== undefined && <> · <span className="font-mono">{result.durationMs}ms</span></>}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[10.5px] text-[var(--text-3)]/40">
              Run a query to see results
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

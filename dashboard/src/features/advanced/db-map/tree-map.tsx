/**
 * Tree Map — collapsible schema browser with inline body data.
 *
 * When a table node is expanded it shows columns + indexes AND a small
 * inline preview of the first N rows, so the user sees the table's "body"
 * directly in the tree without switching to a separate tab.
 */

import { useState, useMemo, useCallback } from "react";
import {
  ChevronRight,
  ChevronDown,
  Table as TableIcon,
  Key,
  Lock,
  Hash,
  Type as TypeIcon,
  Database as DbIcon,
} from "lucide-react";
import { cn } from "../../../lib/cn";
import { useTableRows } from "./api";
import type { ColumnInfo, DbTarget, TableInfo } from "./types";
import { formatDbCell } from "./formatters";

interface TreeMapProps {
  readonly db: DbTarget;
  readonly tables: readonly TableInfo[];
  readonly dbName: string;
}

/** Number of inline preview rows shown when a table is expanded. */
const PREVIEW_ROWS = 5;

function typeIcon(type: string): typeof TypeIcon {
  const lower = type.toLowerCase();
  if (lower.includes("int")) return Hash;
  if (lower.includes("text") || lower.includes("char") || lower.includes("clob")) return TypeIcon;
  return TypeIcon;
}


function ColumnRow({ col }: { readonly col: ColumnInfo }) {
  const Icon = typeIcon(col.type);
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 text-[10.5px] text-[var(--text-3)] hover:bg-[var(--surface-1)]/50 rounded-sm">
      <Icon size={11} className="shrink-0 text-[var(--text-3)]/60" />
      <span className={cn("font-mono", col.pk && "text-[var(--accent)] font-semibold")}>{col.name}</span>
      <span className="text-[var(--text-3)]/50">{col.type}</span>
      {col.pk && <Key size={9} className="shrink-0 text-[var(--accent)]" />}
      {col.sensitive && <Lock size={9} className="shrink-0 text-[var(--status-warning)]" />}
      {col.notNull && <span className="text-[var(--text-3)]/40">NN</span>}
    </div>
  );
}

/** Inline body preview — first N rows shown directly under the columns. */
function InlineBody({ db, table }: { readonly db: DbTarget; readonly table: TableInfo }) {
  const { data, isLoading, isError, error } = useTableRows(db, table.name, PREVIEW_ROWS, 0);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-[var(--text-3)]/60">
        <div className="h-2.5 w-2.5 animate-spin rounded-full border border-[var(--surface-2)] border-t-[var(--accent)]" />
        Loading rows…
      </div>
    );
  }

  if (isError) {
    return <p className="px-3 py-1 text-[10px] text-[var(--red)]">{error instanceof Error ? error.message : "Failed to load"}</p>;
  }

  if (!data || data.rows.length === 0) {
    return <p className="px-3 py-1 text-[10px] text-[var(--text-3)]/50">Table is empty</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr>
            {data.columns.map((col) => (
              <th
                key={col}
                className="border-b border-r border-[var(--inner-border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-left font-mono font-semibold text-[var(--text-2)] whitespace-nowrap"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i} className="hover:bg-[var(--surface-1)]/40">
              {data.columns.map((col) => {
                const val = row[col];
                const isMasked = val === "••••••";
                return (
                  <td
                    key={col}
                    className={cn(
                      "max-w-[180px] truncate border-b border-r border-[var(--inner-border)]/50 px-1.5 py-0.5 font-mono",
                      isMasked ? "text-[var(--status-warning)]" : "text-[var(--text-2)]",
                    )}
                    title={typeof val === "string" ? val : formatDbCell(val)}
                  >
                    {formatDbCell(val)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {data.total > PREVIEW_ROWS && (
        <p className="px-2 py-0.5 text-[9px] text-[var(--text-3)]/50">
          Showing {PREVIEW_ROWS} of {data.total.toLocaleString()} rows — use SQL Console for full queries
        </p>
      )}
    </div>
  );
}

function TableNode({
  db,
  table,
  expanded,
  onToggle,
}: {
  readonly db: DbTarget;
  readonly table: TableInfo;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="select-none">
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
          expanded
            ? "bg-[var(--accent-soft)]/50 text-[var(--accent)] font-semibold"
            : "hover:bg-[var(--surface-1)]/60 text-[var(--text-2)]",
        )}
        onClick={onToggle}
      >
        {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
        <TableIcon size={13} className="shrink-0 text-[var(--text-3)]" />
        <span className="truncate font-mono">{table.name}</span>
        <span className="ml-auto shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-3)]">
          {table.rowCount.toLocaleString()}
        </span>
      </div>
      {expanded && (
        <div className="ml-3 mt-0.5 mb-1 border-l border-[var(--inner-border)] pl-1">
          {/* Columns */}
          <div className="space-y-0">
            {table.columns.map((col) => (
              <ColumnRow key={col.name} col={col} />
            ))}
          </div>
          {/* Indexes */}
          {table.indexes.length > 0 && (
            <div className="mt-1 space-y-0.5 px-2 pb-1 text-[9.5px] text-[var(--text-3)]/60">
              <div className="font-medium">Indexes</div>
              {table.indexes.map((idx) => (
                <div key={idx.name} className="flex items-center gap-1 font-mono">
                  <span>{idx.unique ? "★" : "◇"}</span>
                  <span>{idx.name}</span>
                  <span className="text-[var(--text-3)]/40">({idx.columns.join(", ")})</span>
                </div>
              ))}
            </div>
          )}
          {/* Inline body data */}
          <div className="mt-1 border-t border-[var(--inner-border)] pt-1">
            <div className="px-2 pb-0.5 text-[9px] font-medium text-[var(--text-3)]/60">Data preview</div>
            <InlineBody db={db} table={table} />
          </div>
        </div>
      )}
    </div>
  );
}

export function TreeMap({ db, tables, dbName }: TreeMapProps) {
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return tables;
    const lower = filter.toLowerCase();
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(lower) ||
        t.columns.some((c) => c.name.toLowerCase().includes(lower)),
    );
  }, [tables, filter]);

  const toggle = useCallback((name: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const expandAll = () => setExpandedSet(new Set(filtered.map((t) => t.name)));
  const collapseAll = () => setExpandedSet(new Set());

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* DB header */}
      <div className="flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-2">
        <DbIcon size={14} className="shrink-0 text-[var(--text-3)]" />
        <span className="truncate text-xs font-semibold text-[var(--text-2)]">{dbName}</span>
        <span className="ml-auto shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-3)]">
          {tables.length} tables
        </span>
      </div>

      {/* Filter + actions */}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
          className="min-w-0 flex-1 rounded-md border border-[var(--inner-border)] bg-[var(--surface-1)] px-2 py-1 text-[11px] text-[var(--text-2)] placeholder:text-[var(--text-3)]/50 focus:border-[var(--accent)] focus:outline-none"
        />
        <button type="button" onClick={expandAll} className="shrink-0 rounded-md border border-[var(--inner-border)] px-1.5 py-1 text-[10px] text-[var(--text-3)] hover:bg-[var(--surface-1)]">All</button>
        <button type="button" onClick={collapseAll} className="shrink-0 rounded-md border border-[var(--inner-border)] px-1.5 py-1 text-[10px] text-[var(--text-3)] hover:bg-[var(--surface-1)]">None</button>
      </div>

      {/* Tree nodes */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)]/50 p-1.5">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-[var(--text-3)]/60">No tables match filter</p>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((table) => (
              <TableNode
                key={table.name}
                db={db}
                table={table}
                expanded={expandedSet.has(table.name)}
                onToggle={() => toggle(table.name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

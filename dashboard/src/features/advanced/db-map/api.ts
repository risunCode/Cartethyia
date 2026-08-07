/** API hooks for Database Map — schema, rows, query, execute, export, import. */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, ApiError } from "../../../lib/api";
import { toast } from "../../../lib/toast";
import { qk } from "../../../lib/query-keys";
import type {
  DbTarget,
  ExecuteResult,
  ImportResult,
  QueryResult,
  SchemaResult,
  TableRowsResult,
} from "./types";

/** Fetch schema for a database target. */
export function useSchema(db: DbTarget) {
  return useQuery({
    queryKey: qk.dbMap.schema(db),
    queryFn: () => apiGet<SchemaResult>(`/db-map/schema?db=${db}`),
    staleTime: 30_000,
  });
}

/** Fetch paginated rows for a table. */
export function useTableRows(db: DbTarget, table: string | null, limit: number, offset: number) {
  return useQuery({
    queryKey: qk.dbMap.rows(db, table, limit, offset),
    queryFn: () => apiGet<TableRowsResult>(`/db-map/tables/${table}/rows?db=${db}&limit=${limit}&offset=${offset}`),
    enabled: table !== null,
    staleTime: 10_000,
  });
}

/** Execute a SELECT-only SQL query. */
export function useQuerySql() {
  return useMutation({
    mutationFn: ({ db, sql }: { db: DbTarget; sql: string }) =>
      apiPost<QueryResult>(`/db-map/query?db=${db}`, { sql }),
    onError: (err: ApiError) => {
      toast.error(`Query failed: ${err.message}`);
    },
  });
}

/** Execute a DML/DDL statement (transactional). */
export function useExecuteSql() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ db, sql }: { db: DbTarget; sql: string }) =>
      apiPost<ExecuteResult>(`/db-map/execute?db=${db}`, { sql }),
    onSuccess: (_data, vars) => {
      toast.success(`${_data.changes} row(s) affected in ${_data.durationMs}ms`);
      qc.invalidateQueries({ queryKey: qk.dbMap.schema(vars.db) });
      qc.invalidateQueries({ queryKey: qk.dbMap.rowsPrefix(vars.db) });
    },
    onError: (err: ApiError) => {
      toast.error(`Execute failed: ${err.message}`);
    },
  });
}

/** Export database as .sqlite download. */
export function useExportDb() {
  return useMutation({
    mutationFn: async (db: DbTarget) => {
      const res = await fetch(`/console/api/db-map/export?db=${db}`, { credentials: "same-origin" });
      if (!res.ok) {
        const text = await res.text();
        try {
          const err = JSON.parse(text);
          throw new ApiError(res.status, err?.error?.code ?? "error", err?.error?.message ?? "export failed");
        } catch {
          throw new ApiError(res.status, "error", "export failed");
        }
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `${db}-export.sqlite`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast.success("Database exported");
    },
    onError: (err: ApiError) => {
      toast.error(`Export failed: ${err.message}`);
    },
  });
}

/** Import database from uploaded .sqlite file. */
export function useImportDb() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ db, file }: { db: DbTarget; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/console/api/db-map/import?db=${db}`, {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const err = parsed as { error?: { code: string; message: string } } | null;
        throw new ApiError(res.status, err?.error?.code ?? "error", err?.error?.message ?? "import failed");
      }
      return parsed as ImportResult;
    },
    onSuccess: (data, vars) => {
      toast.success(data.message ?? "Database imported");
      qc.invalidateQueries({ queryKey: qk.dbMap.schema(vars.db) });
      qc.invalidateQueries({ queryKey: qk.dbMap.rowsPrefix(vars.db) });
    },
    onError: (err: ApiError) => {
      toast.error(`Import failed: ${err.message}`);
    },
  });
}

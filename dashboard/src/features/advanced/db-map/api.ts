/** API hooks for Database Map — schema, rows, query, execute, export, import. */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPostForm, apiDownload, ApiError } from "../../../lib/api";
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
      const { blob, filename } = await apiDownload(`/db-map/export?db=${db}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? `${db}-export.sqlite`;
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
      return apiPostForm<ImportResult>(`/db-map/import?db=${db}`, formData);
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

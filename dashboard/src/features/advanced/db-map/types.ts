/** Database Map frontend types — mirrors backend contracts. */

export type DbTarget = "config" | "runtime";

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly pk: boolean;
  readonly sensitive: boolean;
}

export interface IndexInfo {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
}

export interface TableInfo {
  readonly name: string;
  readonly rowCount: number;
  readonly columns: readonly ColumnInfo[];
  readonly indexes: readonly IndexInfo[];
}

export interface SchemaResult {
  readonly database: DbTarget;
  readonly tables: readonly TableInfo[];
}

export interface TableRowsResult {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly changes: number;
  readonly durationMs: number;
}

export interface ExecuteResult {
  readonly changes: number;
  readonly lastInsertRowId: number | null;
  readonly durationMs: number;
}

export interface ImportResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly error?: string;
}

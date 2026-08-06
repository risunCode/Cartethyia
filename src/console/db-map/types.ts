/**
 * Database Map type contracts — shared across service, API routes, and
 * the dashboard frontend.
 *
 * The Database Map page provides read-only schema introspection, bounded
 * paginated row reads, SQL query/execute (with DDL/DML separation),
 * export (raw .sqlite download), and import (validated .sqlite upload)
 * for both the configuration and runtime telemetry databases.
 *
 * Security:
 * - Every route sits behind the console session guard (applied by the
 *   parent console API app). The dashboard adds a client-side password
 *   re-auth gate (mirrors the Terminal page pattern) so the UI is not
 *   accessible without re-entering the console password within the TTL.
 * - Sensitive column names are masked in row data returned by the schema
 *   and table-rows endpoints — see {@link SENSITIVE_COLUMN_NAMES}.
 * - SQL execution rejects PRAGMA statements that could change journal mode,
 *   attach databases, or similar persistence-altering operations.
 */

/** Which database to operate on. */
export type DbTarget = "config" | "runtime";

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly pk: boolean;
  /** Whether this column is sensitive (credentials, tokens, secrets). */
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

export type QueryResult = {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly changes: number;
  readonly durationMs: number;
};

export type ExecuteResult = {
  readonly changes: number;
  readonly lastInsertRowId: number | null;
  readonly durationMs: number;
};

export type ExportResult = {
  readonly ok: true;
  readonly filename: string;
  readonly data: Uint8Array;
} | { readonly ok: false; readonly error: string };

export type ImportResult = {
  readonly ok: true;
  readonly message: string;
} | { readonly ok: false; readonly error: string };

/**
 * Column names that are masked in row output regardless of table. The raw
 * value is replaced with "••••••" so the structure is visible without
 * leaking secrets. A re-authenticated "show secrets" flow could bypass this
 * in a future iteration — for now all secrets are masked.
 */
export const SENSITIVE_COLUMN_NAMES: Record<string, true> = {
  password_hash: true,
  jwt_secret: true,
  key: true,
  credential: true,
  password: true,
  token: true,
  refresh_token: true,
  access_token: true,
  token_hash: true,
  username: true,
  license_key: true,
  private_key: true,
  secret: true,
};

export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_COLUMN_NAMES[name.toLowerCase()] === true;
}

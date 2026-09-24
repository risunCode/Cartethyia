/**
 * Restore validation, and the format detection that decides what a payload is.
 *
 * Validation runs to completion before any write. A payload is accepted only
 * when every table name and every column name resolves against the live Drizzle
 * schema, so a stale backup (a column since dropped) fails loudly with the
 * offending name instead of writing a partial row, and a hostile payload cannot
 * name a column that does not exist.
 *
 * Detection is by shape, not by a flag, because the user imports one file and
 * the file says what it is: our own backups carry `app: "cartethyia"`, and a
 * 9Router export carries the table names it dumps (`providerConnections`,
 * `providerNodes`, `apiKeys`, …).
 */
import type { Table } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import {
  BACKUP_APP,
  BACKUP_SECTIONS,
  BACKUP_VERSION,
  CONFIG_TABLES,
  MAX_ROWS_PER_TABLE,
  TELEMETRY_TABLES,
  TENANT_TABLE,
  columnNames,
  findTable,
  tableName,
  type BackupRow,
  type BackupSection,
  type RestoreValidation,
  type ValidatedRestore,
  type ValidatedTable,
} from "./contracts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Column name → its Drizzle data type, so validation knows what may nest. */
function columnTypes(table: Table): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const column of Object.values(getTableColumns(table))) {
    out.set(column.name, column.dataType);
  }
  return out;
}

/** Detection outcome for an uploaded file. */
export type DetectedFormat =
  | { readonly kind: "native"; readonly payload: Record<string, unknown> }
  | { readonly kind: "nine_router"; readonly payload: Record<string, unknown> }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Table names a 9Router export always writes. Requiring several keeps a
 * coincidental key from misclassifying a file — a lone `apiKeys` key is not
 * enough, and neither is `settings`, which both formats could plausibly carry.
 */
const NINE_ROUTER_MARKERS = ["providerConnections", "providerNodes", "apiKeys", "combos"] as const;

/** Decides what an uploaded payload is, without mutating it. */
export function detectFormat(input: unknown): DetectedFormat {
  if (!isPlainObject(input)) return { kind: "unknown", reason: "payload must be a JSON object" };

  // Our own payload wraps everything in `backup` when posted from the UI form,
  // so unwrap before inspecting.
  const candidate = isPlainObject(input.backup) ? (input.backup as Record<string, unknown>) : input;

  if (candidate.app === BACKUP_APP) return { kind: "native", payload: candidate };
  if (typeof candidate.app === "string" && candidate.app.length > 0 && candidate.app !== BACKUP_APP) {
    // A different application's own backup format. Say which, so the operator
    // knows this is the wrong file rather than a corrupt one.
    return { kind: "unknown", reason: `backup is for "${candidate.app}", not "${BACKUP_APP}"` };
  }

  const matches = NINE_ROUTER_MARKERS.filter((marker) => marker in candidate).length;
  if (matches >= 2) return { kind: "nine_router", payload: candidate };

  return {
    kind: "unknown",
    reason:
      "unrecognized backup: expected a Cartethyia backup (app: \"cartethyia\") or a router export " +
      "carrying providerConnections/providerNodes/apiKeys/combos",
  };
}

/** One section's tables, in dependency order. */
function orderedTables(section: BackupSection): readonly Table[] {
  if (section === "telemetry") return TELEMETRY_TABLES;
  return [...CONFIG_TABLES, TENANT_TABLE];
}

/**
 * Validates a native backup payload.
 *
 * Returns every problem it can find rather than the first, so an operator
 * fixing a hand-edited file sees the whole list.
 *
 * `tenantId` is the restoring tenant. A row that carries a `tenant_id` column
 * is checked against it here, before anything is written, so a payload lifted
 * from another deployment fails with a message naming the table instead of
 * silently writing rows that belong to a different tenant.
 */
export function validateRestorePayload(payload: unknown, tenantId: string): RestoreValidation {
  if (!isPlainObject(payload)) return { ok: false, error: "backup must be a JSON object" };
  if (payload.app !== BACKUP_APP) {
    // Name the foreign app when there is one: "this is for something else" is a
    // far more useful message than "the field must equal cartethyia".
    const foreign = typeof payload.app === "string" && payload.app.length > 0 ? payload.app : null;
    return {
      ok: false,
      error:
        foreign === null
          ? `backup.app must be "${BACKUP_APP}"`
          : `backup is for "${foreign}", not "${BACKUP_APP}"`,
    };
  }
  if (payload.version !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version ${String(payload.version)}` };
  }
  if (!isPlainObject(payload.sections)) {
    return { ok: false, error: "backup.sections must be an object" };
  }

  const tables = new Map<Table, ValidatedTable>();
  const counts: Record<string, number> = {};
  let tenantRows: readonly BackupRow[] = [];

  for (const [sectionName, sectionValue] of Object.entries(payload.sections)) {
    if (!BACKUP_SECTIONS.includes(sectionName as BackupSection)) {
      return { ok: false, error: `unknown backup section "${sectionName}"` };
    }
    const section = sectionName as BackupSection;
    if (!isPlainObject(sectionValue)) {
      return { ok: false, error: `backup.sections.${section} must be an object` };
    }

    for (const [name, value] of Object.entries(sectionValue)) {
      const table = findTable(section, name);
      if (table === undefined) {
        return { ok: false, error: `unknown table "${name}" in section "${section}"` };
      }
      if (!Array.isArray(value)) {
        return { ok: false, error: `table "${name}" must be an array of rows` };
      }
      if (value.length > MAX_ROWS_PER_TABLE) {
        return { ok: false, error: `table "${name}" exceeds the ${MAX_ROWS_PER_TABLE} row limit` };
      }

      const allowed = columnNames(table);
      const types = columnTypes(table);
      const rows: BackupRow[] = [];
      for (let i = 0; i < value.length; i++) {
        const row = value[i];
        if (!isPlainObject(row)) return { ok: false, error: `${name}[${i}] must be a row object` };
        for (const [column, cell] of Object.entries(row)) {
          if (!allowed.has(column)) {
            return { ok: false, error: `${name}.${column} is not a column of ${tableName(table)}` };
          }
          // A `json`/`jsonb` column legitimately holds any nested shape, so it
          // is passed through untouched. Every other column must be a scalar or
          // one of the two carrier objects the store encodes dates and byte
          // strings into; anything else (a nested array, an arbitrary object) is
          // rejected rather than coerced into something the driver would guess.
          if (types.get(column) === "json") continue;
          if (isPlainObject(cell)) {
            const carrier = Object.keys(cell);
            const isCarrier =
              (carrier.length === 1 && carrier[0] === "__date" && typeof cell["__date"] === "string") ||
              (carrier.length === 1 && carrier[0] === "__bytes" && typeof cell["__bytes"] === "string");
            if (!isCarrier) {
              return { ok: false, error: `${name}[${i}].${column} is not a scalar or a carrier object` };
            }
          } else if (typeof cell === "object" && cell !== null) {
            return { ok: false, error: `${name}[${i}].${column} must be a scalar, null, or a carrier` };
          }
        }
        // A row may not claim a tenant other than the restoring one. Only the
        // tables that actually carry the column are checked; the rest are
        // scoped by their parent, which the store filters on.
        if (types.has("tenant_id") && row["tenant_id"] !== undefined && row["tenant_id"] !== null) {
          if (row["tenant_id"] !== tenantId) {
            return {
              ok: false,
              error: `${name}[${i}] belongs to a different tenant than the one importing`,
            };
          }
        }
        rows.push(row as BackupRow);
      }

      if (table === TENANT_TABLE) {
        tenantRows = rows;
        continue;
      }
      tables.set(table, {
        table,
        mode: section === "telemetry" ? "append" : "replace",
        rows,
      });
      counts[name] = rows.length;
    }
  }

  const value: ValidatedRestore = { tables, tenantRows, counts };
  return { ok: true, value };
}

/** Convenience: the ordered table list a restore must walk for this payload. */
export function restoreOrder(): readonly Table[] {
  return [...orderedTables("config"), ...orderedTables("telemetry")];
}

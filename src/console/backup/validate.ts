/**
 * Restore validation, and the format detection that decides what a payload is.
 *
 * Validation runs to completion before any write. A payload is accepted only
 * when every table name and every column name resolves against the live Drizzle
 * schema, so a stale backup (a column since dropped) fails loudly with the
 * offending name instead of writing a partial row, and a hostile payload cannot
 * name a column that does not exist.
 *
 * Detection is by shape, not by a flag: native backups carry
 * `app: "cartethyia"`, while supported legacy exports carry their own table
 * names.
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
  droppedColumns,
  findTable,
  sealedAliases,
  sealedColumns,
  tableName,
  type BackupRow,
  type BackupSection,
  type RestoreValidation,
  type RestoreWarning,
  type ValidatedRestore,
  type ValidatedTable,
} from "./contracts";
import { apiKeys, shareLinks } from "../../persistence/schema";
function legacyModelList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

function normalizeLegacyApiKeyPolicy(row: Record<string, unknown>): Record<string, unknown> {
  const allowlist = legacyModelList(row["model_allowlist"]);
  const denylist = legacyModelList(row["model_denylist"]);
  if (row["model_access_mode"] !== undefined || row["model_list"] !== undefined) return row;
  if (denylist !== undefined && denylist.length > 0) {
    return { ...row, model_access_mode: "blacklist", model_list: denylist };
  }
  if (allowlist !== undefined) {
    return { ...row, model_access_mode: "whitelist", model_list: allowlist };
  }
  return row;
}

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

/**
 * Columns a row must carry or the insert cannot succeed at all.
 *
 * `NOT NULL` with no default and no identity: the database has nothing to fill
 * in, so a row that omits one is unusable. An old export is exactly where such
 * a row comes from — a column that was once optional became required, or the
 * export predates it.
 *
 * Skipped rather than defaulted: inventing a value for `scopes` or `label`
 * would write a row the operator never had, and guessing wrong on a credential
 * column is worse than not restoring that one row.
 */
function requiredColumns(table: Table): ReadonlySet<string> {
  const out = new Set<string>();
  for (const column of Object.values(getTableColumns(table))) {
    if (!column.notNull || column.hasDefault) continue;
    if (column.generated !== undefined || column.generatedIdentity !== undefined) continue;
    // `tenant_id` is not the file's to supply: every tenant-scoped row is
    // re-assigned to the importing tenant below, so it can never be missing.
    if (column.name === "tenant_id") continue;
    out.add(column.name);
  }
  return out;
}

/** Detection outcome for an uploaded file. */
export type DetectedFormat =
  | { readonly kind: "native"; readonly payload: Record<string, unknown> }
  | { readonly kind: "nine_router"; readonly payload: Record<string, unknown> }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Table names used to recognize a supported legacy export. Requiring several
 * keeps a coincidental key from misclassifying a file — a lone `apiKeys` key is
 * not enough, and neither is `settings`, which both formats could plausibly carry.
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
 * Recovers what it can and reports what it could not, in {@link RestoreWarning}s,
 * rather than refusing the file. A backup is a historical artifact: a table
 * renamed, a column dropped, or a version bump since it was taken must cost the
 * operator that one part, not the whole recovery. Only a payload that is not a
 * Cartethyia backup at all is rejected outright.
 *
 * Every problem that survives to a warning is still *checked* — an unknown
 * column never reaches the store, and a row that cannot be represented is
 * dropped rather than coerced. What changes is the verdict, not the rigor.
 *
 * `tenantId` is the restoring tenant. A row that carries a `tenant_id` column
 * is rewritten to it here, before anything is written, so a payload lifted from
 * another deployment lands in the importing tenant instead of silently
 * restoring rows that belong to a different one.
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
  if (!isPlainObject(payload.sections)) {
    return { ok: false, error: "backup.sections must be an object" };
  }

  const warnings: RestoreWarning[] = [];
  // A version we do not write is not a reason to refuse the file: the section
  // and column checks below are what actually decide what can be restored, so a
  // future export degrades to "whatever still resolves" instead of dead.
  if (payload.version !== BACKUP_VERSION) {
    warnings.push({
      reason: `backup version ${String(payload.version)} is not ${BACKUP_VERSION}; only the parts that still match the schema were restored`,
    });
  }

  const tables = new Map<Table, ValidatedTable>();
  const counts: Record<string, number> = {};
  let tenantRows: readonly BackupRow[] = [];

  for (const [sectionName, sectionValue] of Object.entries(payload.sections)) {
    if (!BACKUP_SECTIONS.includes(sectionName as BackupSection)) {
      warnings.push({ reason: `unknown backup section "${sectionName}" was skipped` });
      continue;
    }
    const section = sectionName as BackupSection;
    if (!isPlainObject(sectionValue)) {
      warnings.push({ reason: `backup.sections.${section} is not an object and was skipped` });
      continue;
    }

    for (const [name, value] of Object.entries(sectionValue)) {
      const table = findTable(section, name);
      if (table === undefined) {
        warnings.push({ table: name, reason: `unknown table in section "${section}"; skipped` });
        continue;
      }
      if (!Array.isArray(value)) {
        warnings.push({ table: name, reason: "not an array of rows; skipped" });
        continue;
      }
      if (value.length > MAX_ROWS_PER_TABLE) {
        warnings.push({
          table: name,
          reason: `exceeds the ${MAX_ROWS_PER_TABLE} row limit; only the first ${MAX_ROWS_PER_TABLE} rows were restored`,
        });
      }

      const allowed = columnNames(table);
      const dropped = droppedColumns(table);
      const types = columnTypes(table);
      const required = requiredColumns(table);
      const sealed = sealedColumns(table);
      const rows: BackupRow[] = [];
      // One warning per (table, column), not per row: a retired column is one
      // fact about the file, and repeating it 4,000 times is noise.
      const reported = new Set<string>();
      // A payload names its secrets for what they are (`access_token`), not for
      // the column that seals them (`credential_ciphertext`) — the ciphertext is
      // the one thing a backup cannot carry between installations. Map them back
      // before anything else looks at the row, or the credentials would be
      // dropped as unknown columns and the configuration would come back with
      // none of them.
      const aliases = sealedAliases(table);
      const capped = Math.min(value.length, MAX_ROWS_PER_TABLE);
      const rowsIn: readonly unknown[] =
        aliases.size === 0
          ? value
          : value.slice(0, capped).map((row) => {
              if (!isPlainObject(row)) return row;
              const mapped: Record<string, unknown> = {};
              for (const [column, cell] of Object.entries(row)) {
                mapped[aliases.get(column) ?? column] = cell;
              }
              return mapped;
            });

      for (let i = 0; i < capped; i++) {
        const row = rowsIn[i];
        if (!isPlainObject(row)) {
          warnings.push({ table: name, reason: `row ${i} is not an object; skipped` });
          continue;
        }
        // Older v1 backups used separate allow/deny columns. Convert them to
        // the current single policy before dropping retired column names.
        const sourceRow = table === apiKeys ? normalizeLegacyApiKeyPolicy(row) : row;
        // A stale backup may still carry columns the schema has since dropped.
        // Those are accepted but removed here, so they never reach the store
        // (which would reject them as unknown) and the rest of the row restores.
        const sanitizedRow = dropped.size > 0 && Object.keys(sourceRow).some((column) => dropped.has(column))
          ? Object.fromEntries(Object.entries(sourceRow).filter(([column]) => !dropped.has(column)))
          : sourceRow;
        // A column the schema never had is dropped from the row rather than
        // failing the table: the rest of the row still restores.
        const unknownColumns = Object.keys(sanitizedRow).filter((column) => !allowed.has(column));
        for (const column of unknownColumns) {
          if (reported.has(column)) continue;
          reported.add(column);
          warnings.push({
            table: name,
            column,
            reason: `not a column of ${tableName(table)}; the column was dropped from every row`,
          });
        }
        // A sealed column may only be restored from plaintext, because plaintext
        // is the only form the store can re-seal under *this* install's key (see
        // `sealedColumns`). A `{ __bytes }` cell in one of those columns is
        // therefore ciphertext written by another install — the shape every
        // backup before the credential portability fix produced — and it is
        // dropped with a reason rather than inserted as though it were readable
        // here, which is the defect that left restored providers unopenable. The
        // rest of the row still restores: an account without its token is
        // recoverable, and the operator re-authorizes one credential rather than
        // losing the configuration.
        let sealedRow = sanitizedRow;
        if (sealed.size > 0) {
          for (const column of sealed) {
            if (!(column in sealedRow)) continue;
            const cell = sealedRow[column];
            if (cell === null || cell === undefined || typeof cell === "string") continue;
            if (!reported.has(column)) {
              reported.add(column);
              warnings.push({
                table: name,
                column,
                reason:
                  "held ciphertext sealed under another install's key; the credential was not restored, so re-authorize it",
              });
            }
            sealedRow = Object.fromEntries(Object.entries(sealedRow).filter(([key]) => key !== column));
          }
        }
        const knownRow: Record<string, unknown> =
          unknownColumns.length === 0
            ? sealedRow
            : Object.fromEntries(Object.entries(sealedRow).filter(([column]) => allowed.has(column)));

        // A row missing a column the database cannot fill in would abort the
        // whole transaction. Drop that row and report it, so one stale row
        // costs one row instead of the entire restore.
        const missing = [...required].filter(
          (column) => knownRow[column] === undefined || knownRow[column] === null,
        );
        if (missing.length > 0) {
          const key = `missing:${missing.join(",")}`;
          if (!reported.has(key)) {
            reported.add(key);
            warnings.push({
              table: name,
              reason: `${missing.length === 1 ? "row is missing required column" : "rows are missing required columns"} ${missing.join(", ")}; those rows were skipped`,
            });
          }
          continue;
        }
        let rowUsable = true;
        for (const [column, cell] of Object.entries(knownRow)) {
          // A `json`/`jsonb` column legitimately holds any nested shape, so it
          // is passed through untouched. Every other column must be a scalar or
          // one of the two carrier objects the store encodes dates and byte
          // strings into; anything else (a nested array, an arbitrary object) is
          // dropped rather than coerced into something the driver would guess.
          if (types.get(column) === "json") continue;
          if (isPlainObject(cell)) {
            const carrier = Object.keys(cell);
            const isCarrier =
              (carrier.length === 1 && carrier[0] === "__date" && typeof cell["__date"] === "string") ||
              (carrier.length === 1 && carrier[0] === "__bytes" && typeof cell["__bytes"] === "string");
            if (!isCarrier) {
              if (!reported.has(column)) {
                reported.add(column);
                warnings.push({ table: name, column, reason: "held an unsupported value; dropped" });
              }
              rowUsable = false;
            }
          } else if (typeof cell === "object" && cell !== null) {
            if (!reported.has(column)) {
              reported.add(column);
              warnings.push({ table: name, column, reason: "held an unsupported value; dropped" });
            }
            rowUsable = false;
          }
        }
        if (!rowUsable) continue;
        // A backup is portable across deployments: tenant-scoped rows keep
        // their shape but are assigned to the authenticated importing tenant.
        // The tenant row itself is handled separately below and never gets
        // remapped here.
        const tenantScopedRow =
          table === TENANT_TABLE || !types.has("tenant_id")
            ? (knownRow as BackupRow)
            : { ...(knownRow as BackupRow), tenant_id: tenantId };
        // Version-1 backups can carry the retired monitor/setup link kinds.
        // Import them as inactive enrollment links so their old tokens never
        // regain a usable public endpoint.
        const normalizedRow =
          table === shareLinks &&
          tenantScopedRow["kind"] !== undefined &&
          tenantScopedRow["kind"] !== "enroll"
            ? { ...tenantScopedRow, kind: "enroll", active: false }
            : tenantScopedRow;
        rows.push(normalizedRow);
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

  const value: ValidatedRestore = { tables, tenantRows, counts, warnings };
  return { ok: true, value };
}

/** Convenience: the ordered table list a restore must walk for this payload. */
export function restoreOrder(): readonly Table[] {
  return [...orderedTables("config"), ...orderedTables("telemetry")];
}

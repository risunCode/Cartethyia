/**
 * Drizzle-backed export/restore of the backup contract.
 *
 * Encoding rules are driven by the column's Drizzle `dataType` rather than a
 * hand-written per-column table, so a new column cannot be forgotten:
 * - `date` → `{ __date: ISO }`. JSON has no date; a bare string would come back
 *   as text and Postgres would have to guess.
 * - `custom` (our `bytea` columns: encrypted credentials) → `{ __bytes: base64 }`.
 *   Postgres returns a `Buffer`, and `JSON.stringify` renders that as
 *   `{"type":"Buffer","data":[…]}` — large, and it silently "works" on import
 *   while misrepresenting the type.
 * - everything else is already JSON-safe (string, number, boolean, json, null).
 *
 * **A restore only ever touches the restoring tenant's own rows.** Both the
 * export and the restore are scoped by {@link ownershipOf}: a tenant's backup
 * contains its own configuration plus the shared rows it depends on (the
 * built-in providers and catalog), and a restore replaces only the rows it
 * owns. Shared rows are re-ensured, never deleted and never overwritten. This
 * is not a nicety — `provider_accounts` is tenant-scoped, but `providers` and
 * `models` are shared, so a table-wide `DELETE` before insert would take every
 * other tenant's accounts and the entire built-in catalog with it.
 *
 * Restore modes differ by section and the difference is load-bearing:
 * - **config** is replaced (delete the tenant's rows, then insert) — that is
 *   what "restore my configuration" means.
 * - **telemetry** is merged, never deleted. Importing history must not remove
 *   rows already present, so existing `(tenant_id, request_id, created_at)`
 *   keys are read first and duplicates are skipped, making a re-import
 *   idempotent. There is no unique constraint to lean on: `telemetry_events`
 *   has a random PK, so the natural key is checked explicitly.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getTableColumns, type Column, type SQL, type Table } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { telemetryEvents } from "../../persistence/schema";
import {
  BACKUP_APP,
  BACKUP_VERSION,
  CONFIG_TABLES,
  MAX_ROWS_PER_TABLE,
  TELEMETRY_TABLES,
  TENANT_TABLE,
  columnNames,
  ownershipOf,
  replaceModeOf,
  tableName,
  type BackupBytes,
  type BackupDate,
  type BackupExportResult,
  type BackupPayload,
  type BackupRow,
  type ValidatedRestore,
} from "./contracts";

/** Encodes one cell into a JSON-safe value. */
function encodeCell(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "date") {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime())
      ? null
      : ({ __date: date.toISOString() } satisfies BackupDate);
  }
  if (dataType === "custom") {
    if (Buffer.isBuffer(value)) return { __bytes: value.toString("base64") } satisfies BackupBytes;
    if (value instanceof Uint8Array) {
      return { __bytes: Buffer.from(value).toString("base64") } satisfies BackupBytes;
    }
    return null;
  }
  return value;
}

/** Decodes one payload cell back to what the driver expects for that column. */
function decodeCell(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined) return null;
  if (dataType === "date") {
    const raw =
      typeof value === "object" && value !== null && "__date" in value
        ? (value as BackupDate).__date
        : String(value);
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid date value: ${raw}`);
    return date;
  }
  if (dataType === "custom") {
    if (typeof value === "object" && value !== null && "__bytes" in value) {
      return Buffer.from((value as BackupBytes).__bytes, "base64");
    }
    if (typeof value === "string") return Buffer.from(value, "base64");
    throw new Error("a byte column must be a base64 string or a { __bytes } object");
  }
  return value;
}

/** Column name → the object key Drizzle uses for it, and its data type. */
function columnIndex(table: Table): ReadonlyMap<string, { key: string; dataType: string }> {
  const out = new Map<string, { key: string; dataType: string }>();
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    out.set(column.name, { key, dataType: column.dataType });
  }
  return out;
}

/**
 * The predicate that selects exactly the rows `tenantId` owns in `table`.
 *
 * `viaParent` reads as a subquery on the parent's owner column, so a model row
 * is the tenant's exactly when its provider is. `authored` adds the second
 * arm: a row whose `source` is not the value the build stamps is the tenant's
 * own work even when it sits under a shared provider. A `NULL` owner — a
 * built-in provider, a pool-wide account — never satisfies `= tenantId`, which
 * is what keeps the shared catalog out of a tenant's restore.
 */
function ownedByFilter(table: Table, tenantId: string): SQL {
  const ownership = ownershipOf(table);
  if (ownership.kind === "viaParent") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    return sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
  }
  if (ownership.kind === "authored") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    return sql`(${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId}) or ${ownership.authoredColumn} is distinct from ${ownership.reproducibleValue})`;
  }
  return eq(ownership.column, tenantId);
}

/** The column that carries a parent table's owner, for the `viaParent` subquery. */
function ownershipOwnerColumn(parent: Table): Column {
  const ownership = ownershipOf(parent);
  if (ownership.kind === "direct" || ownership.kind === "self") return ownership.column;
  // A parent that is itself owned through another parent would need a second
  // join level. No table in the contract has one; refuse rather than build a
  // filter that silently matches nothing (or everything).
  throw new Error(
    `${tableName(parent)} is not directly tenant-owned, so ownership cannot be resolved one level up`,
  );
}

/** Reads every row of one table that `tenantId` owns, encoded for JSON. */
async function exportTable(
  db: CartethyiaDatabase,
  table: Table,
  tenantId: string,
): Promise<BackupRow[]> {
  const index = columnIndex(table);
  const rows = (await db
    .select()
    .from(table)
    .where(ownedByFilter(table, tenantId))
    .limit(MAX_ROWS_PER_TABLE)) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const out: BackupRow = {};
    for (const [name, { key, dataType }] of index) out[name] = encodeCell(row[key], dataType);
    return out;
  });
}

/**
 * Snapshots the requested tables, grouped into their sections.
 *
 * Only `tenantId`'s own rows are read. The shared rows a backup needs in order
 * to be restorable — the built-in providers and their catalog — are not carried
 * because the build already supplies them (see `seedBundledProviders` /
 * `seedBundledModels`), so a payload never contains another tenant's data.
 */
export async function exportBackup(
  db: CartethyiaDatabase,
  tables: readonly Table[],
  tenantId: string,
): Promise<BackupExportResult> {
  const config: Record<string, readonly BackupRow[]> = {};
  const telemetry: Record<string, readonly BackupRow[]> = {};
  const counts: Record<string, number> = {};
  const configSet = new Set<Table>([...CONFIG_TABLES, TENANT_TABLE]);
  const telemetrySet = new Set<Table>(TELEMETRY_TABLES);

  for (const table of tables) {
    const rows = await exportTable(db, table, tenantId);
    const name = tableName(table);
    counts[name] = rows.length;
    if (configSet.has(table)) config[name] = rows;
    else if (telemetrySet.has(table)) telemetry[name] = rows;
  }

  const payload: BackupPayload = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sections: {
      ...(Object.keys(config).length > 0 ? { config } : {}),
      ...(Object.keys(telemetry).length > 0 ? { telemetry } : {}),
    },
  };
  return { counts, payload };
}

/** Builds a Drizzle row object from a payload row, coercing each cell. */
function toValues(table: Table, row: BackupRow): Record<string, unknown> {
  const index = columnIndex(table);
  const allowed = columnNames(table);
  const values: Record<string, unknown> = {};
  for (const [name, cell] of Object.entries(row)) {
    if (!allowed.has(name)) throw new Error(`${tableName(table)}.${name} is not a known column`);
    const entry = index.get(name);
    if (entry === undefined) continue;
    values[entry.key] = decodeCell(cell, entry.dataType);
  }
  return values;
}

/**
 * Natural key used to detect telemetry rows that are already stored.
 *
 * Built from the payload row only. The comparison against stored rows happens
 * in SQL (see {@link existingTelemetryKeys}) rather than by formatting both
 * sides in JS: the driver returns `timestamptz` through `db.execute` as a
 * string with microsecond precision and a numeric offset, which never equals
 * the ISO spelling the export wrote, so a JS-side comparison would silently
 * match nothing and every re-import would duplicate history.
 */
function telemetryKey(row: BackupRow): string {
  return `${String(row.tenant_id)}\u0000${String(row.request_id)}\u0000${createdAtIso(row.created_at)}`;
}

/** The ISO instant of an encoded date cell. */
function createdAtIso(value: unknown): string {
  if (typeof value === "object" && value !== null && "__date" in value) {
    return String((value as BackupDate).__date);
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Reads the natural keys of telemetry rows already present for the tenants in
 * the payload, so a re-import can skip them instead of double-counting history.
 *
 * The existing rows are matched by `(tenant_id, request_id)` and their
 * timestamps are normalised in SQL to the same ISO spelling the payload uses,
 * so the two sides are comparable regardless of how the driver types them.
 */
async function existingTelemetryKeys(
  db: CartethyiaDatabase,
  rows: readonly BackupRow[],
): Promise<Set<string>> {
  const tenantIds = [
    ...new Set(rows.map((row) => row.tenant_id).filter((id): id is string => typeof id === "string")),
  ];
  if (tenantIds.length === 0) return new Set();
  const existing = await db
    .select({
      tenantId: telemetryEvents.tenantId,
      requestId: telemetryEvents.requestId,
      createdAt: sql<string>`to_char(${telemetryEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(telemetryEvents)
    .where(inArray(telemetryEvents.tenantId, tenantIds));
  return new Set(existing.map((row) => `${row.tenantId}\u0000${row.requestId}\u0000${row.createdAt}`));
}

/**
 * Inserts a payload-shaped row into an arbitrary table.
 *
 * The values are validated against the table's real columns by {@link toValues}
 * before they get here, but Drizzle's insert builder is typed per table while
 * this module works over a `Table` chosen at runtime, so one cast is
 * unavoidable. It is confined to this helper rather than scattered across the
 * restore path.
 */
function insertRow(tx: CartethyiaDatabase, table: Table, values: Record<string, unknown>) {
  return tx.insert(table).values(values as never);
}

/**
 * Deletes the tenant's own rows from a table inside the transaction.
 *
 * Scoped by {@link ownedByFilter}, never table-wide. A table-wide delete here
 * is the bug this function exists to prevent: `providers` and `models` hold the
 * shared built-in catalog, and `provider_accounts` holds every tenant's
 * accounts, so clearing any of them would reach far outside the restoring
 * tenant.
 */
async function clearOwnedRows(
  tx: CartethyiaDatabase,
  table: Table,
  tenantId: string,
): Promise<void> {
  await tx.delete(table).where(ownedByFilter(table, tenantId));
}

/**
 * Inserts rows one at a time so a single bad row names its own failure.
 *
 * `conflictTarget` is supplied for tables a restore may not delete from: the
 * payload's rows are upserted by the table's unique key, so re-importing a
 * backup updates what is already there instead of failing on the first
 * duplicate.
 */
async function insertRows(
  tx: CartethyiaDatabase,
  table: Table,
  rows: readonly BackupRow[],
  options: {
    readonly skipKeys?: ReadonlySet<string>;
    readonly keyOf?: (row: BackupRow) => string;
    readonly conflictTarget?: readonly Column[];
  } = {},
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    if (options.skipKeys !== undefined && options.keyOf !== undefined && options.skipKeys.has(options.keyOf(row))) {
      continue;
    }
    const values = toValues(table, row);
    if (Object.keys(values).length === 0) continue;
    const statement = insertRow(tx, table, values);
    if (options.conflictTarget === undefined) {
      await statement;
    } else {
      // Every column the payload carries is written, so a re-import restores
      // the file's state rather than leaving stale values behind. `excluded`
      // is the row that failed to insert, and the column names come from the
      // schema rather than from the JS key — guessing the database spelling
      // from a camelCase key breaks the moment the two differ.
      const names = new Map(
        Object.entries(getTableColumns(table)).map(([key, column]) => [key, column.name]),
      );
      await statement.onConflictDoUpdate({
        target: options.conflictTarget as never,
        set: Object.fromEntries(
          Object.keys(values).map((key) => {
            const name = names.get(key);
            if (name === undefined) throw new Error(`${tableName(table)} has no column ${key}`);
            return [key, sql.raw(`excluded."${name}"`)];
          }),
        ) as never,
      });
    }
    inserted += 1;
  }
  return inserted;
}

/**
 * Applies a pre-validated restore inside one transaction.
 *
 * `order` is children-before-parents for the config tables. The tenant row is
 * upserted first and never deleted — every tenant-scoped table cascades from
 * `tenants`, including `telemetry_events`, `console_users`, and
 * `console_sessions`, so replacing it would destroy the usage history this
 * feature preserves and log out every console user.
 *
 * Every write is scoped to `tenantId`. A table the payload does not mention is
 * left completely alone — not cleared — so a partial import (a router export
 * carries accounts but no built-in provider rows) cannot empty the tables it
 * happens to omit. The rule is "replace what the file describes", and even then
 * only the rows this tenant owns.
 */
export async function applyRestore(
  db: CartethyiaDatabase,
  validation: ValidatedRestore,
  order: readonly Table[],
  tenantId: string,
): Promise<{ restored: Record<string, number>; skipped: Record<string, number> }> {
  const restored: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  await db.transaction(async (tx) => {
    const scoped = tx as unknown as CartethyiaDatabase;

    // The tenant row is ensured, never replaced: it almost always exists, and
    // its PK is `id`, so a conflict means "already there" rather than an error.
    // The payload's tenant is forced to the restoring tenant — a payload naming
    // someone else's tenant id must not create or claim that tenant.
    if (validation.tenantRows.length > 0) {
      let inserted = 0;
      for (const row of validation.tenantRows) {
        const values = toValues(TENANT_TABLE, row);
        if (Object.keys(values).length === 0) continue;
        const result = await insertRow(scoped, TENANT_TABLE, { ...values, id: tenantId })
          .onConflictDoNothing()
          .returning({ id: sql<number>`1` });
        inserted += result.length;
      }
      restored["tenants"] = inserted;
    }

    const replaceTables = order.filter(
      (table) => validation.tables.get(table)?.mode === "replace" && table !== TENANT_TABLE,
    );
    const appendTables = order.filter(
      (table) => validation.tables.get(table)?.mode === "append",
    );

    // An empty array describes nothing, so there is nothing to replace. Clearing
    // a table because the payload mentions it with zero rows is how a restore
    // deletes data the file never spoke about: a config-only file that carries
    // `provider_accounts: []` — a router export with no connections, an export
    // taken before any account existed — would empty the tenant's accounts. The
    // file's silence is not an instruction to delete. A non-empty array still
    // replaces the tenant's rows, which is what "restore my configuration" means.
    for (const table of replaceTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined || entry.rows.length === 0) continue;
      if (replaceModeOf(table) === "delete") await clearOwnedRows(scoped, table, tenantId);
    }

    // Insert parents before children.
    for (const table of [...replaceTables].reverse()) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      const ownership = ownershipOf(table);
      restored[tableName(table)] = await insertRows(scoped, table, entry.rows, {
        ...(ownership.kind === "authored" ? { conflictTarget: ownership.keyColumns } : {}),
      });
    }

    // Telemetry merges: existing natural keys are read once, duplicates skipped.
    for (const table of appendTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      if (table === telemetryEvents) {
        const existing = await existingTelemetryKeys(scoped, entry.rows);
        restored[tableName(table)] = await insertRows(scoped, table, entry.rows, {
          skipKeys: existing,
          keyOf: telemetryKey,
        });
        skipped[tableName(table)] = entry.rows.filter((row) =>
          existing.has(telemetryKey(row)),
        ).length;
      } else {
        restored[tableName(table)] = await insertRows(scoped, table, entry.rows);
      }
    }
  });

  return { restored, skipped };
}

/** Whether a table is the tenant row, which restore upserts instead of replacing. */
export function isTenantTable(table: Table): boolean {
  return table === TENANT_TABLE;
}

export { and, eq };

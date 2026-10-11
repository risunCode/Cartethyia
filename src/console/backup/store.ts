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
import { and, eq, sql } from "drizzle-orm";
import { gzipSync, gunzipSync } from "node:zlib";
import { differsFrom } from "../../persistence/dialect";
import { readTelemetryEvents, TELEMETRY_EVENT_DIR } from "../../observability/event-log";
import { appendFile, mkdir } from "node:fs/promises";
import { getTableColumns, type Column, type SQL, type Table } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import {
  apiKeys,
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  consoleUsers,
  healthEvents,
  modelAliases,
  modelCombos,
  models,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerOauthStates,
  providerRoutingSettings,
  providers,
  shareLinks,
  sharePopups,
  tenantDisabledModels,
  telemetryEvents,
  telemetryUsageTotals,
} from "../../persistence/schema";
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
  payloadNameOf,
  sealedColumns,
  tableName,
  type BackupBytes,
  type BackupDate,
  type BackupExportResult,
  type BackupPayload,
  type BackupRow,
  type ValidatedRestore,
} from "./contracts";

/** The driver's `Buffer` view of a `bytea` cell, or null when it holds none. */
function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

/**
 * A sealed column, as the payload carries it: the plaintext.
 *
 * The ciphertext is deliberately *not* what travels — see
 * {@link sealedColumns} for why. Ciphertext this install's key cannot open
 * (sealed before a key rotation, or copied in from another install's database)
 * exports as null rather than as its bytes: writing those bytes as text would
 * put an unopenable string in the file, which a restore would then re-seal as
 * though it were the secret itself.
 */
function decodeSealedForPayload(value: unknown): string | null {
  const bytes = toBuffer(value);
  if (bytes === null) return null;
  try {
    return decryptCredentialToString(bytes);
  } catch {
    return null;
  }
}

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
    const bytes = toBuffer(value);
    if (bytes === null) return null;
    return { __bytes: bytes.toString("base64") } satisfies BackupBytes;
  }
  return value;
}
/**
 * Adds the `providerConnections` block a router export carries.
 *
 * The row tables above are the restore path; this block is the interchange
 * shape another Cartethyia install (or a router migration) reads accounts from,
 * so it keeps its own field names — `accessToken`, not
 * `credential_ciphertext`. Both are built from the same decrypted values, so
 * there is one decode and two projections of it rather than a second read.
 */
function attachOauthSecrets(
  config: Record<string, readonly BackupRow[]>,
): readonly Record<string, unknown>[] | undefined {
  const accounts = config.provider_accounts;
  const states = config.provider_oauth_states;
  if (!Array.isArray(accounts)) return undefined;
  const byAccount = new Map((states ?? []).map((state) => [String(state.provider_account_id), state]));
  return accounts.map((account) => {
    const state = byAccount.get(String(account.id));
    return {
      id: account.id,
      provider: account.provider_id,
      authType: account.credential_kind,
      name: account.label,
      accessToken: account.access_token ?? null,
      refreshToken: state?.refresh_token ?? null,
      clientSecret: state?.client_secret ?? null,
      expiresAt: dateText(state?.expires_at),
      isActive: account.status === "active",
      createdAt: dateText(account.created_at),
      providerSpecificData: account.auth_state ?? {},
    };
  });
}

function dateText(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("__date" in value)) return null;
  const date = value.__date;
  return typeof date === "string" ? date : null;
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
 *
 * The second arm is scoped to a **shared** parent on purpose. "Not
 * reproducible from the build" alone is not evidence of authorship: another
 * tenant's provider can also carry a probed model, and reading it into this
 * tenant's backup would both leak that tenant's catalog and produce a restore
 * that inserts a `models` row whose `provider_id` this tenant does not own —
 * a foreign-key violation. Authorship therefore requires that the row hangs
 * off a provider nobody owns, or off this tenant's own provider.
 */
function ownedByFilter(table: Table, tenantId: string): SQL {
  const ownership = ownershipOf(table);
  if (ownership.kind === "viaParent") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    return sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
  }
  if (ownership.kind === "authored") {
    const parentOwner = ownershipOwnerColumn(ownership.parent);
    const mine = sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} = ${tenantId})`;
    const shared = sql`${ownership.column} in (select ${ownership.parentColumn} from ${ownership.parent} where ${parentOwner} is null)`;
    const unreproducible = differsFrom(sql`${ownership.authoredColumn}`, sql`${ownership.reproducibleValue}`);
    return sql`(${mine} or (${shared} and ${unreproducible}))`;
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
  const sealed = sealedColumns(table);
  const rows = (await db
    .select()
    .from(table)
    .where(ownedByFilter(table, tenantId))
    .limit(MAX_ROWS_PER_TABLE)) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const out: BackupRow = {};
    for (const [name, { key, dataType }] of index) {
      // A sealed column is written decrypted, under the name of the secret it
      // holds — see `SEALED_COLUMNS` for why the column's own name would be a
      // lie in a file that no longer carries its ciphertext.
      out[payloadNameOf(table, name)] = sealed.has(name)
        ? decodeSealedForPayload(row[key])
        : encodeCell(row[key], dataType);
    }
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
    const rows = table === telemetryEvents
      ? await exportEventFile(tenantId)
      : await exportTable(db, table, tenantId);
    const name = tableName(table);
    counts[name] = rows.length;
    if (configSet.has(table)) config[name] = rows;
    else if (telemetrySet.has(table)) telemetry[name] = rows;
  }
  // Always built: the row tables above now always carry the credentials
  // decrypted, so the projection is always complete. It used to be conditional
  // on the export being "raw", which made a plain JSON export carry a block of
  // null tokens — a router migration from it produced accounts with no
  // credential at all.
  const providerConnections = attachOauthSecrets(config);
  const payload: BackupPayload = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sections: {
      ...(Object.keys(config).length > 0 ? { config } : {}),
      ...(Object.keys(telemetry).length > 0 ? { telemetry } : {}),
    },
    ...(providerConnections === undefined ? {} : { providerConnections }),
  };
  return { counts, payload };
}
/**
 * Gzips a backup payload.
 *
 * `compressed` is a property of the *file*, and of nothing else: the payload is
 * the same object either way. It used to also mean "decrypt the credentials",
 * which coupled a transport choice to a security decision and left the plain
 * JSON export carrying ciphertext no other install could open.
 */
export function compressBackup(payload: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

/** The gzip magic, so a file can be recognised without trusting its name. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** Whether `bytes` starts with the gzip magic. */
export function isGzipBytes(bytes: Uint8Array): boolean {
  return GZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Undoes {@link compressBackup}.
 *
 * A restore has to accept the file the export actually produces. The dashboard
 * offers a compressed download and names it `.json.gz`, and until now that file
 * could not be restored at all: the import path read the body as JSON text and
 * `JSON.parse` of gzip bytes fails, so the operator's own backup — the only one
 * they had — was rejected as "not a JSON backup".
 *
 * A file that is not gzipped is returned unchanged rather than refused, because
 * a plain `.json` export is equally restorable and the bytes are the only thing
 * that distinguishes them.
 */
export function decompressBackup(bytes: Uint8Array): string {
  if (!isGzipBytes(bytes)) return Buffer.from(bytes).toString("utf8");
  try {
    return gunzipSync(bytes).toString("utf8");
  } catch (error) {
    throw new Error(
      `that file is named or marked as gzip but could not be decompressed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Exports per-request events from the file log, shaped like the table the
 * backup contract still names. The table is no longer written, so reading it
 * would export nothing.
 */
async function exportEventFile(tenantId: string): Promise<readonly BackupRow[]> {
  const events = await readTelemetryEvents();
  return events
    .filter((event) => event.tenantId === tenantId)
    .slice(0, MAX_ROWS_PER_TABLE)
    .map((event) => {
      const row: BackupRow = {};
      for (const [key, value] of Object.entries(event)) {
        if (value === null || value === undefined) continue;
        row[camelToSnake(key)] = key === "createdAt" ? { __date: String(value) } : value;
      }
      return row;
    });
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/**
 * Re-seals one secret column under **this** install's key.
 *
 * The payload carries the plaintext (see {@link sealedColumns}), so every
 * restore writes ciphertext the importing install can actually open. This is
 * the step whose absence destroyed the receiving install's credentials: the
 * file's bytes were inserted verbatim after the install's own rows had been
 * deleted, so the restored configuration held secrets sealed under a key that
 * was not in the room.
 *
 * A null cell is null again — every sealed column is nullable, and "this
 * account has no stored credential" is a state the schema has to represent.
 * Validation drops any other non-string cell before it gets here, so a
 * non-string is a contract break rather than a case to coerce.
 */
function sealSecret(value: unknown, table: string, column: string): Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`${table}.${column} must be restored as a plaintext string, got ${typeof value}`);
  }
  return encryptCredential(value);
}

/** Builds a Drizzle row object from a payload row, coercing each cell. */
function toValues(table: Table, row: BackupRow): Record<string, unknown> {
  const index = columnIndex(table);
  const allowed = columnNames(table);
  const sealed = sealedColumns(table);
  const name = tableName(table);
  const values: Record<string, unknown> = {};
  for (const [column, cell] of Object.entries(row)) {
    if (!allowed.has(column)) throw new Error(`${name}.${column} is not a known column`);
    const entry = index.get(column);
    if (entry === undefined) continue;
    values[entry.key] = sealed.has(column)
      ? sealSecret(cell, name, column)
      : decodeCell(cell, entry.dataType);
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
/** Natural keys already present in the event file, so a re-import skips them. */
async function existingEventFileKeys(rows: readonly BackupRow[]): Promise<Set<string>> {
  const wanted = new Set(rows.map((row) => row.request_id).filter((id): id is string => typeof id === "string"));
  if (wanted.size === 0) return new Set();
  const events = await readTelemetryEvents();
  return new Set(
    events
      .filter((event) => wanted.has(event.requestId))
      .map((event) => `${event.tenantId ?? ""}\u0000${event.requestId}\u0000${event.createdAt}`),
  );
}

/** Appends restored events to the file log, in the shape the writer uses. */
async function appendRestoredEvents(rows: readonly BackupRow[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(TELEMETRY_EVENT_DIR, { recursive: true });
  const lines = rows.map((row) => JSON.stringify(snakeToCamelRecord(row)));
  await appendFile(`${TELEMETRY_EVENT_DIR}/restored.jsonl`, `${lines.join("\n")}\n`, "utf8");
}

function snakeToCamelRecord(row: BackupRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
    out[camel] = isDateCell(value) ? value.__date : value;
  }
  return out;
}

function isDateCell(value: unknown): value is BackupDate {
  return typeof value === "object" && value !== null && "__date" in value;
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
    readonly ignoreConflicts?: boolean;
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
    if (options.ignoreConflicts) {
      if (options.conflictTarget === undefined)
        throw new Error(`ignoreConflicts requires a target for ${tableName(table)}`);
      const insertedRows = await statement
        .onConflictDoNothing({ target: options.conflictTarget as never })
        .returning();
      inserted += insertedRows.length;
      continue;
    }
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
 * `tenants`, including `telemetry_events`, `telemetry_usage_totals`,
 * `console_users`, and `console_sessions`, so replacing it would destroy the
 * usage history this feature preserves and log out every console user.
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
      const rows =
        table === apiKeys
          ? [...entry.rows].sort((left, right) => {
              const leftParent = left["parent_key_id"];
              const rightParent = right["parent_key_id"];
              const leftIsChild = leftParent !== null && leftParent !== undefined;
              const rightIsChild = rightParent !== null && rightParent !== undefined;
              return Number(leftIsChild) - Number(rightIsChild);
            })
          : entry.rows;
      restored[tableName(table)] = await insertRows(scoped, table, rows, {
        ...(ownership.kind === "authored" ? { conflictTarget: ownership.keyColumns } : {}),
      });
    }

    // Event rows use a natural idempotency key; lifetime totals insert once per
    // identity so re-importing an older backup cannot reduce newer counters.
    for (const table of appendTables) {
      const entry = validation.tables.get(table);
      if (entry === undefined) continue;
      if (table === telemetryEvents) {
        const existing = await existingEventFileKeys(entry.rows);
        const fresh = entry.rows.filter((row) => !existing.has(telemetryKey(row)));
        await appendRestoredEvents(fresh);
        restored[tableName(table)] = fresh.length;
        skipped[tableName(table)] = entry.rows.length - fresh.length;
      } else if (table === telemetryUsageTotals) {
        const restoredCount = await insertRows(scoped, table, entry.rows, {
          conflictTarget: [
            telemetryUsageTotals.tenantId,
            telemetryUsageTotals.identityType,
            telemetryUsageTotals.entityId,
          ],
          ignoreConflicts: true,
        });
        restored[tableName(table)] = restoredCount;
        skipped[tableName(table)] = entry.rows.length - restoredCount;
      } else {
        restored[tableName(table)] = await insertRows(scoped, table, entry.rows);
      }
    }
  });

  return { restored, skipped };
}

export const DELETE_ALL_SCOPES = ["providers", "proxies", "configuration"] as const;
export type DeleteAllScope = (typeof DELETE_ALL_SCOPES)[number];

export interface DeleteAllResult {
  readonly deleted: Record<string, number>;
  readonly apiKeyIds: readonly string[];
}

/**
 * Deletes selected tenant configuration scopes in one transaction. The lists
 * are explicit and ordered child-first; no table-wide delete is permitted.
 */
export async function deleteAll(
  db: CartethyiaDatabase,
  scopes: readonly DeleteAllScope[],
  tenantId: string,
): Promise<DeleteAllResult> {
  const selected = new Set(scopes);
  if (selected.size === 0) throw new Error("at least one delete scope is required");
  for (const scope of selected) {
    if (scope !== "providers" && scope !== "proxies" && scope !== "configuration") {
      throw new Error(`unknown delete scope ${scope}`);
    }
  }
  const all = selected.has("configuration");
  // `configuration` is the destructive superset: it includes provider and proxy
  // routing because those are configuration, not runtime history.
  const providersSelected = all || selected.has("providers");
  const proxiesSelected = all || selected.has("proxies");
  const deleted: Record<string, number> = {};
  const apiKeyIds: string[] = [];

  await db.transaction(async (tx) => {
    const scoped = tx as unknown as CartethyiaDatabase;
    const remove = async (table: Table, filter: SQL, name = tableName(table)): Promise<void> => {
      const rows = await scoped.delete(table).where(filter).returning();
      if (rows.length > 0) deleted[name] = (deleted[name] ?? 0) + rows.length;
    };
    const direct = (table: Table): SQL => ownedByFilter(table, tenantId);

    if (proxiesSelected) {
      await remove(healthEvents, sql`${healthEvents.networkPoolId} in (select ${networkPools.id} from ${networkPools} where ${networkPools.tenantId} = ${tenantId})`);
      await remove(networkPools, direct(networkPools));
      await remove(poolRoutingSettings, direct(poolRoutingSettings));
    }

    if (providersSelected) {
      await remove(healthEvents, sql`${healthEvents.accountId} in (select ${providerAccounts.id} from ${providerAccounts} where ${providerAccounts.tenantId} = ${tenantId})`);
      await remove(providerOauthStates, sql`${providerOauthStates.providerAccountId} in (select ${providerAccounts.id} from ${providerAccounts} where ${providerAccounts.tenantId} = ${tenantId})`);
      await remove(providerAccounts, direct(providerAccounts));
      await remove(tenantDisabledModels, direct(tenantDisabledModels));
      await remove(models, sql`${models.providerId} in (select ${providers.id} from ${providers} where ${providers.tenantId} = ${tenantId})`);
      await remove(providerRoutingSettings, direct(providerRoutingSettings));
      await remove(providers, direct(providers));
    }

    if (all || selected.has("configuration")) {
      await remove(cliToolMappings, direct(cliToolMappings));
      await remove(cliToolSettings, direct(cliToolSettings));
      await remove(sharePopups, sql`${sharePopups.apiKeyId} in (select ${apiKeys.id} from ${apiKeys} where ${apiKeys.tenantId} = ${tenantId})`);
      await remove(shareLinks, sql`${shareLinks.apiKeyId} in (select ${apiKeys.id} from ${apiKeys} where ${apiKeys.tenantId} = ${tenantId})`);
      const keys = await scoped.delete(apiKeys).where(direct(apiKeys)).returning({ id: apiKeys.id });
      if (keys.length > 0) {
        apiKeyIds.push(...keys.map((row) => row.id));
        deleted["api_keys"] = (deleted["api_keys"] ?? 0) + keys.length;
      }
      await remove(modelAliases, direct(modelAliases));
      await remove(modelCombos, direct(modelCombos));
      await remove(consoleUsers, direct(consoleUsers));
      await remove(consoleSettings, direct(consoleSettings));
    }
  });

  return { deleted, apiKeyIds };
}

export { and, eq };

/**
 * Backup payload contract: what a backup contains, and the allowlists that
 * bound what a restore may write.
 *
 * Two sections, and the split is the point:
 * - `config` — the rows that decide where traffic goes and with which
 *   credential (providers, models, accounts, keys, aliases, combos, pools).
 * - `telemetry` — per-request metadata plus durable per-key/account lifetime aggregates.
 *
 * `telemetry_payloads` is deliberately **not** restorable and never exported:
 * it holds captured prompt/response bodies. The user asked for metadata-only
 * history, and a backup is a file that gets copied around, so bodies stay out
 * of it. A backup is therefore not a substitute for a database dump, and the
 * layer doc says so. Browser-only playground state is excluded because it is
 * tenant-owned saved work; health events remain derived runtime history.
 *
 * A backup carries provider credentials and API-key hashes because that *is*
 * the configuration — the same secret material the dashboard already hands the
 * operator. Export is plain JSON at the user's explicit request, so the file is
 * as sensitive as the database.
 */
import { getTableColumns, getTableName, type Column, type Table } from "drizzle-orm";
import {
  apiKeys,
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
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
  tenants,
  telemetryEvents,
  telemetryUsageTotals,
} from "../../persistence/schema";

export const BACKUP_APP = "cartethyia";
export const BACKUP_VERSION = 1;

/** Upper bound for restore payloads; the listener enforces the same ceiling. */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024 * 1024;

/** Defense-in-depth row cap per table, after the byte bound. */
export const MAX_ROWS_PER_TABLE = 500_000;

/**
 * Config tables a restore may replace, children before parents.
 *
 * The order is not cosmetic: restore deletes in this order and inserts in
 * reverse, so a foreign key never points at a row that is not there yet. Tables
 * holding session/audit/runtime state are absent on purpose — a config restore
 * must not log everyone out, and audit history is not configuration.
 *
 * `console_users` is absent for the same reason a restore must not touch the
 * install's encryption: sign-in accounts belong to the install being restored
 * *into*, not to the file. Restoring the exported admin's username and password
 * hash would hand the recovering operator whatever credential the old install
 * had — including one they never chose — and would fail closed on a fresh
 * install whose hash was written by a different build. A first-boot restore
 * therefore restores the configuration and leaves the wizard to create the
 * administrator (see `setup-service.ts`).
 *
 * Every table here must also declare its owner in {@link ownershipOf}. A
 * restore replaces rows; it may only replace rows the restoring tenant owns, and
 * a table whose ownership is undeclared makes the restore fail rather than fall
 * back to clearing it.
 *
 * `tenants` is deliberately NOT here. See {@link TENANT_TABLE}.
 */
export const CONFIG_TABLES = [
  sharePopups,
  shareLinks,
  providerOauthStates,
  tenantDisabledModels,
  models,
  providerRoutingSettings,
  providerAccounts,
  poolRoutingSettings,
  networkPools,
  providers,
  modelAliases,
  modelCombos,
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  apiKeys,
] as const satisfies readonly Table[];

/**
 * The tenant row, upserted and never deleted.
 *
 * Every tenant-scoped table cascades from `tenants`, and several of those are
 * **not** part of a config backup: `telemetry_events`,
 * `telemetry_usage_totals`, `telemetry_payloads`, and `console_sessions`.
 * Deleting the tenant
 * to re-insert it would therefore destroy the usage history this feature exists
 * to preserve — and log out every console user as a side effect. A restore
 * ensures the tenant exists (needed when importing into a fresh database) and
 * leaves its identity alone.
 */
export const TENANT_TABLE = tenants;

/** Restorable metadata events and durable lifetime totals; payloads are excluded. */
export const TELEMETRY_TABLES = [telemetryEvents, telemetryUsageTotals] as const satisfies readonly Table[];

/**
 * Every column sealed with this install's `CARTETHYIA_ENCRYPTION_KEY`.
 *
 * A backup is meant to move between installations, and sealed ciphertext is not:
 * the bytes are opened only by the key that wrote them, so copying them into an
 * install with a different key yields a credential no local code can ever read
 * again. That is the defect this table exists to end — a restore used to insert
 * the exported bytes verbatim, after first deleting the receiving install's own
 * working credentials, which left every provider in the restored configuration
 * unopenable and the new install's encryption destroyed.
 *
 * So a payload carries these columns **decrypted**, under the alias below, and a
 * restore re-seals them under the key of the install it is writing into (export:
 * `store.exportTable`, import: `store.toValues`). The file is as sensitive as the
 * database either way — it always carried the plaintext API keys and the OAuth
 * tokens they authorize — so this changes what a reader of the file sees, not
 * what a reader of the database already had.
 *
 * The alias is not decoration. `"credential_ciphertext": "ya29.a0Af…"` names the
 * cell for what it used to be rather than what it now holds, and a reader who
 * trusts that name believes the file carries ciphertext it does not have —
 * including whoever is debugging why a restored credential will not open. The
 * column's own name stays in the schema, where it belongs.
 *
 * Keyed per table rather than by column name, because `credential_ciphertext`
 * exists in two tables and means different things in each: an account's access
 * token is not a proxy's credential.
 *
 * The one `bytea` column absent from here is `share_popups.image`: a PNG or JPEG
 * the operator uploaded, opaque to this table, and it travels verbatim. Every
 * other `bytea` column in the schema is here, so a new sealed column has to be
 * added rather than discovered as the next broken restore.
 */
const SEALED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  provider_accounts: { credential_ciphertext: "access_token" },
  provider_oauth_states: {
    refresh_ciphertext: "refresh_token",
    client_secret_ciphertext: "client_secret",
  },
  network_pools: { credential_ciphertext: "proxy_credential" },
  api_keys: { key_encrypted: "api_key" },
  share_links: { token_encrypted: "share_token" },
};

/** The sealed columns of `table`, by column name. */
export function sealedColumns(table: Table): ReadonlySet<string> {
  return new Set(Object.keys(SEALED_COLUMNS[getTableName(table)] ?? {}));
}

/**
 * The name a column travels under in a payload.
 *
 * Returns the column's own name for anything not sealed, so an export loop does
 * not have to branch on the answer.
 */
export function payloadNameOf(table: Table, column: string): string {
  return SEALED_COLUMNS[getTableName(table)]?.[column] ?? column;
}

/**
 * A payload's secret names for `table`, mapped to the columns they fill.
 *
 * The inverse of {@link payloadNameOf}, and the one place a payload row is
 * translated back into schema columns. It is what makes a payload portable in
 * both directions: the export writes `access_token`, and a restore reads it as
 * `credential_ciphertext` and seals it under its own key.
 *
 * An alias that is also a real column is dropped rather than mapped — the schema
 * wins, because a row is validated against it.
 */
export function sealedAliases(table: Table): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const allowed = columnNames(table);
  for (const [column, alias] of Object.entries(SEALED_COLUMNS[getTableName(table)] ?? {})) {
    if (!allowed.has(alias)) out.set(alias, column);
  }
  return out;
}


/**
 * Which rows of a table belong to one tenant, and how a restore replaces them.
 *
 * A restore is performed by one tenant and may only replace that tenant's own
 * rows. Everything else — the built-in catalog and every shared row, which are
 * stored with `tenant_id IS NULL`, and every other tenant's rows — is outside
 * its reach and must survive untouched. Declaring ownership here, rather than
 * deciding it per call site, is what makes that checkable: a table added to
 * {@link CONFIG_TABLES} without an owner throws instead of being cleared.
 *
 * - `direct` — the table carries `tenant_id`, so the tenant owns exactly the
 *   rows whose value equals its id. A `NULL` in that column is a shared row
 *   (a pool-wide account, a built-in provider) and belongs to nobody.
 * - `viaParent` — the table has no tenant column, and a row belongs to the
 *   tenant exactly when the row it hangs off does. The parent is the foreign
 *   key the schema already declares, and the parent is itself tenant-owned, so
 *   the chain bottoms out at a `tenant_id` comparison.
 * - `authored` — the table mixes the tenant's own rows with shared ones and no
 *   single column separates them, so a row counts as the tenant's when either
 *   the parent it hangs off is the tenant's, *or* the row is not reproducible
 *   from the build. `models` is this case: a model row under a tenant-owned
 *   provider is plainly the tenant's, and a row under a built-in provider is
 *   still the tenant's work when its `source` is not the value the boot seeder
 *   stamps — a probe result cannot be replayed from a build, so a backup must
 *   carry it. This is also why such a table is never cleared: the shared rows
 *   in it belong to other tenants too, so a restore only upserts the keys the
 *   payload names.
 * - `self` — the tenant row itself, matched on its own id, upserted and never
 *   deleted.
 */
export type TableOwnership =
  | { readonly kind: "direct"; readonly column: Column; readonly replace: "delete" | "upsert" }
  | {
      readonly kind: "viaParent";
      readonly column: Column;
      readonly parent: Table;
      readonly parentColumn: Column;
      readonly replace: "delete" | "upsert";
    }
  | {
      readonly kind: "authored";
      readonly column: Column;
      readonly parent: Table;
      readonly parentColumn: Column;
      readonly authoredColumn: Column;
      readonly reproducibleValue: string;
      /** The unique index a restore upserts on, since it never deletes here. */
      readonly keyColumns: readonly Column[];
    }
  | { readonly kind: "self"; readonly column: Column };

/**
 * Tables whose rows belong to whoever owns the row they point at. The pair is
 * the child's foreign key column and the parent's referenced column, both
 * already declared by the schema.
 */
const INHERITED_OWNERSHIP: ReadonlyMap<
  Table,
  { column: string; parent: Table; parentColumn: string; replace: "delete" | "upsert" }
> = new Map<Table, { column: string; parent: Table; parentColumn: string; replace: "delete" | "upsert" }>([
  [
    providerOauthStates,
    {
      column: "provider_account_id",
      parent: providerAccounts,
      parentColumn: "id",
      replace: "delete",
    },
  ],
  [sharePopups, { column: "api_key_id", parent: apiKeys, parentColumn: "id", replace: "delete" }],
  [shareLinks, { column: "api_key_id", parent: apiKeys, parentColumn: "id", replace: "delete" }],
]);

/**
 * Tables that mix the tenant's own rows with shared ones.
 *
 * `reproducibleValue` is the `source` marker the boot seeder stamps on the rows
 * it owns and reconciles on every start, so a row carrying it can be rebuilt
 * from the bundled catalog and does not need to travel in a backup. Everything
 * else in the table came from a tenant action — a probe, or a manual add.
 */
const AUTHORED_OWNERSHIP: ReadonlyMap<
  Table,
  {
    column: string;
    parent: Table;
    parentColumn: string;
    authoredColumn: string;
    reproducibleValue: string;
    keyColumns: readonly string[];
  }
> = new Map([
  [
    models,
    {
      column: "provider_id",
      parent: providers,
      parentColumn: "id",
      authoredColumn: "source",
      reproducibleValue: "builtin",
      keyColumns: ["provider_id", "model_id", "endpoint_path"],
    },
  ],
]);

/** The column named `tenant_id` on a table, when it has one. */
function tenantColumnOf(table: Table): Column | undefined {
  return Object.values(getTableColumns(table)).find((column) => column.name === "tenant_id");
}

/** The column with this database name, which the schema guarantees exists. */
function columnNamed(table: Table, name: string): Column {
  const column = Object.values(getTableColumns(table)).find((entry) => entry.name === name);
  if (column === undefined) throw new Error(`${tableName(table)} has no column named ${name}`);
  return column;
}

/**
 * How `table`'s rows are attributed to a tenant.
 *
 * Throws for a table that carries no `tenant_id` and has no declared owner: a
 * restore that cannot tell which rows are the tenant's must refuse to run
 * rather than guess, because guessing here means deleting rows that belong to
 * someone else.
 */
export function ownershipOf(table: Table): TableOwnership {
  if (table === TENANT_TABLE) return { kind: "self", column: columnNamed(TENANT_TABLE, "id") };
  const inherited = INHERITED_OWNERSHIP.get(table);
  if (inherited !== undefined) {
    return {
      kind: "viaParent",
      column: columnNamed(table, inherited.column),
      parent: inherited.parent,
      parentColumn: columnNamed(inherited.parent, inherited.parentColumn),
      replace: inherited.replace,
    };
  }
  const authored = AUTHORED_OWNERSHIP.get(table);
  if (authored !== undefined) {
    return {
      kind: "authored",
      column: columnNamed(table, authored.column),
      parent: authored.parent,
      parentColumn: columnNamed(authored.parent, authored.parentColumn),
      authoredColumn: columnNamed(table, authored.authoredColumn),
      reproducibleValue: authored.reproducibleValue,
      keyColumns: authored.keyColumns.map((name) => columnNamed(table, name)),
    };
  }
  const column = tenantColumnOf(table);
  if (column === undefined) {
    throw new Error(
      `${tableName(table)} has no tenant_id and no declared owner, so a restore cannot tell which rows it may replace`,
    );
  }
  return { kind: "direct", column, replace: "delete" };
}

/**
 * How a restore may remove rows that the payload does not re-insert.
 *
 * `delete` clears the tenant's rows in the table and inserts the payload's —
 * correct when every row in the table that is not the tenant's is a shared row
 * the payload re-ensures anyway.
 *
 * `upsert` never deletes. It is the only safe mode for a table that holds rows
 * belonging to other tenants, or rows the payload legitimately does not carry
 * (the built-in catalog), because a delete there would reach outside the
 * restoring tenant. A row that the tenant removed locally but that the payload
 * still lists is re-created; a row the tenant added locally is left alone.
 */
export function replaceModeOf(table: Table): "delete" | "upsert" {
  const ownership = ownershipOf(table);
  if (ownership.kind === "authored") return "upsert";
  if (ownership.kind === "self") return "upsert";
  return ownership.replace;
}

export type BackupSection = "config" | "telemetry";

export const BACKUP_SECTIONS: readonly BackupSection[] = ["config", "telemetry"];

export interface BackupPayload {
  readonly app: typeof BACKUP_APP;
  readonly version: number;
  readonly exportedAt: string;
  readonly sections: {
    readonly config?: Record<string, readonly BackupRow[]>;
    readonly telemetry?: Record<string, readonly BackupRow[]>;
  };
  /**
   * The interchange projection of `sections.config.provider_accounts`: one
   * connection per row, with the router export's field names.
   *
   * At the root rather than inside `sections`, because it is not a table. Every
   * key under `sections.config` is resolved against the live schema and reported
   * when it does not match, so a projection living there would be announced as an
   * unknown table on every single restore.
   */
  readonly providerConnections?: readonly Record<string, unknown>[];
}

/** One exported row: JSON-safe scalars only, so `JSON.stringify` round-trips. */
export type BackupRow = Record<string, unknown>;

/** Base64 carrier for a `bytea` column; JSON has no byte string. */
export interface BackupBytes {
  readonly __bytes: string;
}

/** Base64 carrier for an ISO timestamp, so a date survives the round trip. */
export interface BackupDate {
  readonly __date: string;
}

/**
 * Column names per table, read from the Drizzle schema at module load.
 *
 * Derived rather than hand-listed: a hand-maintained column allowlist is the
 * classic drift bug — a new column lands in the schema, nobody updates the
 * backup, and the column silently vanishes on restore. Reading the schema means
 * the allowlist is exactly the table's real columns, and a hostile payload can
 * still never name a column outside it.
 */
const COLUMN_CACHE = new WeakMap<Table, ReadonlySet<string>>();

export function tableName(table: Table): string {
  return getTableName(table);
}

export function columnNames(table: Table): ReadonlySet<string> {
  const cached = COLUMN_CACHE.get(table);
  if (cached) return cached;
  const names = new Set(Object.values(getTableColumns(table)).map((column) => column.name));
  COLUMN_CACHE.set(table, names);
  return names;
}

/**
 * Columns a backup may still name even though the schema dropped them.
 *
 * A backup is versioned, but a column can be dropped without bumping
 * {@link BACKUP_VERSION}: migrations apply forward over the same table, and the
 * export/restore round-trip is expected to survive across them. An older export
 * therefore legitimately carries columns that no longer exist — the per-account
 * `provider_accounts.max_inflight` (0029) and several retired `api_keys.*`
 * fields (0005/0016/0017/0018). Validation must not reject those: it skips them,
 * so a stale backup still restores rather than failing on a column that is, by
 * definition, no longer read. The value is dropped, not migrated — each retired
 * column's replacement lives elsewhere in the schema, and importing a dead
 * number back would be worse than omitting it.
 */
const LEGACY_DROPPED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  provider_accounts: ["max_inflight", "min_credit_balance", "last_remaining_credit", "last_remaining_percent"],
  provider_routing_settings: ["credit_floor", "credit_limit", "credit_limit_enabled", "bypass_proxy"],
  share_links: ["used_at"],
  api_keys: [
    "share_popup_enabled",
    "share_popup_image",
    "share_popup_image_mime",
    "share_popup_title",
    "share_popup_body",
    "model_allowlist",
    "model_denylist",
    "provider_allowlist",
    "share_popup_image_url",
    "share_popup_mode",
    "share_popup_action_label",
    "share_popup_action_url",
  ],
};

const DROPPED_CACHE = new WeakMap<Table, ReadonlySet<string>>();

/** Column names a table once carried and has since dropped, still accepted on restore. */
export function droppedColumns(table: Table): ReadonlySet<string> {
  const cached = DROPPED_CACHE.get(table);
  if (cached) return cached;
  const names = new Set(LEGACY_DROPPED_COLUMNS[tableName(table)] ?? []);
  DROPPED_CACHE.set(table, names);
  return names;
}

/** Every table this module can read or write, config and telemetry together. */
export function tablesForSection(section: BackupSection): readonly Table[] {
  return section === "config" ? [...CONFIG_TABLES, TENANT_TABLE] : TELEMETRY_TABLES;
}

export function findTable(section: BackupSection, name: string): Table | undefined {
  return tablesForSection(section).find((table) => tableName(table) === name);
}

export interface BackupExportResult {
  readonly payload: BackupPayload;
  readonly counts: Record<string, number>;
}

/**
 * One table's rows plus how the restore must treat them.
 *
 * `replace` is the config contract (delete the table, insert the payload).
 * `append` is the telemetry contract: importing history must never remove rows
 * that are already present, so those rows are inserted and conflicts skipped.
 */
export interface ValidatedTable {
  readonly table: Table;
  readonly mode: "replace" | "append";
  readonly rows: readonly BackupRow[];
}

export interface RestoreResult {
  readonly restored: Record<string, number>;
  readonly skipped: Record<string, number>;
}

/**
 * One part of a backup that could not be restored, and why.
 *
 * Reported, never thrown: a restore is partial by contract. An old export
 * legitimately names tables and columns that no longer exist, and the answer is
 * to recover the rest and say what was left out — not to lose the whole file.
 *
 * A warning names schema objects only. It never carries a cell value, so a
 * failed restore of a backup full of credentials cannot echo one.
 */
export interface RestoreWarning {
  /** The table the payload named, when the cause belongs to one. */
  readonly table?: string;
  /** The column that did not resolve, when the cause is a column. */
  readonly column?: string;
  /** Operator-facing cause. */
  readonly reason: string;
}

/** A payload that passed validation: tables resolved to real schema objects. */
export interface ValidatedRestore {
  readonly tables: ReadonlyMap<Table, ValidatedTable>;
  readonly tenantRows: readonly BackupRow[];
  readonly counts: Record<string, number>;
  /** What validation had to leave out. Empty means the whole file applied. */
  readonly warnings: readonly RestoreWarning[];
}

export type RestoreValidation =
  | { readonly ok: true; readonly value: ValidatedRestore }
  | { readonly ok: false; readonly error: string };

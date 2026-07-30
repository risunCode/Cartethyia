import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { INIT_SQL } from "../schema";

export interface Migration {
  version: number;
  name: string;
  destructive: boolean;
  up(database: Database): void;
}

interface TableColumn {
  name: string;
}

function hasColumn(database: Database, table: string, column: string): boolean {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as TableColumn[];
  return columns.some((entry) => entry.name === column);
}

function addColumnIfMissing(database: Database, table: string, column: string, ddl: string): void {
  if (!hasColumn(database, table, column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function dropLegacyTable(database: Database, table: string, legacyColumn: string, currentColumn: string): boolean {
  if (!hasColumn(database, table, legacyColumn) || hasColumn(database, table, currentColumn)) return false;
  database.exec(`DROP TABLE ${table}`);
  return true;
}

function hasTable(database: Database, table: string): boolean {
  return database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
}

function hasIndex(database: Database, name: string): boolean {
  return (database.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)) !== null;
}

function hasCurrentCredentialSchema(database: Database): boolean {
  return hasColumn(database, "api_keys", "key")
    && hasColumn(database, "provider_accounts", "credential")
    && hasColumn(database, "provider_accounts", "cooldown_until")
    && hasColumn(database, "provider_accounts", "cooldown_level")
    && hasColumn(database, "custom_providers", "credential")
    && hasColumn(database, "custom_providers", "headers_json")
    && hasTable(database, "account_model_locks")
    && hasIndex(database, "idx_provider_accounts_provider_priority");
}

function backupDatabaseFile(databasePath: string, version: number): void {
  if (!existsSync(databasePath)) return;
  copyFileSync(databasePath, `${databasePath}.bak-v${version}-${Date.now()}`);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "baseline",
    destructive: false,
    up: (database) => database.exec(INIT_SQL),
  },
  {
    version: 2,
    name: "custom-providers-headers-json",
    destructive: false,
    up: (database) => addColumnIfMissing(database, "custom_providers", "headers_json", "headers_json TEXT NOT NULL DEFAULT '{}'"),
  },
  {
    version: 3,
    name: "drop-legacy-credential-encryption",
    destructive: true,
    up: (database) => {
      const didDrop = [
        dropLegacyTable(database, "api_keys", "key_hash", "key"),
        dropLegacyTable(database, "provider_accounts", "credential_enc", "credential"),
        dropLegacyTable(database, "custom_providers", "credential_enc", "credential"),
      ].some(Boolean);
      if (didDrop) database.exec(INIT_SQL);
    },
  },
  {
    version: 4,
    name: "account-cooldowns",
    destructive: false,
    up: (database) => {
      addColumnIfMissing(database, "provider_accounts", "cooldown_until", "cooldown_until TEXT");
      addColumnIfMissing(database, "provider_accounts", "cooldown_level", "cooldown_level INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 5,
    name: "account-model-locks",
    destructive: false,
    up: (database) => database.exec(`
      CREATE TABLE IF NOT EXISTS account_model_locks (
        account_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        locked_until TEXT NOT NULL,
        PRIMARY KEY (account_id, model_id),
        FOREIGN KEY (account_id) REFERENCES provider_accounts(id) ON DELETE CASCADE
      )
    `),
  },
  {
    version: 6,
    name: "provider-account-pagination-index",
    destructive: false,
    up: (database) => database.exec("CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider_priority ON provider_accounts(provider, priority, name, id)"),
  },
  {
    version: 7,
    name: "api-key-acl-limits",
    destructive: false,
    up: (database) => {
      addColumnIfMissing(database, "api_keys", "monthly_token_limit", "monthly_token_limit INTEGER");
      addColumnIfMissing(database, "api_keys", "max_concurrent_requests", "max_concurrent_requests INTEGER");
      addColumnIfMissing(database, "api_keys", "model_denylist", "model_denylist TEXT");
    },
  },
  {
    version: 8,
    name: "model-studio-sessions",
    destructive: false,
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_studio_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          system_prompt TEXT NOT NULL DEFAULT '',
          messages_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      database.exec("CREATE INDEX IF NOT EXISTS idx_model_studio_sessions_updated ON model_studio_sessions(updated_at DESC)");
    },
  },
];

export const LATEST_MIGRATION_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Stamps databases already upgraded by the legacy initialization path so
 * migrations never replay a destructive transition against current data.
 */
export function stampInitialVersion(database: Database): void {
  const current = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== 0) return;
  if (hasCurrentCredentialSchema(database)) database.exec(`PRAGMA user_version = ${LATEST_MIGRATION_VERSION}`);
}

/** Applies every pending migration in order, backing up before destructive steps. */
export function runMigrations(database: Database, databasePath: string): void {
  stampInitialVersion(database);
  let current = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (migration.destructive) backupDatabaseFile(databasePath, migration.version);
    database.transaction(() => {
      migration.up(database);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    })();
    current = migration.version;
  }
}

/**
 * Backup export — JSON snapshot of the config tables (REQ-5).
 *
 * Contents follow the proposal: settings (single row, keeps login state),
 * api_keys, aliases, combos, pools, access, routing, accounts, filters and
 * custom providers. Runtime request logs are JSONL/in-memory and are never
 * included in a configuration backup.
 */

import { getDb } from "../db/client";

export const BACKUP_APP = "cartethyia";
export const BACKUP_VERSION = 1;

/** Config tables always included — settings, keys, routing, accounts, aliases. */
export const CONFIG_TABLES = [
  "settings",
  "api_keys",
  "model_aliases",
  "combos",
  "proxy_pools",
  "access_rules",
  "provider_routing",
  "provider_accounts",
  "filter_rules",
  "sanitizer_rules",
  "custom_providers",
] as const;

export type BackupTable = (typeof CONFIG_TABLES)[number];

export interface BackupPayload {
  app: "cartethyia";
  version: number;
  exportedAt: string;
  tables: Record<string, unknown>;
}

/** Export a JSON backup payload from the current database state. */
export function exportBackup(_includeHistory = false): BackupPayload {
  const db = getDb();
  const tables: Record<string, unknown> = {};

  for (const table of CONFIG_TABLES) {
    if (table === "settings") {
      // Single-row table → plain object (empty when missing).
      const row = db.query("SELECT * FROM settings WHERE id = 1").get();
      tables[table] = row ?? {};
    } else {
      tables[table] = db.query(`SELECT * FROM ${table}`).all();
    }
  }


  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

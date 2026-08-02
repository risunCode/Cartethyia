/**
 * Backup export — JSON snapshot of the config tables (REQ-5).
 *
 * Contents follow the proposal: settings (single row, keeps login state),
 * api_keys, aliases, combos, access, routing, accounts, combo eligibility
 * filters and custom providers. Runtime request logs are JSONL/in-memory
 * and are never included in a configuration backup.
 */

import { getDb } from "../db/client";

export const BACKUP_APP = "cartethyia";
export const BACKUP_VERSION = 1;

/** Config tables always included — settings, keys, routing, accounts, aliases. */
export const CONFIG_TABLES = [
  "settings",
  "api_keys",
  "share_links",
  "model_aliases",
  "combos",
  "access_rules",
  "provider_routing",
  "provider_accounts",
  "filter_rules",
  "custom_providers",
  "proxies",
  "proxy_settings",
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
  const tables = db.transaction(() => {
    const snapshot: Record<string, unknown> = {};

    for (const table of CONFIG_TABLES) {
      if (table === "settings" || table === "proxy_settings") {
        const row = db.query(`SELECT * FROM ${table} WHERE id = 1`).get();
        snapshot[table] = row ?? {};
      } else {
        snapshot[table] = db.query(`SELECT * FROM ${table}`).all();
      }
    }

    return snapshot;
  })();

  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables };
}

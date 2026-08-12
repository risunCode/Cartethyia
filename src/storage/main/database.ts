import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { sanitizeMessage } from "../../application/contracts";
import { CONFIG_SCHEMA_SQL, nowIso } from "./schema";
import type { PersistenceEnv } from "./env";

/** Owns lazy configuration database opening, compatibility repair, and deterministic close/reopen lifecycle. */
export function createConfigDatabase(env: PersistenceEnv) {
  let db: Database | null = null;
  let closed = false;
  const getDb = (): Database => {
    if (closed) throw new Error("configuration database is closed");
    if (db !== null) return db;
    try {
      mkdirSync(dirname(env.dbPath), { recursive: true });
      const opened = new Database(env.dbPath, { create: true });
      opened.exec("PRAGMA journal_mode=WAL");
      opened.exec("PRAGMA synchronous=FULL");
      opened.exec("PRAGMA foreign_keys=ON");
      opened.exec("PRAGMA busy_timeout=5000");
      try {
        const shareColumns = new Set((opened.prepare("PRAGMA table_info(share_links)").all() as { name: string }[]).map((column) => column.name));
        if (shareColumns.size > 0) {
          if (!shareColumns.has("kind")) opened.exec("ALTER TABLE share_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'monitor'");
          if (!shareColumns.has("expires_at")) opened.exec("ALTER TABLE share_links ADD COLUMN expires_at TEXT");
          if (!shareColumns.has("used_at")) opened.exec("ALTER TABLE share_links ADD COLUMN used_at TEXT");
        }
      } catch {}
      try {
        const columns = new Set((opened.prepare("PRAGMA table_info(account_model_locks)").all() as { name: string }[]).map((column) => column.name));
        if (columns.has("locked_until") && !columns.has("retry_at")) opened.exec("DROP TABLE IF EXISTS account_model_locks");
      } catch {}
      try {
        const columns = opened.prepare("PRAGMA table_info(proxies)").all() as { name: string }[];
        if (columns.length > 0 && !columns.some((column) => column.name === "created_at")) {
          opened.exec("ALTER TABLE proxies ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
          opened.query("UPDATE proxies SET created_at = ? WHERE created_at = ''").run(nowIso());
        }
      } catch {}
      try {
        const columns = opened.prepare("PRAGMA table_info(proxy_settings)").all() as { name: string }[];
        if (columns.length > 0 && !columns.some((column) => column.name === "web_search_preference")) opened.exec("ALTER TABLE proxy_settings ADD COLUMN web_search_preference TEXT NOT NULL DEFAULT 'auto'");
      } catch {}
      try {
        const columns = opened.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[];
        if (columns.length > 0 && !columns.some((column) => column.name === "disable_remote_mapping")) opened.exec("ALTER TABLE api_keys ADD COLUMN disable_remote_mapping INTEGER NOT NULL DEFAULT 0");
      } catch {}
      opened.exec(CONFIG_SCHEMA_SQL);
      try {
        const settingsRow = opened.query("SELECT settings_json FROM settings WHERE id = 1").get() as { settings_json: string } | null;
        if (settingsRow !== null) {
          const parsed = JSON.parse(settingsRow.settings_json) as Record<string, unknown>;
          const runtime = parsed.runtime;
          const runtimeRecord = runtime && typeof runtime === "object" && !Array.isArray(runtime)
            ? { ...(runtime as Record<string, unknown>) }
            : {};
          if (runtimeRecord.retentionDefaultsDisabledV1 !== true) {
            opened.query("UPDATE settings SET settings_json = ?, updated_at = ? WHERE id = 1")
              .run(JSON.stringify({ ...parsed, runtime: { ...runtimeRecord, trackPayloads: "none", trackAssets: "none", retentionDefaultsDisabledV1: true } }), nowIso());
          }
        }
      } catch {}
      try {
        const providers = opened.query("SELECT id, slug FROM custom_providers WHERE id <> slug").all() as Array<{ id: string; slug: string }>;
        for (const provider of providers) {
          opened.query("UPDATE provider_accounts SET provider = ? WHERE provider = ?").run(provider.slug, provider.id);
          opened.query("UPDATE provider_models SET provider = ? WHERE provider = ?").run(provider.slug, provider.id);
        }
        opened.exec("UPDATE provider_accounts SET credential = replace(replace(replace(replace(credential, char(10), ''), char(13), ''), char(9), ''), ' ', '') WHERE credential_kind = 'api_key'");
        opened.exec("UPDATE custom_providers SET credential = replace(replace(replace(replace(credential, char(10), ''), char(13), ''), char(9), ''), ' ', '')");
      } catch {}
      db = opened;
      return opened;
    } catch (error) {
      throw new Error(`configuration database unavailable: ${sanitizeMessage(error instanceof Error ? error.message : "open failed")}`);
    }
  };
  const closeDatabase = (reopenable: boolean): void => {
    if (!reopenable && closed) return;
    if (db !== null) {
      try { db.exec("ROLLBACK"); } catch {}
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      try { db.close(); } catch {}
      db = null;
    }
    closed = !reopenable;
  };
  return {
    getDb,
    checkpoint: () => { db?.exec("PRAGMA wal_checkpoint(PASSIVE)"); },
    closeForSwap: () => closeDatabase(true),
    reopen: () => { closed = false; getDb(); },
    close: () => closeDatabase(false),
  };
}

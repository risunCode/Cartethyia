/**
 * DB client — lazy bun:sqlite singleton. Nothing touches the filesystem until
 * the first console/tracking call, keeping proxy-only tests hermetic.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConsoleEnv } from "../env";
import { INIT_SQL } from "./schema";

let db: Database | null = null;

function ensureProxyRelayColumn(database: Database): void {
  const columns = new Set((database.query("PRAGMA table_info(proxies)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("is_relay")) database.exec("ALTER TABLE proxies ADD COLUMN is_relay INTEGER NOT NULL DEFAULT 0");
  database.exec("DROP INDEX IF EXISTS idx_proxies_single_relay");
}

function ensureProviderAccountQuotaColumns(database: Database): void {
  const columns = new Set((database.query("PRAGMA table_info(provider_account_health)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("quota_json")) database.exec("ALTER TABLE provider_account_health ADD COLUMN quota_json TEXT");
  if (!columns.has("quota_error")) database.exec("ALTER TABLE provider_account_health ADD COLUMN quota_error TEXT");
  if (!columns.has("quota_fetched_at")) database.exec("ALTER TABLE provider_account_health ADD COLUMN quota_fetched_at TEXT");
}

function ensureProviderRoutingColumns(database: Database): void {
  const columns = new Set((database.query("PRAGMA table_info(provider_routing)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("sticky_limit")) database.exec("ALTER TABLE provider_routing ADD COLUMN sticky_limit INTEGER NOT NULL DEFAULT 1");
  if (!columns.has("sticky_enabled")) database.exec("ALTER TABLE provider_routing ADD COLUMN sticky_enabled INTEGER NOT NULL DEFAULT 0");
}

function ensureSmartDynamicRoutingColumn(database: Database): void {
  const columns = new Set((database.query("PRAGMA table_info(proxy_settings)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("smart_dynamic_routing")) database.exec("ALTER TABLE proxy_settings ADD COLUMN smart_dynamic_routing INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("smart_dynamic_proxy_count")) database.exec("ALTER TABLE proxy_settings ADD COLUMN smart_dynamic_proxy_count INTEGER NOT NULL DEFAULT 2");
}

function ensureRetiredProviderModels(database: Database): void {
  database.query("DELETE FROM provider_models WHERE provider = ? AND model_id = ?").run("blackbox", "blackboxai/amazon/nova-micro");
}

function ensureApiKeyBudgetColumns(database: Database): void {
  const columns = new Set((database.query("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("one_time_token_limit")) database.exec("ALTER TABLE api_keys ADD COLUMN one_time_token_limit INTEGER");
  if (!columns.has("one_time_tokens_used")) database.exec("ALTER TABLE api_keys ADD COLUMN one_time_tokens_used INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("quote_big_text")) database.exec("ALTER TABLE api_keys ADD COLUMN quote_big_text TEXT");
  if (!columns.has("quote_sub_text")) database.exec("ALTER TABLE api_keys ADD COLUMN quote_sub_text TEXT");
  if (!columns.has("quote_body")) database.exec("ALTER TABLE api_keys ADD COLUMN quote_body TEXT");
}

export function getDb(): Database {
  if (!db) {
    const env = getConsoleEnv();
    mkdirSync(dirname(env.dbPath), { recursive: true });
    db = new Database(env.dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    // NORMAL skips an fsync on every commit (WAL still fsyncs at checkpoints),
    // trading a narrow OS-crash-only loss window for write throughput. Every
    // proxied request writes here at least once (touchApiKey), so the FULL
    // default (fsync per commit) was a hard ceiling well under 5k req/sec.
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(INIT_SQL);
    ensureProxyRelayColumn(db);
    ensureProviderAccountQuotaColumns(db);
    ensureProviderRoutingColumns(db);
    ensureSmartDynamicRoutingColumn(db);
    ensureRetiredProviderModels(db);
    ensureApiKeyBudgetColumns(db);
  }
  return db;
}

/** Test-only: close the current handle so the next getDb() re-opens at the (possibly re-pointed) env path. */
/** Flushes the current SQLite write-ahead log without blocking readers. */
export function checkpointDb(): void {
  db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

/** Flushes and closes the database handle during graceful process shutdown. */
export function closeDb(): void {
  if (!db) return;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  db = null;
}

export function closeDbForTests(): void {
  try {
    db?.close();
  } catch {
    // already closed — fine
  }
  db = null;
}

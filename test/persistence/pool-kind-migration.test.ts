/**
 * The `0012` pool-kind swap, run against the shape it was written for.
 *
 * A fresh database is built from a baseline that already carries the new CHECK,
 * so `applySqliteMigrations` lands on the final state and there is no `bridge`
 * row left to fold — the forward path can only be exercised against a database
 * at 0011. So this builds that shape by hand and runs the shipped file's own
 * statements through it, which is the thing that has to be right.
 *
 * Both properties were measured before they were asserted, against a scratch
 * database, because the naive ordering fails both silently:
 *
 * - `ALTER TABLE … RENAME TO` rewrites the REFERENCES clause of every table
 *   pointing at the renamed one, so `health_events` ends up naming the retired
 *   table and the foreign key dangles.
 * - `DROP TABLE` on a parent with `foreign_keys = ON` performs an implicit
 *   DELETE, and `health_events.network_pool_id` is `ON DELETE CASCADE`, so the
 *   drop deletes every pool's health history. Measured: 1 row before, 0 after.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const MIGRATION = resolve(import.meta.dir, "../../migrations/lite-sqlite3/0012_network_pool_https.sql");

/** The pre-0012 shape: the retired kind list, and the child that references it. */
const OLD_SCHEMA = `
CREATE TABLE network_pools (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  "endpoint_config" text NOT NULL,
  "credential_ciphertext" blob,
  "max_inflight" integer,
  "weight" integer,
  "tenant_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_success_at" text,
  "last_latency_ms" integer,
  "last_error" text,
  "last_error_category" text,
  "cooldown_until" text,
  "last_recovered_at" text,
  "model_cooldowns" text DEFAULT '{}' NOT NULL,
  "sort_index" integer DEFAULT 0 NOT NULL,
  "family" text,
  CONSTRAINT "network_pools_kind_enum_check" CHECK ("kind" IS NULL OR "kind" IN ('http', 'socks5', 'bridge'))
);
CREATE TABLE tenants ("id" text PRIMARY KEY NOT NULL, "name" text NOT NULL, "status" text NOT NULL);
-- The migration rebuilds health_events with its real account key, so the table
-- that key names has to exist.
CREATE TABLE provider_accounts ("id" text PRIMARY KEY NOT NULL);
CREATE TABLE health_events (
  "id" text PRIMARY KEY NOT NULL,
  "entity_kind" text NOT NULL,
  "account_id" text,
  "network_pool_id" text,
  "from_status" text,
  "to_status" text NOT NULL,
  "reason" text,
  "error_category" text,
  "model_id" text,
  "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  -- The pools key is the one under test; the account key and the enum checks
  -- this migration never touches are left out of the hand-built shape.
  CONSTRAINT "health_events_network_pool_id_network_pools_id_fk" FOREIGN KEY ("network_pool_id") REFERENCES "network_pools"("id") ON DELETE cascade
);
`;

/** Splits a migration file on its breakpoint marker. Mirrors the runner. */
function splitStatements(source: string): readonly string[] {
  return source.split(/^\s*-->\s*statement-breakpoint\s*$/m);
}

/** Drops `--` comments, so only SQL reaches `exec`. Mirrors the runner. */
function stripComments(statement: string): string {
  return statement.replace(/--[^\n]*/g, "").trim();
}

test("0012 folds bridge to https and keeps the pool health history", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(OLD_SCHEMA);
  db.exec(`INSERT INTO tenants (id, name, status) VALUES ('tenant-1', 'Default', 'active')`);
  db.exec(`INSERT INTO network_pools (id, kind, endpoint_config, tenant_id)
           VALUES ('pool-1', 'bridge', '{"endpoint":"relay.example.com"}', 'tenant-1')`);
  db.exec(`INSERT INTO network_pools (id, kind, endpoint_config, tenant_id)
           VALUES ('pool-2', 'socks5', '{"endpoint":"1.2.3.4:1080"}', 'tenant-1')`);
  db.exec(`INSERT INTO health_events (id, entity_kind, network_pool_id, to_status)
           VALUES ('event-1', 'pool', 'pool-1', 'active')`);

  // The shipped file, split and stripped the way `applySqliteMigrations` does
  // it, so this exercises the same bytes the runner would execute.
  for (const statement of splitStatements(readFileSync(MIGRATION, "utf8"))) {
    const sql = stripComments(statement);
    if (sql.length === 0) continue;
    db.exec(sql);
  }

  const kinds = db.query("SELECT id, kind FROM network_pools ORDER BY id").all() as Array<{ id: string; kind: string }>;
  expect(kinds).toEqual([
    { id: "pool-1", kind: "https" },
    { id: "pool-2", kind: "socks5" },
  ]);

  // The cascade the naive ordering triggers.
  const events = db.query("SELECT COUNT(*) AS c FROM health_events").get() as { c: number };
  expect(events.c).toBe(1);

  // The new kind is accepted, and the child's key resolves to the final name.
  db.exec(`INSERT INTO network_pools (id, kind, endpoint_config, tenant_id)
           VALUES ('pool-3', 'https', '{"endpoint":"relay.vercel.app"}', 'tenant-1')`);
  const fk = db.query("SELECT sql FROM sqlite_master WHERE name = 'health_events'").get() as { sql: string };
  expect(fk.sql).toContain('REFERENCES "network_pools"');
  expect(fk.sql).not.toContain("retired");
  db.close();
});

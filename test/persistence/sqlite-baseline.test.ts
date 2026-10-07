/**
 * The SQLite baseline is derived, not written.
 *
 * `migrations/lite-sqlite3/0000_baseline.sql` must be exactly what
 * `scripts/generate/sqlite-ddl.ts` produces from the PostgreSQL baseline, and
 * the result must build a database whose constraints do the job the PostgreSQL
 * types were doing: enums, booleans, foreign keys, the partial unique index
 * that keeps one live default key per tenant, and cascading deletes.
 *
 * A schema change that is not regenerated fails the first assertion. A rewrite
 * that produces SQL SQLite rejects, or that drops a constraint, fails the rest.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSqliteBaseline } from "../../scripts/generate/sqlite-ddl";

const committed = readFileSync(resolve(process.cwd(), "migrations", "lite-sqlite3", "0000_baseline.sql"), "utf8");

function migratedDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const part of committed.split(/--> statement-breakpoint/g)) {
    const statement = part.trim();
    if (statement.length === 0 || statement.startsWith("--")) continue;
    db.exec(statement);
  }
  return db;
}

test("the committed SQLite baseline matches the generator output", () => {
  const source = readFileSync(resolve(process.cwd(), "migrations", "full-postgres", "0000_baseline.sql"), "utf8");
  expect(committed).toBe(deriveSqliteBaseline(source));
});

test("the derived baseline builds and enforces the PostgreSQL constraints", () => {
  const db = migratedDatabase();
  const tables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number };
  expect(tables.c).toBe(26);

  db.exec("INSERT INTO tenants (id, name, status) VALUES ('t1', 'A', 'active')");
  expect(() => db.exec("INSERT INTO tenants (id, name, status) VALUES ('t2', 'A', 'nope')")).toThrow();

  db.exec("INSERT INTO providers (id, enabled) VALUES ('openai', 1)");
  expect(() => db.exec("INSERT INTO providers (id, enabled) VALUES ('x', 2)")).toThrow();
  expect(() => db.exec("INSERT INTO providers (id, wire_family_default) VALUES ('y', 'grpc')")).toThrow();
  db.exec("INSERT INTO providers (id, wire_family_default) VALUES ('z', 'chat')");

  const key = (id: string, extra = ""): string =>
    `INSERT INTO api_keys (id, tenant_id, label, scopes, key_mode, key_hash${extra ? ", is_default" : ""}) ` +
    `VALUES ('${id}', 't1', 'L', '[]', 'personal', 'h-${id}'${extra})`;
  expect(() => db.exec(key("missing-tenant").replace("'t1'", "'no-such-tenant'"))).toThrow();
  db.exec(key("k1"));
  // A personal key without a hash violates the mode-shape check.
  expect(() =>
    db.exec("INSERT INTO api_keys (id, tenant_id, label, scopes, key_mode) VALUES ('k2', 't1', 'L', '[]', 'personal')"),
  ).toThrow();

  db.exec(key("k3", ", 1"));
  // One live default key per tenant: the partial unique index rejects a second.
  expect(() => db.exec(key("k4", ", 1"))).toThrow();

  db.exec("DELETE FROM tenants WHERE id = 't1'");
  const remaining = db.prepare("SELECT count(*) AS c FROM api_keys").get() as { c: number };
  expect(remaining.c).toBe(0);

  const stamped = db.prepare("SELECT created_at FROM tenants WHERE id = 'z' OR status = 'active'").all();
  expect(stamped).toHaveLength(0);
  db.exec("INSERT INTO tenants (id, name, status) VALUES ('t3', 'B', 'active')");
  const created = db.prepare("SELECT created_at FROM tenants WHERE id = 't3'").get() as { created_at: string };
  expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

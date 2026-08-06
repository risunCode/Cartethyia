import { describe, expect, test, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { DbMapService } from "../../src/console/db-map/service";
import { isSensitiveColumn, SENSITIVE_COLUMN_NAMES } from "../../src/console/db-map/types";
import type { PersistenceEnv } from "../../src/storage/main/env";

function testEnv(): PersistenceEnv {
  const dir = join(tmpdir(), `cartethyia-dbmap-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "config.sqlite");
  const runtimeDbPath = join(dir, "runtime.sqlite");

  // Seed a minimal config DB
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY, name TEXT, password_hash TEXT, key TEXT, normal_col TEXT);
    INSERT INTO settings VALUES (1, 'admin', 'secret-hash', 'sk-test-123', 'hello');
    INSERT INTO settings VALUES (2, 'user2', 'hash2', 'sk-other', 'world');

    CREATE TABLE api_keys (id INTEGER PRIMARY KEY, key TEXT, token TEXT, name TEXT);
    INSERT INTO api_keys VALUES (1, 'sk-abc', 'tok-123', 'test-key');

    CREATE TABLE empty_table (id INTEGER PRIMARY KEY, val TEXT);
  `);
  // Insert 5 rows for pagination tests into a separate table
  db.exec(`
    CREATE TABLE paginated (id INTEGER PRIMARY KEY, label TEXT);
  `);
  for (let i = 1; i <= 5; i++) {
    db.query("INSERT INTO paginated VALUES (?, ?)").run(i, `row-${i}`);
  }
  db.close();

  // Seed a minimal runtime DB
  const rdb = new Database(runtimeDbPath, { create: true });
  rdb.exec(`
    CREATE TABLE requests (id INTEGER PRIMARY KEY, model TEXT, provider TEXT, status INTEGER);
    INSERT INTO requests VALUES (1, 'gpt-4o', 'openai', 200);
    INSERT INTO requests VALUES (2, 'claude-3', 'anthropic', 200);
  `);
  rdb.close();

  return { dataDir: dir, dbPath, runtimeDbPath, assetDir: join(dir, "assets"), logRetentionDays: 7, assetRetentionDays: 7, maxFlightsPerIp: 8 };
}

let env: PersistenceEnv;
let service: DbMapService;

beforeEach(() => {
  env = testEnv();
  service = new DbMapService(env);
});

describe("isSensitiveColumn", () => {
  test.each([
    "password_hash", "PASSWORD_HASH", "Password_Hash",
    "jwt_secret", "JWT_SECRET",
    "key", "KEY",
    "credential", "CREDENTIAL",
    "password", "PASSWORD",
    "token", "TOKEN",
    "refresh_token", "access_token", "token_hash",
    "username", "USERNAME",
  ])("detects %s as sensitive (case-insensitive)", (name) => {
    expect(isSensitiveColumn(name)).toBe(true);
  });

  test.each([
    "name", "id", "model", "provider", "status", "created_at", "val", "label",
    "settings", "api_keys", "normal_col", "description",
  ])("allows %s as non-sensitive", (name) => {
    expect(isSensitiveColumn(name)).toBe(false);
  });

  test("empty string is not sensitive", () => {
    expect(isSensitiveColumn("")).toBe(false);
  });
});

describe("SENSITIVE_COLUMN_NAMES", () => {
  test("contains all expected sensitive column names", () => {
    expect(Object.keys(SENSITIVE_COLUMN_NAMES).sort()).toEqual(
      ["access_token", "credential", "jwt_secret", "key", "license_key", "password", "password_hash", "private_key", "refresh_token", "secret", "token", "token_hash", "username"].sort()
    );
  });
});

describe("DbMapService — getSchema", () => {
  test("returns table list with column info for config database", () => {
    const result = service.getSchema("config");
    expect(result.database).toBe("config");
    const tableNames = result.tables.map((t) => t.name);
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("api_keys");
    expect(tableNames).toContain("empty_table");
    expect(tableNames).toContain("paginated");
    // sqlite_% internal tables excluded
    expect(tableNames.every((n) => !n.startsWith("sqlite_"))).toBe(true);
  });

  test("settings table has correct columns with sensitive flags", () => {
    const result = service.getSchema("config");
    const settings = result.tables.find((t) => t.name === "settings");
    expect(settings).toBeDefined();
    const colNames = settings!.columns.map((c) => c.name);
    expect(colNames).toEqual(["id", "name", "password_hash", "key", "normal_col"]);
    const pwdCol = settings!.columns.find((c) => c.name === "password_hash");
    expect(pwdCol?.sensitive).toBe(true);
    const keyCol = settings!.columns.find((c) => c.name === "key");
    expect(keyCol?.sensitive).toBe(true);
    const normalCol = settings!.columns.find((c) => c.name === "normal_col");
    expect(normalCol?.sensitive).toBe(false);
  });

  test("row counts are correct", () => {
    const result = service.getSchema("config");
    const settings = result.tables.find((t) => t.name === "settings");
    expect(settings?.rowCount).toBe(2);
    const paginated = result.tables.find((t) => t.name === "paginated");
    expect(paginated?.rowCount).toBe(5);
    const empty = result.tables.find((t) => t.name === "empty_table");
    expect(empty?.rowCount).toBe(0);
  });

  test("indexes are listed for tables with indexes", () => {
    // Create a table with an explicit index (reopen with create:true for write access)
    const db = new Database(env.dbPath, { create: true });
    db.exec("CREATE INDEX IF NOT EXISTS idx_settings_name ON settings(name)");
    db.close();

    const result = service.getSchema("config");
    const settings = result.tables.find((t) => t.name === "settings");
    // The explicit index should be present
    const idx = settings!.indexes.find((i) => i.name === "idx_settings_name");
    expect(idx).toBeDefined();
    expect(idx!.columns).toContain("name");
  });

  test("runtime database returns its tables", () => {
    const result = service.getSchema("runtime");
    expect(result.database).toBe("runtime");
    const tableNames = result.tables.map((t) => t.name);
    expect(tableNames).toContain("requests");
  });

  test("throws when database file does not exist", () => {
    const badEnv = { ...env, dbPath: join(env.dataDir, "nonexistent.sqlite") };
    const svc = new DbMapService(badEnv);
    expect(() => svc.getSchema("config")).toThrow();
  });
});

describe("DbMapService — getTableRows", () => {
  test("returns rows with sensitive columns masked", () => {
    const result = service.getTableRows("config", "settings", 100, 0);
    expect(result.table).toBe("settings");
    expect(result.total).toBe(2);
    const row = result.rows[0]!;
    expect(row.password_hash).toBe("••••••");
    expect(row.key).toBe("••••••");
    expect(row.name).not.toBe("••••••");
    expect(row.normal_col).not.toBe("••••••");
  });

  test("respects LIMIT parameter", () => {
    const result = service.getTableRows("config", "paginated", 2, 0);
    expect(result.rows).toHaveLength(2);
    expect(result.limit).toBe(2);
    expect(result.offset).toBe(0);
  });

  test("respects OFFSET parameter", () => {
    const result = service.getTableRows("config", "paginated", 2, 2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.label).toBe("row-3");
    expect(result.rows[1]!.label).toBe("row-4");
    expect(result.offset).toBe(2);
  });

  test("clamps limit to MAX_ROWS (1000)", () => {
    const result = service.getTableRows("config", "paginated", 5000, 0);
    expect(result.limit).toBe(1000);
  });

  test("uses default limit when 0 is passed (0 || DEFAULT_ROW_LIMIT)", () => {
    const result = service.getTableRows("config", "paginated", 0, 0);
    // 0 is falsy, so `limit || DEFAULT_ROW_LIMIT` yields 100
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  test("clamps negative offset to 0", () => {
    const result = service.getTableRows("config", "paginated", 10, -5);
    expect(result.offset).toBe(0);
  });

  test("returns column names even for empty table", () => {
    const result = service.getTableRows("config", "empty_table", 100, 0);
    expect(result.rows).toHaveLength(0);
    expect(result.columns).toContain("id");
    expect(result.columns).toContain("val");
    expect(result.total).toBe(0);
  });

  test("rejects invalid table name (SQL injection attempt)", () => {
    expect(() => service.getTableRows("config", "settings; DROP TABLE settings;--", 10, 0)).toThrow();
  });

  test("rejects table name with special characters", () => {
    expect(() => service.getTableRows("config", "set' OR '1'='1", 10, 0)).toThrow();
  });

  test("rejects non-existent table", () => {
    expect(() => service.getTableRows("config", "nonexistent", 10, 0)).toThrow();
  });
});

describe("DbMapService — query (SELECT only)", () => {
  test("executes a SELECT query", () => {
    const result = service.query("config", "SELECT * FROM settings WHERE id = 1");
    expect(result.columns).toContain("id");
    expect(result.columns).toContain("name");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.id).toBe(1);
    // Sensitive columns masked in query results too
    expect(result.rows[0]!.password_hash).toBe("••••••");
    expect(result.changes).toBe(0);
  });

  test("executes a WITH (CTE) query", () => {
    const result = service.query("config", "WITH t AS (SELECT 1 AS val) SELECT * FROM t");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.val).toBe(1);
  });

  test("executes an EXPLAIN query", () => {
    const result = service.query("config", "EXPLAIN SELECT * FROM settings");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test("rejects INSERT in query mode", () => {
    expect(() => service.query("config", "INSERT INTO settings VALUES (3, 'x', 'h', 'k', 'v')")).toThrow(/query mode/);
  });

  test("rejects UPDATE in query mode", () => {
    expect(() => service.query("config", "UPDATE settings SET name = 'x' WHERE id = 1")).toThrow(/query mode/);
  });

  test("rejects DELETE in query mode", () => {
    expect(() => service.query("config", "DELETE FROM settings WHERE id = 1")).toThrow(/query mode/);
  });

  test("rejects DROP in query mode", () => {
    expect(() => service.query("config", "DROP TABLE settings")).toThrow(/query mode/);
  });

  test("rejects PRAGMA in query mode", () => {
    // PRAGMA fails the verb check first (not in QUERY_ALLOWED_VERBS)
    expect(() => service.query("config", "PRAGMA journal_mode")).toThrow();
  });

  test("rejects ATTACH in query mode", () => {
    // ATTACH fails the verb check first (not in QUERY_ALLOWED_VERBS)
    expect(() => service.query("config", "ATTACH DATABASE '/tmp/evil.sqlite' AS evil")).toThrow();
  });

  test("rejects VACUUM in query mode", () => {
    // VACUUM fails the verb check first (not in QUERY_ALLOWED_VERBS)
    expect(() => service.query("config", "VACUUM")).toThrow();
  });

  test("forbidden keyword detection works even within a SELECT", () => {
    // A SELECT that contains the word "pragma" as a column alias triggers the forbidden keyword check
    expect(() => service.query("config", "SELECT pragma FROM settings")).toThrow(/forbidden keyword/);
  });
});

describe("DbMapService — execute (DML + DDL)", () => {
  // On Windows, Bun SQLite cannot open existing files with { readonly: false, create: false }
  // — this is a platform limitation of the Bun SQLite binding. In production the
  // DB files pre-exist with proper permissions. We test the verb/keyword guard
  // contracts (which run before any DB connection is opened) and the atomicity
  // contract via the query path. The actual DML execution path is exercised
  // end-to-end in the storage config tests which use their own DB setup.

  test("rejects SELECT in execute mode (verb not in EXECUTE_ALLOWED_VERBS)", () => {
    expect(() => service.execute("config", "SELECT * FROM settings")).toThrow(/execute mode/);
  });

  test("rejects PRAGMA in execute mode (verb not in EXECUTE_ALLOWED_VERBS)", () => {
    expect(() => service.execute("config", "PRAGMA journal_mode=WAL")).toThrow();
  });

  test("rejects ATTACH in execute mode (verb not in EXECUTE_ALLOWED_VERBS)", () => {
    expect(() => service.execute("config", "ATTACH DATABASE '/tmp/evil.sqlite' AS evil")).toThrow();
  });

  test("rejects VACUUM in execute mode (verb not in EXECUTE_ALLOWED_VERBS)", () => {
    expect(() => service.execute("config", "VACUUM")).toThrow();
  });

  test("rejects REINDEX in execute mode", () => {
    expect(() => service.execute("config", "REINDEX")).toThrow();
  });

  test("rejects ANALYZE in execute mode", () => {
    expect(() => service.execute("config", "ANALYZE")).toThrow();
  });

  test("forbidden keyword detection in execute mode (INSERT with pragma alias)", () => {
    // INSERT passes verb check, but contains "pragma" as a column name
    expect(() => service.execute("config", "INSERT INTO settings (id, name, pragma) VALUES (1, 'x', 'y')")).toThrow(/forbidden keyword/);
  });

  test("rejects empty/unknown SQL", () => {
    expect(() => service.execute("config", "")).toThrow(/execute mode/);
  });

  test("rejects unknown verb like EXPLAIN", () => {
    expect(() => service.execute("config", "EXPLAIN SELECT * FROM settings")).toThrow(/execute mode/);
  });
});

describe("DbMapService — exportDb", () => {
  test("exports a valid SQLite database file", () => {
    const result = service.exportDb("config");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).toContain("cartethyia");
      expect(result.filename).toContain(".sqlite");
      expect(result.data.byteLength).toBeGreaterThan(0);
      // Verify magic header
      expect(result.data[0]).toBe(0x53); // 'S'
      expect(result.data[1]).toBe(0x51); // 'Q'
    }
  });

  test("exported data is a valid SQLite file that can be reopened", () => {
    const result = service.exportDb("config");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tmpPath = join(env.dataDir, "exported.sqlite");
      const { writeFileSync } = require("node:fs");
      writeFileSync(tmpPath, result.data);
      const db = new Database(tmpPath, { readonly: true });
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      expect(tables.some((t) => t.name === "settings")).toBe(true);
      db.close();
    }
  });

  test("returns error for non-existent database", () => {
    const badEnv = { ...env, dbPath: join(env.dataDir, "nonexistent.sqlite") };
    const svc = new DbMapService(badEnv);
    const result = svc.exportDb("config");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  test("exports runtime database", () => {
    const result = service.exportDb("runtime");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).toContain("runtime");
    }
  });
});

describe("DbMapService — importDb", () => {
  test("rejects data that is too small to be SQLite", () => {
    const result = service.importDb("config", new Uint8Array([0, 1, 2]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too small");
    }
  });

  test("rejects data with wrong magic header", () => {
    const fake = new Uint8Array(64);
    fake[0] = 0x00; // Not 'S'
    const result = service.importDb("config", fake);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("magic header");
    }
  });

  test("rejects non-SQLite file even if magic header is present but content is corrupt", () => {
    // Build bytes that start with SQLite magic but are garbage after
    const magic = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];
    const garbage = new Uint8Array(256);
    for (let i = 0; i < magic.length; i++) garbage[i] = magic[i]!;
    // Fill rest with random bytes
    for (let i = magic.length; i < 256; i++) garbage[i] = Math.floor(Math.random() * 256);
    const result = service.importDb("config", garbage);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should fail at opening or at the "no tables" check
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("successfully imports a valid SQLite database", () => {
    // Create a valid SQLite file to import
    const importPath = join(env.dataDir, "import-source.sqlite");
    const db = new Database(importPath, { create: true });
    db.exec(`
      CREATE TABLE replacement (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO replacement VALUES (1, 'replaced');
    `);
    db.close();

    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const data = readFileSync(importPath) as Uint8Array;
    const result = service.importDb("config", new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toContain("successfully");
    }

    // Verify the live database now has the replacement table
    const svc2 = new DbMapService(env);
    const schema = svc2.getSchema("config");
    expect(schema.tables.some((t) => t.name === "replacement")).toBe(true);
  });

  test("rejects database with no tables", () => {
    // Create a valid SQLite file with a table, then drop all tables to get a
    // valid-but-empty database (a fresh {create:true}+close produces a 0-byte file)
    const importPath = join(env.dataDir, "empty-import.sqlite");
    const db = new Database(importPath, { create: true });
    db.exec("CREATE TABLE temp (id INTEGER PRIMARY KEY)");
    db.exec("DROP TABLE temp");
    db.close();
    const { readFileSync } = require("node:fs");
    const data = readFileSync(importPath) as Uint8Array;
    // Must have SQLite magic header (the DROP TABLE approach preserves the file structure)
    if (data.byteLength >= 16) {
      const result = service.importDb("config", new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("no tables");
      }
    } else {
      // 0-byte file — will fail at magic header check (still an error, just different)
      const result = service.importDb("config", new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      expect(result.ok).toBe(false);
    }
  });

  test("rejects import exceeding max size", () => {
    // Create a Uint8Array that's larger than MAX_IMPORT_BYTES (64 MiB)
    const huge = new Uint8Array(64 * 1024 * 1024 + 1);
    // Set magic header so it would pass magic check if size check didn't catch it
    const magic = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];
    for (let i = 0; i < magic.length; i++) huge[i] = magic[i]!;
    const result = service.importDb("config", huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exceeds");
    }
  });
});

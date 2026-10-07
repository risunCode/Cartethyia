/**
 * Derives the SQLite baseline from the canonical Drizzle schema.
 *
 * `src/persistence/schema.ts` is the only hand-written description of the
 * tables. PostgreSQL gets it directly; SQLite cannot, because the builders are
 * `pg-core`. Rather than keep a second hand-written schema that would drift,
 * this reads the PostgreSQL baseline — itself generated from that schema — and
 * rewrites each construct into the SQLite dialect:
 *
 *   enum type            → text column, values enforced by the check the
 *                          baseline already carries (or one synthesized here)
 *   jsonb                → text
 *   uuid                 → text
 *   bytea                → blob
 *   timestamptz          → text, `now()` → `strftime` in UTC
 *   boolean              → integer with a 0/1 check
 *   gen_random_uuid()    → dropped; the application supplies every id
 *   public. qualification, ::uuid/::jsonb casts, octet_length → length
 *
 * The output is deterministic and checked in, so a schema change fails the
 * parity test until this is re-run. It never edits a shipped forward
 * migration: SQLite has no older database to converge, so the baseline is the
 * whole set.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..", "..");
const baselinePath = resolve(projectRoot, "migrations", "full-postgres", "0000_baseline.sql");
const outputPath = resolve(projectRoot, "migrations", "lite-sqlite3", "0000_baseline.sql");

/** Enum name → the values it admits, read from the baseline's CREATE TYPE. */
function readEnums(source: string): Map<string, readonly string[]> {
  const enums = new Map<string, readonly string[]>();
  const pattern = /CREATE TYPE "public"\."(\w+)" AS ENUM\(([^)]*)\)/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    if (!name || body === undefined) continue;
    enums.set(name, [...body.matchAll(/'([^']*)'/g)].map((value) => value[1] ?? ""));
  }
  return enums;
}

/**
 * Splits a CREATE TABLE body into its top-level items.
 *
 * A comma inside a CHECK expression is not a separator, so this walks the
 * text and only splits at depth zero. Parentheses are the only nesting the
 * baseline uses.
 */
function splitTableItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Rewrites one CREATE TABLE statement into the SQLite dialect. */
function rewriteCreateTable(statement: string, enums: ReadonlyMap<string, readonly string[]>): string {
  const header = statement.split("\n")[0] ?? "";
  const tableName = /^CREATE TABLE "(\w+)"/.exec(header)?.[1];
  if (!tableName) throw new Error(`Unrecognised CREATE TABLE: ${header}`);
  const open = statement.indexOf("(");
  const close = statement.lastIndexOf(")");
  if (open < 0 || close < 0) throw new Error(`CREATE TABLE without a body: ${tableName}`);

  const rewritten: string[] = [`CREATE TABLE "${tableName}" (`];
  const enumChecks: string[] = [];

  for (const item of splitTableItems(statement.slice(open + 1, close))) {
    const flat = item.replace(/\s+/g, " ");
    if (flat.startsWith("CONSTRAINT") && flat.includes("FOREIGN KEY")) {
      rewritten.push(`  ${rewriteForeignKey(flat)},`);
      continue;
    }
    if (flat.startsWith("CONSTRAINT") && flat.includes("PRIMARY KEY")) {
      rewritten.push(`  ${rewriteCompositePrimaryKey(flat)},`);
      continue;
    }
    if (flat.startsWith("CONSTRAINT") && flat.includes("CHECK")) {
      rewritten.push(`  ${rewriteCheck(flat)},`);
      continue;
    }
    const column = rewriteColumn(flat, tableName, enums);
    rewritten.push(`  ${column.sql},`);
    if (column.enumCheck) enumChecks.push(`  CONSTRAINT "${column.enumCheck.name}" CHECK (${column.enumCheck.expr}),`);
  }

  // Enum checks go with the columns they guard. SQLite enforces a CHECK on
  // every write, which is what the PostgreSQL enum type was doing.
  const closing = rewritten.pop() ?? "";
  for (const check of enumChecks) rewritten.push(check);
  rewritten.push(closing.replace(/,$/, ""));
  rewritten.push(");");
  return rewritten.join("\n");
}

interface RewrittenColumn {
  sql: string;
  enumCheck?: { name: string; expr: string };
}

function rewriteColumn(
  definition: string,
  tableName: string,
  enums: ReadonlyMap<string, readonly string[]>,
): RewrittenColumn {
  const match = /^"(\w+)"\s+(.*)$/.exec(definition);
  if (!match) throw new Error(`Unrecognised column in ${tableName}: ${definition}`);
  const name = match[1] ?? "";
  let rest = match[2] ?? "";

  const enumType = /^"(\w+)"(.*)$/.exec(rest);
  const enumValues = enumType ? enums.get(enumType[1] ?? "") : undefined;
  if (enumType && enumValues) {
    rest = `text${enumType[2] ?? ""}`;
  }

  rest = rest
    .replace(/\buuid\b/g, "text")
    .replace(/\bjsonb\b/g, "text")
    .replace(/\bbytea\b/g, "blob")
    .replace(/\btimestamptz\b/g, "text")
    .replace(/\bboolean\b/g, "integer")
    .replace(/DEFAULT gen_random_uuid\(\)/gi, "")
    .replace(/DEFAULT now\(\)/gi, "DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .replace(/DEFAULT '\{\}'::jsonb/g, "DEFAULT '{}'")
    .replace(/::jsonb/g, "")
    .replace(/::uuid/g, "")
    .replace(/::text/g, "")
    .replace(/\boctet_length\(/g, "length(")
    .replace(/ +/g, " ")
    .trim();

  const result: RewrittenColumn = { sql: `"${name}" ${rest}` };
  if (enumValues) {
    const list = enumValues.map((value) => `'${value}'`).join(", ");
    result.enumCheck = {
      name: `${tableName}_${name}_enum_check`,
      expr: `"${name}" IS NULL OR "${name}" IN (${list})`,
    };
  }
  // A boolean column that arrived as `integer` still needs its 0/1 domain,
  // or any integer would store. The check is appended to the column so it
  // cannot be separated from the declaration it guards.
  if (/\binteger\b/.test(rest) && /\bboolean\b/.test(definition)) {
    result.sql += ` CHECK ("${name}" IN (0, 1))`;
  }
  return result;
}

function rewriteForeignKey(definition: string): string {
  return definition
    .replace(/"public"\./g, "")
    .replace(/\buuid\b/g, "text");
}

function rewriteCompositePrimaryKey(definition: string): string {
  return definition.replace(/\buuid\b/g, "text");
}

function rewriteCheck(definition: string): string {
  return definition
    .replace(/::uuid/g, "")
    .replace(/::jsonb/g, "")
    .replace(/::text/g, "")
    .replace(/\boctet_length\(/g, "length(")
    .replace(/"public"\./g, "");
}

/**
 * Rewrites one CREATE INDEX statement.
 *
 * `USING btree` is PostgreSQL's access-method clause and has no SQLite
 * equivalent — SQLite has one index implementation. `DESC` inside an index
 * column list is likewise rejected, and unnecessary: SQLite scans an index in
 * either direction.
 */
function rewriteIndex(statement: string): string {
  return statement
    .replace(/ USING btree/g, "")
    .replace(/ DESC/g, "")
    .replace(/"public"\./g, "")
    .replace(/::uuid/g, "")
    .replace(/::text/g, "")
    .replace(/::jsonb/g, "");
}

/** The whole baseline, rewritten. Statements the SQLite path cannot use are dropped with a reason. */
export function deriveSqliteBaseline(source: string): string {
  const enums = readEnums(source);
  const statements = source
    .split(/--> statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // The header is its own statement, terminated by a breakpoint. Folding it
  // into the first CREATE TABLE would make that statement start with a
  // comment line, which the runner skips and so never creates the table.
  const out: string[] = [
    "-- Generated by scripts/generate/sqlite-ddl.ts from migrations/full-postgres/0000_baseline.sql.",
    "-- Do not edit by hand: change src/persistence/schema.ts, regenerate the",
    "-- PostgreSQL baseline, then re-run `bun scripts/generate/sqlite-ddl.ts`.",
    "--> statement-breakpoint",
    "",
  ];

  for (const statement of statements) {
    if (statement.startsWith("CREATE EXTENSION")) continue;
    if (statement.startsWith("CREATE TYPE")) continue;
    if (statement.startsWith("CREATE TABLE")) {
      out.push(rewriteCreateTable(statement, enums));
    } else if (statement.startsWith("CREATE INDEX") || statement.startsWith("CREATE UNIQUE INDEX")) {
      out.push(rewriteIndex(statement));
    } else {
      throw new Error(`No SQLite rewrite for: ${statement.slice(0, 60)}`);
    }
    out.push("--> statement-breakpoint");
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

if (import.meta.main) {
  const source = readFileSync(baselinePath, "utf8");
  writeFileSync(outputPath, deriveSqliteBaseline(source), "utf8");
  console.log(`Wrote ${outputPath}`);
}
